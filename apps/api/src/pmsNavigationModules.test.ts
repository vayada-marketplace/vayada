import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ResourceRelationship,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type {
  PmsNavigationModule,
  PmsNavigationModuleRepository,
  PmsNavigationModulesResponse,
} from "./routes/pmsNavigationModules.js";

const propertyId = "20780000-0000-4000-8000-000000000001";
const organizationId = "11111111-1111-1111-1111-111111111111";
const actorUserId = "22222222-2222-2222-2222-222222222222";
const url = `/api/pms/properties/${propertyId}/navigation-modules`;
const headers = { authorization: "Bearer valid-token" };
const now = "2026-10-09T08:00:00.000Z";

function createRepository(initial: PmsNavigationModule[] = []) {
  const rows = new Map(initial.map((row) => [row.moduleId, row]));
  const updates: Array<{ propertyId: string; moduleId: string; isActive: boolean }> = [];
  const repository: PmsNavigationModuleRepository & { updates: typeof updates; fail?: boolean } = {
    updates,
    async list() {
      if (repository.fail) throw new Error("database unavailable");
      return Array.from(rows.values());
    },
    async update({ propertyId: id, moduleId, isActive, audit }) {
      if (repository.fail) throw new Error("database unavailable");
      expect(audit).toMatchObject({ actorUserId, organizationId });
      updates.push({ propertyId: id, moduleId, isActive });
      const row = {
        moduleId,
        isActive,
        activatedAt: isActive ? now : (rows.get(moduleId)?.activatedAt ?? null),
        deactivatedAt: isActive ? null : now,
        updatedAt: now,
      };
      rows.set(moduleId, row);
      return row;
    },
  };
  return repository;
}

function buildAuthenticatedApp(
  options: {
    repository?: PmsNavigationModuleRepository;
    permissions?: PermissionKey[];
    relationship?: ResourceRelationship;
    allowedOrigins?: string[];
  } = {},
) {
  const identityRepository: IdentityRepository = {
    async findUserByProviderUserId() {
      return { userId: actorUserId, email: "owner@example.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return { organizationId, workosOrgId: "workos-org-1", kind: "hotel_group", status: "active" };
    },
    async findActiveMembership() {
      return {
        membershipId: "33333333-3333-3333-3333-333333333333",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "workos-membership-1",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      const relationship = options.relationship ?? "operator";
      return [
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
          relationship,
          status: "active",
        },
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          relationship,
          status: "active",
        },
      ];
    },
  };
  return buildApp({
    logger: false,
    pmsNavigationModuleRepository: options.repository ?? createRepository(),
    pmsOperationsAllowedOrigins: options.allowedOrigins,
    auth: {
      verifier: createFakeVerifier(
        new Map([
          [
            "valid-token",
            {
              workosUserId: "workos-user-1",
              workosOrgId: "workos-org-1",
              sessionId: "session-1",
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
        ]),
      ),
      repository: identityRepository,
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["pms.operations.read", "pms.operations.manage"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return [
            {
              product: "pms",
              key: "property-management",
              status: "active",
              resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
            },
          ];
        },
      },
    },
  });
}

describe("PMS navigation module routes", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("lists both modules with the stored switches for an operator who can manage them", async () => {
    app = buildAuthenticatedApp({
      repository: createRepository([
        {
          moduleId: "inbox",
          isActive: true,
          activatedAt: now,
          deactivatedAt: null,
          updatedAt: now,
        },
      ]),
    });

    const response = await app.inject({ method: "GET", url, headers });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json<PmsNavigationModulesResponse>()).toEqual({
      hotelId: propertyId,
      canManage: true,
      supportedModules: ["inbox", "reviews"],
      activeModules: ["inbox"],
      activations: [
        {
          moduleId: "inbox",
          isActive: true,
          activatedAt: now,
          deactivatedAt: null,
          updatedAt: now,
        },
      ],
    });
  });

  it("lets front desk staff read the switches but not change them", async () => {
    const repository = createRepository();
    app = buildAuthenticatedApp({
      repository,
      permissions: ["pms.dashboard.read", "pms.inbox.read"],
      relationship: "front_desk",
    });

    const read = await injectJson<PmsNavigationModulesResponse>(app, {
      method: "GET",
      url,
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({ canManage: false, activeModules: [] });

    const write = await app.inject({
      method: "PATCH",
      url: `${url}/inbox`,
      headers,
      payload: { moduleId: "inbox", isActive: true },
    });
    expect(write.statusCode).toBe(403);
    expect(repository.updates).toEqual([]);
  });

  it("refuses readers without a PMS sidebar permission and unauthenticated requests", async () => {
    app = buildAuthenticatedApp({ permissions: ["pms.finance.read"] });
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
  });

  it("switches a module for an owner and returns the stored row", async () => {
    const repository = createRepository();
    app = buildAuthenticatedApp({ repository, relationship: "owner" });

    const response = await app.inject({
      method: "PATCH",
      url: `${url}/reviews`,
      headers,
      payload: { moduleId: "reviews", isActive: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json<PmsNavigationModule>()).toMatchObject({
      moduleId: "reviews",
      isActive: true,
    });
    expect(repository.updates).toEqual([{ propertyId, moduleId: "reviews", isActive: true }]);
  });

  it("rejects modules it does not own and malformed bodies before writing", async () => {
    const repository = createRepository();
    app = buildAuthenticatedApp({ repository });

    for (const [path, payload] of [
      ["financials", { isActive: true }],
      ["inbox", { isActive: "yes" }],
      ["inbox", { moduleId: "reviews", isActive: true }],
    ] as const) {
      const response = await app.inject({
        method: "PATCH",
        url: `${url}/${path}`,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/pms/properties/nope/navigation-modules",
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.updates).toEqual([]);
  });

  it("reports storage failures as unavailable", async () => {
    const repository = createRepository();
    repository.fail = true;
    app = buildAuthenticatedApp({ repository });

    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(503);
    const write = await app.inject({
      method: "PATCH",
      url: `${url}/inbox`,
      headers,
      payload: { isActive: false },
    });
    expect(write.statusCode).toBe(503);
  });

  it("answers allowed browser origins and refuses others", async () => {
    app = buildAuthenticatedApp({ allowedOrigins: ["https://pms.vayada.com"] });

    const allowed = await app.inject({
      method: "OPTIONS",
      url: `${url}/inbox`,
      headers: { origin: "https://pms.vayada.com" },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-methods"]).toBe("GET,PATCH,OPTIONS");

    const refused = await app.inject({
      method: "GET",
      url,
      headers: { ...headers, origin: "https://evil.example" },
    });
    expect(refused.statusCode).toBe(403);
  });
});
