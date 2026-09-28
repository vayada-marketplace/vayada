import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AffiliatePublicationInput,
  AffiliatePublicationResult,
} from "./domains/marketplaceAffiliatePublication.js";
import { registerMarketplaceAffiliatePublicationRoutes } from "./routes/marketplaceAffiliatePublication.js";

const propertyId = "15010000-0000-4000-8000-000000000003";
const offerId = "15010000-0000-4000-8000-000000000002";
const draftId = "15010000-0000-4000-8000-000000000004";
const path = `/properties/${propertyId}/offers/${offerId}/affiliate-publications`;
const headers = { authorization: "Bearer valid", "idempotency-key": "publish-1" };
const payload = { draftId, expectedRevision: 2 };
const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function context(): RequestContext {
  return {
    actor: {
      internalUserId: "actor-1",
      status: "active",
      email: "owner@example.test",
      providerIdentity: { provider: "workos", providerUserId: "user-test" },
    },
    membership: {
      membershipId: "membership-1",
      workosRoleSlugs: [],
      status: "active",
      permissions: ["marketplace.profile.manage"],
      roleKey: "owner",
    },
    selectedOrganization: { organizationId: "hotel-org", kind: "hotel_group", status: "active" },
    linkedResources: [
      {
        product: "marketplace",
        resourceType: "hotel_profile",
        resourceId: propertyId,
        relationship: "owner",
        status: "active",
      },
      {
        product: "marketplace",
        resourceType: "marketplace_offer",
        resourceId: offerId,
        relationship: "operator",
        status: "active",
      },
    ],
    entitlements: [{ product: "marketplace", key: "marketplace-hotel-profile", status: "active" }],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request-1", source: "api", receivedAt: "2026-09-28T12:00:00Z" },
  };
}

async function setup(mutate: (value: RequestContext) => void = () => {}) {
  const publish = vi
    .fn<(input: AffiliatePublicationInput) => Promise<AffiliatePublicationResult>>()
    .mockResolvedValue({
      ok: true,
      termsVersionId: "terms-1",
      programId: "program-1",
      replayed: false,
    });
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid") return;
    const value = context();
    mutate(value);
    request.authContext = value;
  });
  await app.register(registerMarketplaceAffiliatePublicationRoutes, { publish });
  return { app, publish };
}

describe("hotel affiliate publication HTTP command", () => {
  it("publishes the exact authorized scope and maps a retry", async () => {
    const { app, publish } = await setup();
    const created = await app.inject({ method: "POST", url: path, headers, payload });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.json()).toEqual({
      ok: true,
      termsVersionId: "terms-1",
      programId: "program-1",
      replayed: false,
    });
    expect(publish).toHaveBeenCalledWith({
      context: expect.objectContaining({
        selectedOrganization: expect.objectContaining({ organizationId: "hotel-org" }),
      }),
      propertyId,
      offerId,
      draftId,
      expectedRevision: 2,
      idempotencyKey: "publish-1",
    });
    publish.mockResolvedValue({
      ok: true,
      termsVersionId: "terms-1",
      programId: "program-1",
      replayed: true,
    });
    expect((await app.inject({ method: "POST", url: path, headers, payload })).statusCode).toBe(
      200,
    );
  });

  it("denies auth, permission, entitlement, identity and linked scope before publication", async () => {
    const missing = await setup();
    expect((await missing.app.inject({ method: "POST", url: path, payload })).statusCode).toBe(401);
    expect(missing.publish).not.toHaveBeenCalled();
    for (const mutate of [
      (c: RequestContext) => (c.membership.permissions = []),
      (c: RequestContext) => (c.entitlements = []),
      (c: RequestContext) => (c.entitlements[0]!.status = "suspended"),
      (c: RequestContext) => c.linkedResources.pop(),
      (c: RequestContext) => c.linkedResources.shift(),
      (c: RequestContext) => (c.actor.status = "suspended"),
      (c: RequestContext) => (c.membership.status = "inactive"),
      (c: RequestContext) => (c.selectedOrganization.kind = "creator_workspace"),
      (c: RequestContext) => (c.selectedOrganization.status = "suspended"),
    ]) {
      const { app, publish } = await setup(mutate);
      expect((await app.inject({ method: "POST", url: path, headers, payload })).statusCode).toBe(
        403,
      );
      expect(publish).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed identity, body and retry keys before publication", async () => {
    const { app, publish } = await setup();
    for (const request of [
      { url: path, headers: { authorization: "Bearer valid" }, payload },
      {
        url: path,
        headers: { ...headers, "content-type": "application/json" },
        payload: "null",
      },
      { url: path, headers, payload: { ...payload, organizationId: "other" } },
      { url: path, headers, payload: { draftId, expectedRevision: "2" } },
      { url: `/properties/not-a-uuid/offers/${offerId}/affiliate-publications`, headers, payload },
    ])
      expect((await app.inject({ method: "POST", ...request })).statusCode).toBe(422);
    expect(publish).not.toHaveBeenCalled();
  });

  it("maps private scope absence separately from conflicts and invalid requests", async () => {
    const { app, publish } = await setup();
    for (const [code, status] of [
      ["invalid_request", 422],
      ["scope_unavailable", 404],
      ["offer_not_verified", 409],
      ["revision_conflict", 409],
      ["publication_blocked", 409],
      ["idempotency_conflict", 409],
      ["draft_already_published", 409],
      ["policy_unavailable", 409],
      ["destination_unavailable", 409],
      ["attribution_window_exceeds_limit", 409],
    ] as const) {
      publish.mockResolvedValue({ ok: false, code });
      const response = await app.inject({ method: "POST", url: path, headers, payload });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ ok: false, code });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });
});
