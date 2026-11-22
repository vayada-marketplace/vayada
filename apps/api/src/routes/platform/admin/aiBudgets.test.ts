import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AiBudgetAdmin,
  AiBudgetChange,
  AiAccountBudget,
} from "../../../ai/usage/budgetAdmin.js";
import { buildApp } from "../../../app.js";
import { agencyPropertyAccessRepository } from "../../../testAuthorization.js";

const organizationId = "22222222-2222-4222-8222-222222222222";
const session: VerifiedSession = {
  workosUserId: "workos-platform-user",
  workosOrgId: "workos-platform-org",
  sessionId: "platform-session",
  expiresAt: Math.floor(Date.now() / 1_000) + 60,
};
const account: AiAccountBudget = {
  organizationId,
  name: "Alpine Lodge",
  status: "active",
  monthlyLimitMicroUsd: 25_000_000,
  custom: true,
  usedMicroUsd: 1_234_567,
  calls: 12,
  updatedAt: "2026-11-21T10:00:00.000Z",
};
const STAFF: PermissionKey[] = ["platform.admin.read", "platform.user.suspend"];

describe("vayada staff set a hotel account's monthly AI budget (VAY-2504)", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  afterEach(async () => app?.close());

  const put = (payload: unknown, id = organizationId) =>
    injectJson(app!, {
      method: "PUT",
      url: `/api/platform/admin/ai-budgets/${id}`,
      headers: { authorization: "Bearer platform-token" },
      payload: payload as Record<string, unknown>,
    });
  const get = () =>
    injectJson(app!, {
      method: "GET",
      url: "/api/platform/admin/ai-budgets",
      headers: { authorization: "Bearer platform-token" },
    });

  it("lists every account's use for staff who can read the platform", async () => {
    const target = harness();
    app = build(target, { permissions: ["platform.admin.read"] });

    const response = await get();

    expect(response.statusCode).toBe(200);
    const raw = await app.inject({
      method: "GET",
      url: "/api/platform/admin/ai-budgets",
      headers: { authorization: "Bearer platform-token" },
    });
    expect(raw.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual({
      month: "2026-11-01",
      defaultMonthlyLimitMicroUsd: 5_000_000,
      totalUsedMicroUsd: 1_234_567,
      accounts: [account],
    });
  });

  it("lets only platform admins of an active vayada organization with the operator resource in", async () => {
    const target = harness();
    app = build(target, { permissions: ["platform.admin.read"] });
    expect((await put({ monthlyLimitUsd: "25", reason: "Busy season" })).statusCode).toBe(403);
    await app.close();
    app = build(target, { resourceAccess: false });
    expect((await put({ monthlyLimitUsd: "25", reason: "Busy season" })).statusCode).toBe(403);
    expect((await get()).statusCode).toBe(403);
    await app.close();
    app = build(target, { organizationKind: "hotel_group" });
    expect((await put({ monthlyLimitUsd: "25", reason: "Busy season" })).statusCode).toBe(403);
    await app.close();
    // A suspended organization is already refused when its session is read.
    app = build(target, { organizationStatus: "suspended" });
    expect((await put({ monthlyLimitUsd: "25", reason: "Busy season" })).statusCode).toBe(401);
    expect((await get()).statusCode).toBe(401);
    const signedOut = await injectJson(app, {
      method: "GET",
      url: "/api/platform/admin/ai-budgets",
    });
    expect(signedOut.statusCode).toBe(401);
    expect(target.changes).toEqual([]);
  });

  it("sets dollars with a reason, or puts the account back on the default", async () => {
    const target = harness();
    app = build(target);

    const raised = await put({ monthlyLimitUsd: " 25.50 ", reason: " Busy season " });
    const reset = await put(
      { monthlyLimitUsd: null, reason: "Season over" },
      organizationId.toUpperCase(),
    );

    expect(raised.statusCode).toBe(200);
    expect(raised.body).toEqual(account);
    expect(reset.statusCode).toBe(200);
    expect(target.changes).toEqual([
      {
        organizationId,
        monthlyLimitMicroUsd: 25_500_000,
        reason: "Busy season",
        audit: {
          actorUserId: "platform-user",
          requestId: expect.any(String),
          correlationId: expect.any(String),
          requestedAt: expect.any(String),
        },
      },
      expect.objectContaining({
        organizationId,
        monthlyLimitMicroUsd: null,
        reason: "Season over",
      }),
    ]);
  });

  it("refuses anything but whole dollars and cents up to $100,000 with a reason", async () => {
    const target = harness();
    app = build(target);
    for (const payload of [
      { monthlyLimitUsd: "25" },
      { monthlyLimitUsd: "25", reason: "  " },
      { monthlyLimitUsd: "25", reason: "x".repeat(501) },
      { monthlyLimitUsd: 25, reason: "Number, not text" },
      { monthlyLimitUsd: "-1", reason: "Negative" },
      { monthlyLimitUsd: "2.505", reason: "Below a cent" },
      { monthlyLimitUsd: "1e3", reason: "Exponent" },
      { monthlyLimitUsd: "100000.01", reason: "Too high" },
      { reason: "No limit given" },
    ])
      expect((await put(payload)).body, JSON.stringify(payload)).toMatchObject({
        code: "invalid_ai_budget",
      });
    expect((await put({ monthlyLimitUsd: "25", reason: "x" }, "not-a-uuid")).statusCode).toBe(400);
    expect((await put({ monthlyLimitUsd: "100000", reason: "Highest" })).statusCode).toBe(200);
    expect(target.changes).toHaveLength(1);
  });

  it("answers 404 for an id that is not a hotel account", async () => {
    app = build(harness(null));
    const response = await put({ monthlyLimitUsd: "25", reason: "Busy season" });
    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ code: "hotel_account_not_found" });
  });
});

function harness(result: AiAccountBudget | null = account) {
  const changes: AiBudgetChange[] = [];
  const admin: AiBudgetAdmin = {
    async overview() {
      return {
        month: "2026-11-01",
        defaultMonthlyLimitMicroUsd: 5_000_000,
        totalUsedMicroUsd: 1_234_567,
        accounts: [account],
      };
    },
    async setBudget(change) {
      changes.push(change);
      return result;
    },
  };
  return { admin, changes };
}

function build(
  target: ReturnType<typeof harness>,
  options: {
    permissions?: PermissionKey[];
    resourceAccess?: boolean;
    organizationKind?: "platform" | "hotel_group";
    organizationStatus?: "active" | "suspended";
  } = {},
) {
  return buildApp({
    logger: false,
    platformAiBudgets: { admin: target.admin },
    auth: {
      verifier: createFakeVerifier(new Map([["platform-token", session]])),
      repository: identityRepository(
        options.resourceAccess !== false,
        options.organizationKind ?? "platform",
        options.organizationStatus ?? "active",
      ),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? STAFF;
        },
      },
    },
  });
}

function identityRepository(
  resourceAccess: boolean,
  kind: "platform" | "hotel_group",
  status: "active" | "suspended",
): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return { userId: "platform-user", email: "admin@vayada.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "platform-org",
        workosOrgId: "workos-platform-org",
        kind,
        status,
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "platform-membership",
        status: "active",
        roleKey: kind === "platform" ? "platform_admin" : "hotel_owner",
        workosMembershipId: "workos-platform-membership",
        workosRoleSlugs: [kind === "platform" ? "platform_admin" : "hotel_owner"],
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
