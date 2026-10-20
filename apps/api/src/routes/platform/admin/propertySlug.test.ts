import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../../app.js";
import {
  PropertySlugChangeError,
  type PropertySlugChangeCommand,
  type PropertySlugChangeErrorCode,
  type PropertySlugChangePreview,
} from "../../../domains/propertySlugChange.js";
import { agencyPropertyAccessRepository } from "../../../testAuthorization.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const planSha256 = "a".repeat(64);
const session: VerifiedSession = {
  workosUserId: "workos-platform-user",
  workosOrgId: "workos-platform-org",
  sessionId: "platform-session",
  expiresAt: Math.floor(Date.now() / 1_000) + 60,
};
const preview: PropertySlugChangePreview = {
  plan: {
    contractVersion: "platform-admin-property-slug-change.v1",
    propertyId,
    fromSlug: "test-only-alpenrose",
    toSlug: "alpenrose",
    change: "new_address",
    livePage: null,
  },
  planSha256,
};

describe("platform property address routes (VAY-2295)", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  afterEach(async () => app?.close());

  const post = (path: string, payload: unknown) =>
    injectJson(app!, {
      method: "POST",
      url: `/api/platform/admin/properties/${propertyId}/${path}`,
      headers: { authorization: "Bearer platform-token" },
      payload,
    });

  it("needs the property status permission and the Vayada operator resource", async () => {
    const target = harness();
    app = build(target, { permissions: ["platform.admin.read"] });
    expect((await post("slug/preview", { slug: "alpenrose" })).statusCode).toBe(403);
    await app.close();
    app = build(target, { resourceAccess: false });
    expect((await post("slug/preview", { slug: "alpenrose" })).statusCode).toBe(403);
    expect(target.calls).toEqual([]);
  });

  it("previews, then applies only the approved plan with a reason", async () => {
    const target = harness();
    app = build(target);
    const previewed = await post("slug/preview", { slug: "alpenrose" });
    expect(previewed.statusCode).toBe(200);
    expect(previewed.body).toEqual(preview);
    expect(target.calls[0]).toMatchObject({
      method: "preview",
      propertyId,
      slug: "alpenrose",
      audit: { actorUserId: "platform-user", organizationId: "platform-org" },
    });

    for (const payload of [
      { slug: "alpenrose", expectedPlanSha256: planSha256 },
      { slug: "alpenrose", reason: " ", expectedPlanSha256: planSha256 },
      { slug: "alpenrose", reason: "Drop the prefix", expectedPlanSha256: "A".repeat(64) },
      { slug: 7, reason: "Drop the prefix", expectedPlanSha256: planSha256 },
    ])
      expect((await post("slug", payload)).statusCode).toBe(400);
    expect(target.calls).toHaveLength(1);

    const applied = await post("slug", {
      slug: "alpenrose",
      reason: " Drop the prefix ",
      expectedPlanSha256: planSha256,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.body).toEqual({ ...preview, publication: { status: "not_live" } });
    expect(target.calls[1]).toMatchObject({
      method: "apply",
      reason: "Drop the prefix",
      expectedPlanSha256: planSha256,
    });
  });

  it("answers refusals with their code", async () => {
    for (const [code, statusCode] of [
      ["invalid_slug", 400],
      ["invalid_platform_scope", 403],
      ["property_not_found", 404],
      ["slug_taken", 409],
      ["plan_changed", 409],
    ] as const) {
      app = build(harness(code));
      const response = await post("slug/preview", { slug: "alpenrose" });
      expect(response.statusCode, code).toBe(statusCode);
      expect(response.body).toEqual({ code });
      await app.close();
      app = undefined;
    }
  });
});

function harness(refusal?: PropertySlugChangeErrorCode) {
  const calls: Array<Record<string, unknown>> = [];
  const command: PropertySlugChangeCommand = {
    async preview(input) {
      calls.push({ method: "preview", ...input });
      if (refusal) throw new PropertySlugChangeError(refusal);
      return preview;
    },
    async apply(input) {
      calls.push({ method: "apply", ...input });
      return { ...preview, publication: { status: "not_live" } };
    },
    async close() {},
  };
  return { calls, command };
}

function build(
  target: ReturnType<typeof harness>,
  options: { permissions?: PermissionKey[]; resourceAccess?: boolean } = {},
) {
  return buildApp({
    logger: false,
    platformPropertySlug: { command: target.command },
    auth: {
      verifier: createFakeVerifier(new Map([["platform-token", session]])),
      repository: identityRepository(options.resourceAccess !== false),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["platform.admin.read", "platform.property.status.manage"];
        },
      },
    },
  });
}

function identityRepository(resourceAccess: boolean): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return { userId: "platform-user", email: "admin@vayada.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "platform-org",
        workosOrgId: "workos-platform-org",
        kind: "platform",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "platform-membership",
        status: "active",
        roleKey: "platform_admin",
        workosMembershipId: "workos-platform-membership",
        workosRoleSlugs: ["platform_admin"],
      };
    },
    async findLinkedResources() {
      return resourceAccess
        ? [
            {
              product: "platform",
              resourceType: "platform",
              resourceId: "vayada",
              relationship: "operator",
              status: "active",
            },
          ]
        : [];
    },
  };
}
