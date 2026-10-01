import {
  AuthError,
  type IdentityRepository,
  type PermissionKey,
  type ProductEntitlement,
} from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildHotelSetupCommandService } from "./hotelSetupCommandService.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const otherPropertyId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";
const internalToken = "internal-token-with-at-least-32-bytes";
const apps: ReturnType<typeof buildHotelSetupCommandService>[] = [];
const payload = { currency: "EUR", expectedPricingCurrencyRevision: 0 };
const path = `/properties/${propertyId}/pricing-source/currency`;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(
  options: {
    session?: boolean;
    setupComplete?: boolean;
    globalFinancialsSuspended?: boolean;
    financialsActive?: boolean;
    assignment?: "current" | "other";
    malformedOverride?: boolean;
    membership?: "active" | "inactive";
    permissions?: PermissionKey[];
    entitlement?: "missing" | "suspended";
    link?: "missing" | "operator" | "other_property";
  } = {},
) {
  const repository: IdentityRepository = {
    findUserByProviderUserId: vi
      .fn()
      .mockResolvedValue({ userId, email: "owner@example.test", status: "active" }),
    findOrganizationByWorkosOrgId: vi.fn().mockResolvedValue({
      organizationId,
      workosOrgId: "org_workos",
      kind: "hotel_group",
      status: "active",
    }),
    findActiveMembership: vi.fn().mockResolvedValue({
      membershipId: otherPropertyId,
      status: options.membership ?? "active",
      roleKey: "owner",
      workosMembershipId: null,
      workosRoleSlugs: ["owner"],
    }),
    findLinkedResources: vi.fn().mockResolvedValue(
      options.link === "missing"
        ? []
        : [
            {
              product: "hotel_catalog",
              resourceType: "property",
              resourceId: options.link === "other_property" ? otherPropertyId : propertyId,
              relationship: options.link === "operator" ? "operator" : "owner",
              status: "active",
            },
            {
              product: "pms",
              resourceType: "pms_property",
              resourceId: options.link === "other_property" ? otherPropertyId : propertyId,
              relationship: options.link === "operator" ? "operator" : "owner",
              status: "active",
            },
          ],
    ),
  };
  const verifier = vi.fn(async (token: string) => {
    if (token !== "valid") throw new AuthError("TOKEN_INVALID", "invalid");
    return {
      workosUserId: "user_workos",
      workosOrgId: "org_workos",
      sessionId: options.session === false ? null : "session_workos",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };
  });
  const entitlements: ProductEntitlement[] =
    options.entitlement === "missing"
      ? []
      : [
          {
            product: "pms",
            key: "property-management",
            status: options.entitlement === "suspended" ? "suspended" : "active",
            resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
          },
        ];
  if (options.globalFinancialsSuspended)
    entitlements.push({ product: "pms", key: "module:financials", status: "suspended" });
  const feature = vi.fn(async (_context, _propertyId, isActive: boolean) => ({
    moduleId: "financials",
    isActive,
    activatedAt: null,
    deactivatedAt: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
  }));
  const setupComplete = vi.fn().mockResolvedValue(options.setupComplete ?? true);
  const save = vi.fn().mockResolvedValue({
    ok: true,
    response: {
      contractVersion: PMS_PRICING_CONTRACT_VERSION,
      outcome: "created",
      pricingCurrency: {
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        propertyId,
        currency: "EUR",
        pricingCurrencyRevision: 1,
        createdAt: "2026-09-30T12:00:00.000Z",
        updatedAt: "2026-09-30T12:00:00.000Z",
      },
      acceptedAt: "2026-09-30T12:00:00.000Z",
    },
  });
  const app = buildHotelSetupCommandService({
    internalToken,
    logger: false,
    auth: {
      verifier,
      repository,
      rolePermissionRepository: {
        findPermissionsForRole: vi
          .fn()
          .mockResolvedValue(options.permissions ?? ["pms.operations.manage"]),
      },
      entitlementRepository: {
        findEntitlementsForContext: vi.fn().mockResolvedValue(entitlements),
      },
      propertyAccessRepository: {
        recordInvalidPermissionOverride: vi.fn().mockResolvedValue(undefined),
        findMembershipPropertyScope: vi.fn().mockResolvedValue({
          mode: options.assignment ? "assigned" : "all",
          roleKey: "owner",
          accessOrigin: "agency",
          assignedPropertyIds: options.assignment
            ? [options.assignment === "current" ? propertyId : otherPropertyId]
            : [],
          ...(options.malformedOverride ? { permissionOverrides: { invalid: true } } : {}),
          productAccess: { pms: true, booking: true },
        }),
      },
    },
    currencyCommands: { upsertPropertyPricingCurrency: save },
    featureHub: {
      reads: {
        list: vi.fn().mockResolvedValue([
          {
            moduleId: "financials",
            isActive: options.financialsActive ?? false,
            activatedAt: null,
            deactivatedAt: null,
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        ]),
      },
      commands: { updateFinancials: feature },
      setupComplete,
    },
  });
  apps.push(app);
  return {
    app,
    feature,
    setupComplete,
    save,
    verifier,
    headers: {
      authorization: "Bearer valid",
      "x-vayada-internal-token": internalToken,
      "idempotency-key": "currency-first-save",
    },
  };
}

describe("private hotel setup currency service", () => {
  it("derives actor and organization from its own original-session verifier", async () => {
    const f = fixture();
    const response = await f.app.inject({ method: "PUT", url: path, headers: f.headers, payload });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(f.verifier).toHaveBeenCalledWith("valid");
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.save.mock.calls[0]?.[0]).toMatchObject({
      organizationId,
      propertyId,
      idempotencyKey: "currency-first-save",
      currency: "EUR",
      expectedPricingCurrencyRevision: 0,
      audit: { actor: { kind: "user", userId } },
    });
  });

  it.each([
    { session: false },
    { assignment: "other" as const },
    { malformedOverride: true },
    { membership: "inactive" as const },
    { permissions: [] },
    { entitlement: "missing" as const },
    { entitlement: "suspended" as const },
    { link: "missing" as const },
    { link: "operator" as const },
    { link: "other_property" as const },
  ])(
    "denies incomplete current authorization before selecting credentials: %j",
    async (options) => {
      const f = fixture(options);
      const response = await f.app.inject({
        method: "PUT",
        url: path,
        headers: f.headers,
        payload,
      });
      expect([401, 403]).toContain(response.statusCode);
      expect(f.save).not.toHaveBeenCalled();
    },
  );

  it("accepts a hotel included in the current property assignment", async () => {
    const f = fixture({ assignment: "current" });
    expect(
      (await f.app.inject({ method: "PUT", url: path, headers: f.headers, payload })).statusCode,
    ).toBe(201);
    expect(f.save).toHaveBeenCalledOnce();
  });

  it("denies missing transport auth and invalid bearer before parsing", async () => {
    for (const headers of [
      { authorization: "Bearer valid" },
      { "x-vayada-internal-token": internalToken },
      { "x-vayada-internal-token": internalToken, authorization: "Bearer invalid" },
    ]) {
      const f = fixture();
      const response = await f.app.inject({
        method: "PUT",
        url: path,
        headers: { ...headers, "content-type": "application/json" },
        payload: "{",
      });
      expect(response.statusCode).toBe(401);
      expect(f.save).not.toHaveBeenCalled();
    }
  });

  it("rejects forwarded identity, query selectors, unknown body claims and missing keys", async () => {
    const f = fixture();
    for (const request of [
      { headers: { ...f.headers, "x-vayada-role": "owner" } },
      { headers: { ...f.headers, "x-hotel-id": otherPropertyId } },
      { url: `${path}?organizationId=${organizationId}` },
      { payload: { ...payload, organizationId } },
      { payload: { ...payload, databaseUrl: "postgresql://owner@db/target" } },
      { headers: { ...f.headers, "idempotency-key": "" } },
    ]) {
      const response = await f.app.inject({
        method: "PUT",
        url: path,
        headers: f.headers,
        payload,
        ...request,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(f.save).not.toHaveBeenCalled();
  });

  it("sanitizes unavailable credentials and exposes only the fixed currency command", async () => {
    const f = fixture();
    f.save.mockRejectedValue(new Error("secret database connection detail"));
    const response = await f.app.inject({ method: "PUT", url: path, headers: f.headers, payload });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "hotel_setup_unavailable" });
    expect(
      (await f.app.inject({ method: "POST", url: "/execute", headers: f.headers, payload }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: `/properties/${propertyId}/pricing-source`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("private hotel setup Feature Hub", () => {
  const featurePath = `/properties/${propertyId}/module-activations/financials`;
  const permissions: PermissionKey[] = [
    "pms.operations.read",
    "pms.finance.read",
    "pms.finance.manage",
  ];
  it("keeps completed setup visible after off and forwards the original verified actor for on/off", async () => {
    const f = fixture({ permissions });
    const read = await f.app.inject({
      method: "GET",
      url: `/properties/${propertyId}/module-activations`,
      headers: f.headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      canManage: true,
      supportedModules: ["financials"],
      activeModules: [],
    });
    for (const isActive of [true, false, false]) {
      const response = await f.app.inject({
        method: "PATCH",
        url: featurePath,
        headers: f.headers,
        payload: { isActive, actorUserId: otherPropertyId, organizationId: otherPropertyId },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ isActive });
      expect(f.feature.mock.lastCall).toEqual([
        expect.objectContaining({
          actor: expect.objectContaining({ internalUserId: userId }),
          selectedOrganization: expect.objectContaining({ organizationId }),
        }),
        propertyId,
        isActive,
      ]);
    }
    expect(f.save).not.toHaveBeenCalled();
  });
  it.each([
    { session: false },
    { assignment: "other" as const },
    { malformedOverride: true },
    { membership: "inactive" as const },
    { permissions: [] },
    { link: "missing" as const },
    { link: "operator" as const },
    { link: "other_property" as const },
  ])("denies untrusted/current unauthorized access %j", async (options) => {
    const f = fixture({ permissions, ...options });
    const response = await f.app.inject({
      method: "PATCH",
      url: featurePath,
      headers: f.headers,
      payload: { isActive: false },
    });
    expect(response.statusCode).toBe(options.membership === "inactive" ? 401 : 403);
    expect(f.feature).not.toHaveBeenCalled();
  });
  it.each(["missing", "suspended"] as const)(
    "allows off but denies on when base access is %s",
    async (entitlement) => {
      const f = fixture({ permissions, entitlement });
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: `/properties/${propertyId}/module-activations`,
            headers: f.headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await f.app.inject({
            method: "PATCH",
            url: featurePath,
            headers: f.headers,
            payload: { isActive: false },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await f.app.inject({
            method: "PATCH",
            url: featurePath,
            headers: f.headers,
            payload: { isActive: true },
          })
        ).statusCode,
      ).toBe(403);
      expect(f.feature).toHaveBeenCalledOnce();
    },
  );
  it("does not use setup readiness to bypass a global suspension", async () => {
    const f = fixture({ permissions, globalFinancialsSuspended: true, financialsActive: true });
    const response = await f.app.inject({
      method: "GET",
      url: `/properties/${propertyId}/module-activations`,
      headers: f.headers,
    });
    expect(response.json()).toMatchObject({
      canManage: true,
      activeModules: [],
      activations: [{ moduleId: "financials", isActive: true }],
    });
    expect(
      (
        await f.app.inject({
          method: "PATCH",
          url: featurePath,
          headers: f.headers,
          payload: { isActive: false },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: "PATCH",
          url: featurePath,
          headers: f.headers,
          payload: { isActive: true },
        })
      ).statusCode,
    ).toBe(409);
    expect(f.feature).toHaveBeenCalledOnce();
  });
  it("does not automatically enroll an existing hotel without completed new-hotel setup", async () => {
    const f = fixture({ permissions, setupComplete: false });
    expect(
      (
        await f.app.inject({
          method: "PATCH",
          url: featurePath,
          headers: f.headers,
          payload: { isActive: true },
        })
      ).statusCode,
    ).toBe(403);
    expect(f.feature).not.toHaveBeenCalled();
  });
  it("rejects missing internal auth and invalid sessions before selecting native credentials", async () => {
    const f = fixture({ permissions });
    for (const headers of [
      { authorization: "Bearer valid" },
      { ...f.headers, authorization: "Bearer invalid" },
    ]) {
      expect(
        (
          await f.app.inject({
            method: "PATCH",
            url: featurePath,
            headers,
            payload: { isActive: true },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(f.feature).not.toHaveBeenCalled();
  });
});

it("sanitizes private Feature Hub storage errors and preserves current authorization denial", async () => {
  const f = fixture({ permissions: ["pms.finance.manage"] });
  const url = `/properties/${propertyId}/module-activations/financials`;
  f.feature.mockRejectedValueOnce(new AuthorizationError());
  expect(
    (await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { isActive: false } }))
      .statusCode,
  ).toBe(403);
  f.feature.mockRejectedValueOnce(new Error("database credential detail"));
  const response = await f.app.inject({
    method: "PATCH",
    url,
    headers: f.headers,
    payload: { isActive: false },
  });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ code: "hotel_setup_unavailable" });
});
