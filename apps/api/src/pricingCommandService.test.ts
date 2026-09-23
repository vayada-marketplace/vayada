import { AuthError, type IdentityRepository, type PermissionKey } from "@vayada/backend-auth";
import { afterEach, describe, expect, it, vi, type MockedFunction } from "vitest";

import { PricingStorageError } from "./domains/replacementPricingStore.js";
import {
  buildPricingCommandService,
  type PricingAuthorityOperations,
  type PublicPricingOperations,
} from "./pricingCommandService.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const otherPropertyId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";
const membershipId = "55555555-5555-4555-8555-555555555555";
const internalToken = "internal-token-with-at-least-32-bytes";
const hotelSlug = "synthetic-hotel";
const apps: ReturnType<typeof buildPricingCommandService>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function identityRepository(status: "active" | "inactive" = "active"): IdentityRepository {
  return {
    findUserByProviderUserId: vi.fn().mockResolvedValue({
      userId,
      email: "owner@example.test",
      status: "active",
    }),
    findOrganizationByWorkosOrgId: vi.fn().mockResolvedValue({
      organizationId,
      workosOrgId: "org_workos",
      kind: "hotel_group",
      status: "active",
    }),
    findActiveMembership: vi.fn().mockResolvedValue({
      membershipId,
      status,
      roleKey: "owner",
      workosMembershipId: null,
      workosRoleSlugs: ["owner"],
    }),
    findLinkedResources: vi.fn().mockResolvedValue([
      {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
        relationship: "owner",
        status: "active",
      },
    ]),
  };
}

function fixture(
  options: {
    permissions?: PermissionKey[];
    sessionId?: string | null;
    membershipStatus?: "active" | "inactive";
    ownerManage?: PricingAuthorityOperations["save"];
    publicOffers?: PublicPricingOperations["offers"];
    publicQuote?: PublicPricingOperations["quote"];
  } = {},
) {
  const ownerRead = vi.fn().mockResolvedValue({ authority: "unconfigured", revision: null });
  const ownerManage = (options.ownerManage ??
    vi.fn().mockResolvedValue({
      revision: otherPropertyId,
      replayed: false,
    })) as MockedFunction<PricingAuthorityOperations["save"]>;
  const permissions = options.permissions ?? ["pms.rooms_rates.read", "pms.rooms_rates.manage"];
  const publicOffers = vi.fn(options.publicOffers ?? (async () => ({ rooms: [] })));
  const publicQuote = vi.fn(
    options.publicQuote ?? (async () => ({ version: "public-booking-quote.v1" })),
  );
  const app = buildPricingCommandService({
    logger: false,
    internalToken,
    propertyId,
    hotelSlug,
    auth: {
      async verifier(token) {
        if (token !== "valid") throw new AuthError("TOKEN_INVALID", "invalid");
        return {
          workosUserId: "user_workos",
          workosOrgId: "org_workos",
          sessionId: options.sessionId === undefined ? "session_workos" : options.sessionId,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        };
      },
      repository: identityRepository(options.membershipStatus),
      rolePermissionRepository: {
        findPermissionsForRole: vi.fn().mockResolvedValue(permissions),
      },
      entitlementRepository: {
        findEntitlementsForContext: vi.fn().mockResolvedValue([
          {
            product: "pms",
            key: "property-management",
            status: "active",
            resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
          },
        ]),
      },
      propertyAccessRepository: {
        findMembershipPropertyScope: vi.fn().mockResolvedValue({
          mode: "all",
          roleKey: "owner",
          accessOrigin: "agency",
          assignedPropertyIds: [],
          productAccess: { pms: true, booking: true },
        }),
      },
    },
    ownerRead,
    ownerManage,
    publicOffers,
    publicQuote,
  });
  apps.push(app);
  const headers = {
    authorization: "Bearer valid",
    "x-vayada-internal-token": internalToken,
  };
  return { app, headers, ownerRead, ownerManage, publicOffers, publicQuote };
}

describe("private pricing command service owner boundary", () => {
  it("independently resolves the original bearer and selects read versus manage operations", async () => {
    const f = fixture();
    const read = await f.app.inject({
      method: "GET",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: f.headers,
    });
    expect(read.statusCode).toBe(200);
    expect(f.ownerRead).toHaveBeenCalledOnce();
    expect(f.ownerRead.mock.calls[0]?.[1]).toEqual({
      propertyId,
      organizationId,
      actorUserId: userId,
    });
    expect(f.ownerManage).not.toHaveBeenCalled();

    const write = await f.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...f.headers, "idempotency-key": "choose-vayada" },
      payload: { expectedRevision: null, authority: "vayada" },
    });
    expect(write.statusCode).toBe(200);
    expect(f.ownerManage).toHaveBeenCalledOnce();
    expect(f.ownerManage.mock.calls[0]?.[2]).toEqual({
      requestId: "choose-vayada",
      expectedRevision: null,
      authority: "vayada",
    });
  });

  it("fails closed before selecting a pool for caller, bearer, property or session gaps", async () => {
    for (const request of [
      { headers: { authorization: "Bearer valid" }, property: propertyId },
      {
        headers: { "x-vayada-internal-token": internalToken, authorization: "Bearer invalid" },
        property: propertyId,
      },
      { headers: fixture().headers, property: otherPropertyId },
    ]) {
      const f = fixture();
      const response = await f.app.inject({
        method: "GET",
        url: `/v1/owner/properties/${request.property}/authority`,
        headers: request.headers,
      });
      expect([401, 403]).toContain(response.statusCode);
      expect(f.ownerRead).not.toHaveBeenCalled();
    }
    const noSession = fixture({ sessionId: null });
    expect(
      (
        await noSession.app.inject({
          method: "GET",
          url: `/v1/owner/properties/${propertyId}/authority`,
          headers: noSession.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(noSession.ownerRead).not.toHaveBeenCalled();
  });

  it("rejects forwarded identity context and read-only staff cannot manage", async () => {
    const forged = fixture();
    const forgedResponse = await forged.app.inject({
      method: "GET",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...forged.headers, "x-vayada-role": "owner" },
    });
    expect(forgedResponse.statusCode).toBe(400);
    expect(forged.ownerRead).not.toHaveBeenCalled();

    const readOnly = fixture({ permissions: ["pms.rooms_rates.read"] });
    const manageResponse = await readOnly.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...readOnly.headers, "idempotency-key": "manage" },
      payload: { expectedRevision: null, authority: "vayada" },
    });
    expect(manageResponse.statusCode).toBe(403);
    expect(readOnly.ownerManage).not.toHaveBeenCalled();
  });

  it("runs independent admission before parsing a malformed command and rejects query selectors", async () => {
    const f = fixture();
    const malformed = await f.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: {
        "x-vayada-internal-token": internalToken,
        authorization: "Bearer invalid",
        "content-type": "application/json",
      },
      payload: "{",
    });
    expect(malformed.statusCode).toBe(401);
    expect(f.ownerManage).not.toHaveBeenCalled();

    const query = await f.app.inject({
      method: "GET",
      url: `/v1/owner/properties/${propertyId}/authority?organizationId=${organizationId}`,
      headers: f.headers,
    });
    expect(query.statusCode).toBe(403);
    expect(f.ownerRead).not.toHaveBeenCalled();
  });

  it("rejects unknown body keys and preserves revocation denial from the transactional store", async () => {
    const f = fixture({
      ownerManage: vi.fn().mockRejectedValue(new PricingStorageError("denied")),
    });
    const unknown = await f.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...f.headers, "idempotency-key": "unknown" },
      payload: { expectedRevision: null, authority: "vayada", organizationId },
    });
    expect(unknown.statusCode).toBe(400);
    expect(f.ownerManage).not.toHaveBeenCalled();

    const revoked = await f.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...f.headers, "idempotency-key": "revoked" },
      payload: { expectedRevision: null, authority: "vayada" },
    });
    expect(revoked.statusCode).toBe(403);
  });

  it("preserves the existing idempotency-key contract", async () => {
    const f = fixture();
    const accepted = await f.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...f.headers, "idempotency-key": "owner choice 1" },
      payload: { expectedRevision: null, authority: "vayada" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(f.ownerManage.mock.calls[0]?.[2]).toMatchObject({ requestId: "owner choice 1" });

    for (const key of [" leading", "trailing ", "a,b", ""]) {
      const rejected = await f.app.inject({
        method: "PUT",
        url: `/v1/owner/properties/${propertyId}/authority`,
        headers: { ...f.headers, "idempotency-key": key },
        payload: { expectedRevision: null, authority: "vayada" },
      });
      expect(rejected.statusCode).toBe(400);
    }
  });
});

describe("private pricing command service public boundary", () => {
  const quoteRequest = {
    version: "public-booking-quote-request.v1",
    selection: {
      version: "public-pricing-selection.v1",
      checkIn: "2026-10-01",
      checkOut: "2026-10-02",
      currency: "EUR",
      rooms: [
        {
          selectionId: "one",
          publicOfferKey: "offer",
          guests: { adults: 1, childAgesAtCheckIn: [] },
        },
      ],
      addons: [],
      promoCode: null,
    },
    paymentMethod: "pay_at_property",
  } as const;

  it("selects only the public operation for the fixed slug even when a bearer is present", async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: "GET",
      url: `/v1/public/hotels/${hotelSlug}/offers`,
      headers: f.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(f.publicOffers).toHaveBeenCalledWith(hotelSlug);
    expect(f.ownerRead).not.toHaveBeenCalled();
    expect(f.ownerManage).not.toHaveBeenCalled();
  });

  it("rejects alternate slugs and query selectors before selecting the public operation", async () => {
    for (const url of [
      "/v1/public/hotels/other-hotel/offers",
      `/v1/public/hotels/${hotelSlug}/offers?propertyId=${otherPropertyId}`,
    ]) {
      const f = fixture();
      const response = await f.app.inject({
        method: "GET",
        url,
        headers: { "x-vayada-internal-token": internalToken },
      });
      expect(response.statusCode).toBe(404);
      expect(f.publicOffers).not.toHaveBeenCalled();
    }
  });

  it("issues only pay-at-property quotes under the existing idempotency contract", async () => {
    const f = fixture();
    const accepted = await f.app.inject({
      method: "POST",
      url: `/v1/public/hotels/${hotelSlug}/quotes`,
      headers: { "x-vayada-internal-token": internalToken, "idempotency-key": "quote-1" },
      payload: quoteRequest,
    });
    expect(accepted.statusCode).toBe(200);
    expect(f.publicQuote).toHaveBeenCalledWith(
      hotelSlug,
      quoteRequest,
      "quote-1",
      expect.any(AbortSignal),
    );
    expect(f.ownerManage).not.toHaveBeenCalled();

    for (const payload of [
      { ...quoteRequest, paymentMethod: "card" },
      { ...quoteRequest, organizationId },
    ]) {
      const rejected = await f.app.inject({
        method: "POST",
        url: `/v1/public/hotels/${hotelSlug}/quotes`,
        headers: { "x-vayada-internal-token": internalToken, "idempotency-key": "quote 2" },
        payload,
      });
      expect(rejected.statusCode).toBe(400);
    }
    expect(f.publicQuote).toHaveBeenCalledOnce();
  });

  it("preserves refresh-required versus idempotency-conflict quote outcomes", async () => {
    for (const [reported, expected] of [
      ["QUOTE_REFRESH_REQUIRED", "QUOTE_REFRESH_REQUIRED"],
      [undefined, "idempotency_conflict"],
    ] as const) {
      const f = fixture({
        publicQuote: vi.fn().mockRejectedValue(
          Object.assign(new Error("safe internal quote failure"), {
            statusCode: 409,
            ...(reported ? { code: reported } : {}),
          }),
        ),
      });
      const response = await f.app.inject({
        method: "POST",
        url: `/v1/public/hotels/${hotelSlug}/quotes`,
        headers: { "x-vayada-internal-token": internalToken, "idempotency-key": "quote-error" },
        payload: quoteRequest,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code: expected });
    }
  });
});
