import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AffiliateDiscrepancyRepository } from "./domains/affiliateDiscrepancy.js";
import { registerMarketplaceAffiliateDiscrepancyRoutes } from "./routes/marketplaceAffiliateDiscrepancies.js";

const id = (n: number) => `15160000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const claim = {
  claimId: id(9),
  kind: "earning" as const,
  status: "submitted" as const,
  agreementId: id(4),
  propertyId: id(5),
  bookingReference: "••••0006",
  payoutId: null,
  message: "Missing commission",
  evidenceReferences: ["creator-note-1"],
  decisionReason: null,
  decisionEvidenceReferences: [],
  createdAt: "2026-09-29T00:00:00.000Z",
  resolvedAt: null,
};
const apps: ReturnType<typeof Fastify>[] = [];

describe("Marketplace affiliate discrepancy routes", () => {
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("derives creator scope, preserves evidence and returns duplicate replay", async () => {
    const { app, repository } = await setup(creator());
    const payload = {
      kind: "earning",
      agreementId: id(4),
      propertyId: id(5),
      bookingId: id(6),
      payoutId: null,
      message: " Missing commission ",
      evidenceReferences: ["creator-note-1"],
      creatorProfileId: "attacker",
    };
    const created = await app.inject({ method: "POST", url: "/affiliate-discrepancies", payload });
    expect(created.statusCode).toBe(201);
    expect(repository.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { organizationId: id(1), creatorProfileId: id(2), affiliateId: "affiliate-1516" },
        message: "Missing commission",
        evidenceReferences: ["creator-note-1"],
      }),
    );
    repository.submit.mockResolvedValueOnce({ claim, replayed: true });
    expect(
      (await app.inject({ method: "POST", url: "/affiliate-discrepancies", payload })).statusCode,
    ).toBe(200);
  });

  it("scopes creator reads and denies missing or ambiguous identity", async () => {
    const allowed = await setup(creator());
    expect(
      (await allowed.app.inject({ method: "GET", url: "/affiliate-discrepancies" })).json(),
    ).toEqual({ claims: [claim] });
    expect(allowed.repository.list).toHaveBeenCalledWith({
      organizationId: id(1),
      creatorProfileId: id(2),
      affiliateId: "affiliate-1516",
    });
    expect(
      (await (await setup(null)).app.inject({ method: "GET", url: "/affiliate-discrepancies" }))
        .statusCode,
    ).toBe(401);
    const ambiguous = creator();
    ambiguous.linkedResources.push({
      product: "marketplace",
      resourceType: "creator_profile",
      resourceId: id(20),
      relationship: "owner",
      status: "active",
    });
    const denied = await setup(ambiguous);
    expect(
      (await denied.app.inject({ method: "GET", url: "/affiliate-discrepancies" })).statusCode,
    ).toBe(403);
    expect(denied.repository.list).not.toHaveBeenCalled();

    const missingPermission = creator();
    missingPermission.membership.permissions = [];
    const permissionDenied = await setup(missingPermission);
    expect(
      (await permissionDenied.app.inject({ method: "GET", url: "/affiliate-discrepancies" }))
        .statusCode,
    ).toBe(403);
    expect(permissionDenied.repository.list).not.toHaveBeenCalled();

    const missingWrite = creator();
    missingWrite.membership.permissions = ["marketplace.collaboration.read"];
    const writeDenied = await setup(missingWrite);
    expect(
      (
        await writeDenied.app.inject({
          method: "POST",
          url: "/affiliate-discrepancies",
          payload: validPayload(),
        })
      ).statusCode,
    ).toBe(403);
    expect(writeDenied.repository.submit).not.toHaveBeenCalled();

    const hotel = creator();
    hotel.selectedOrganization.kind = "hotel_group";
    const wrongOrganization = await setup(hotel);
    expect(
      (await wrongOrganization.app.inject({ method: "GET", url: "/affiliate-discrepancies" }))
        .statusCode,
    ).toBe(403);
    expect(wrongOrganization.repository.list).not.toHaveBeenCalled();
  });

  it("keeps detail and invalid booking results opaque within creator scope", async () => {
    const scoped = await setup(creator());
    scoped.repository.get.mockResolvedValueOnce(null);
    const missing = await scoped.app.inject({
      method: "GET",
      url: `/affiliate-discrepancies/${id(90)}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "claim_not_found" });
    expect(scoped.repository.get).toHaveBeenCalledWith(
      { organizationId: id(1), creatorProfileId: id(2), affiliateId: "affiliate-1516" },
      id(90),
    );

    for (const code of ["23503", "23514"]) {
      const constraint = Object.assign(new Error("sensitive database detail"), { code });
      scoped.repository.submit.mockRejectedValueOnce(constraint);
      const rejected = await scoped.app.inject({
        method: "POST",
        url: "/affiliate-discrepancies",
        payload: validPayload(),
      });
      expect(rejected.statusCode).toBe(404);
      expect(rejected.json()).toEqual({ code: "booking_scope_not_found" });
      expect(rejected.body).not.toContain("sensitive database detail");
    }
  });

  it("allows hotel or platform resolution authority and denies creators", async () => {
    const hotel = context(
      "hotel_group",
      id(30),
      ["marketplace.collaboration.review"],
      [
        {
          product: "marketplace",
          resourceType: "hotel_profile",
          resourceId: id(5),
          relationship: "owner",
          status: "active",
        },
      ],
    );
    hotel.entitlements = [
      { product: "marketplace", key: "marketplace-hotel-profile", status: "active" },
    ];
    const hotelApp = await setup(hotel);
    const resolved = await hotelApp.app.inject({
      method: "POST",
      url: `/affiliate-discrepancies/${claim.claimId}/resolution`,
      headers: { "idempotency-key": "resolution-1" },
      payload: resolutionPayload(),
    });
    expect(resolved.statusCode).toBe(201);
    expect(hotelApp.repository.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: claim.claimId,
        propertyId: id(5),
        actorOrganizationId: id(30),
        requestId: "request-1516",
        resolution: expect.objectContaining({ decision: "denied", earningEntryId: null }),
      }),
    );

    const platform = context(
      "platform",
      id(40),
      ["platform.finance.manage"],
      [
        {
          product: "platform",
          resourceType: "platform",
          resourceId: "vayada",
          relationship: "finance_manager",
          status: "active",
        },
      ],
    );
    platform.membership.roleKey = "finance_manager";
    platform.entitlements = [
      {
        product: "platform",
        key: "finance-admin",
        status: "active",
        resource: { product: "platform", resourceType: "platform", resourceId: "vayada" },
      },
    ];
    const platformApp = await setup(platform);
    expect(
      (
        await platformApp.app.inject({
          method: "POST",
          url: `/affiliate-discrepancies/${claim.claimId}/resolution`,
          headers: { "idempotency-key": "resolution-2" },
          payload: resolutionPayload(),
        })
      ).statusCode,
    ).toBe(201);
    expect(platformApp.repository.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: null, actorOrganizationId: id(40) }),
    );

    const creatorApp = await setup(creator());
    expect(
      (
        await creatorApp.app.inject({
          method: "POST",
          url: `/affiliate-discrepancies/${claim.claimId}/resolution`,
          headers: { "idempotency-key": "resolution-3" },
          payload: resolutionPayload(),
        })
      ).statusCode,
    ).toBe(403);
    expect(creatorApp.repository.resolve).not.toHaveBeenCalled();
  });

  it("denies wrong hotel scope, missing authority and evidence-free confirmation", async () => {
    const hotel = context(
      "hotel_group",
      id(30),
      ["marketplace.collaboration.review"],
      [
        {
          product: "marketplace",
          resourceType: "hotel_profile",
          resourceId: id(5),
          relationship: "owner",
          status: "active",
        },
      ],
    );
    hotel.entitlements = [
      { product: "marketplace", key: "marketplace-hotel-profile", status: "active" },
    ];
    const wrongProperty = await setup(hotel);
    expect(
      (
        await wrongProperty.app.inject({
          method: "POST",
          url: `/affiliate-discrepancies/${claim.claimId}/resolution`,
          headers: { "idempotency-key": "resolution-wrong-property" },
          payload: { ...resolutionPayload(), propertyId: id(6) },
        })
      ).statusCode,
    ).toBe(403);
    expect(wrongProperty.repository.resolve).not.toHaveBeenCalled();

    const missingEntitlement = structuredClone(hotel);
    missingEntitlement.entitlements = [];
    const noEntitlement = await setup(missingEntitlement);
    expect(
      (
        await noEntitlement.app.inject({
          method: "POST",
          url: `/affiliate-discrepancies/${claim.claimId}/resolution`,
          headers: { "idempotency-key": "resolution-no-entitlement" },
          payload: resolutionPayload(),
        })
      ).statusCode,
    ).toBe(403);
    expect(noEntitlement.repository.resolve).not.toHaveBeenCalled();

    const invalidEvidence = await setup(hotel);
    expect(
      (
        await invalidEvidence.app.inject({
          method: "POST",
          url: `/affiliate-discrepancies/${claim.claimId}/resolution`,
          headers: { "idempotency-key": "resolution-no-evidence" },
          payload: {
            propertyId: id(5),
            decision: "confirmed_earning",
            reason: "Commission granted",
            evidenceReferences: [],
            earningEntryId: id(70),
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(invalidEvidence.repository.resolve).not.toHaveBeenCalled();

    const platform = context(
      "platform",
      id(40),
      [],
      [
        {
          product: "platform",
          resourceType: "platform",
          resourceId: "vayada",
          relationship: "finance_manager",
          status: "active",
        },
      ],
    );
    platform.membership.roleKey = "finance_manager";
    platform.entitlements = [
      {
        product: "platform",
        key: "finance-admin",
        status: "active",
        resource: { product: "platform", resourceType: "platform", resourceId: "vayada" },
      },
    ];
    const noPlatformPermission = await setup(platform);
    expect(
      (
        await noPlatformPermission.app.inject({
          method: "POST",
          url: `/affiliate-discrepancies/${claim.claimId}/resolution`,
          headers: { "idempotency-key": "resolution-no-platform-permission" },
          payload: resolutionPayload(),
        })
      ).statusCode,
    ).toBe(403);
    expect(noPlatformPermission.repository.resolve).not.toHaveBeenCalled();

    const anonymous = await setup(null);
    expect(
      (
        await anonymous.app.inject({
          method: "POST",
          url: "/affiliate-discrepancies/not-a-uuid/resolution",
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });
});

function validPayload() {
  return {
    kind: "earning",
    agreementId: id(4),
    propertyId: id(5),
    bookingId: id(6),
    payoutId: null,
    message: "Missing commission",
    evidenceReferences: ["creator-note-1"],
  };
}

function resolutionPayload() {
  return {
    propertyId: id(5),
    decision: "denied",
    reason: "Attribution evidence does not support the claim",
    evidenceReferences: ["review-note-1516"],
  };
}

async function setup(context: RequestContext | null) {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", (request, _reply, done) => {
    request.authContext = context;
    done();
  });
  const repository = {
    submit: vi
      .fn<AffiliateDiscrepancyRepository["submit"]>()
      .mockResolvedValue({ claim, replayed: false }),
    list: vi.fn<AffiliateDiscrepancyRepository["list"]>().mockResolvedValue([claim]),
    get: vi.fn<AffiliateDiscrepancyRepository["get"]>().mockResolvedValue(claim),
    resolve: vi
      .fn<AffiliateDiscrepancyRepository["resolve"]>()
      .mockResolvedValue({ ok: true, claim: { ...claim, status: "denied" }, replayed: false }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  await app.register(registerMarketplaceAffiliateDiscrepancyRoutes, { repository });
  return { app, repository };
}

function creator(): RequestContext {
  return context(
    "creator_workspace",
    id(1),
    ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    [
      {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: id(2),
        relationship: "owner",
        status: "active",
      },
      {
        product: "affiliate",
        resourceType: "affiliate",
        resourceId: "affiliate-1516",
        relationship: "owner",
        status: "active",
      },
    ],
  );
}
function context(
  kind: RequestContext["selectedOrganization"]["kind"],
  organizationId: string,
  permissions: RequestContext["membership"]["permissions"],
  linkedResources: RequestContext["linkedResources"],
): RequestContext {
  return {
    actor: {
      internalUserId: id(3),
      status: "active",
      email: "test@example.test",
      providerIdentity: { provider: "workos", providerUserId: "workos-1516" },
    },
    selectedOrganization: { organizationId, kind, status: "active" },
    membership: {
      membershipId: id(8),
      status: "active",
      roleKey: "owner",
      permissions,
      workosRoleSlugs: [],
    },
    linkedResources,
    entitlements: [],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request-1516", source: "api", receivedAt: "2026-09-29T00:00:00.000Z" },
  };
}
