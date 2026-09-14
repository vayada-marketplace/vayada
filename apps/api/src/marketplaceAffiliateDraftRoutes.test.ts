import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { parseFinanceAffiliatePercentagePolicy } from "@vayada/domain-finance";
import { describe, expect, it, vi } from "vitest";
import { registerMarketplaceAffiliateDraftRoutes } from "./routes/marketplaceAffiliateDrafts.js";
import type { AffiliateDraftRepository } from "./domains/marketplaceAffiliateDraftRepository.js";

const propertyId = "15010000-0000-4000-8000-000000000003";
const offerId = "15010000-0000-4000-8000-000000000002";
const url = `/properties/${propertyId}/offers/${offerId}/affiliate-draft`;
const terms = {
  bookingDestinationId: "destination-1",
  financePolicyVersionId: "policy-1",
  attributionWindowDays: 14,
};
const payload = { expectedRevision: 0, terms };
async function setup(mutate: (c: RequestContext) => void = () => {}) {
  const app = Fastify();
  const read = vi
    .fn<AffiliateDraftRepository["read"]>()
    .mockResolvedValue({ revision: 0, draft: null });
  const save = vi
    .fn<AffiliateDraftRepository["save"]>()
    .mockResolvedValue({ ok: true, draftId: "draft-1", revision: 1, replayed: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid") return;
    const context = {
      actor: { internalUserId: "actor-1", status: "active" },
      membership: { status: "active", permissions: ["marketplace.profile.manage"] },
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
      entitlements: [
        { product: "marketplace", key: "marketplace-hotel-profile", status: "active" },
      ],
      audit: { requestId: "request-1" },
    } as RequestContext;
    mutate(context);
    request.authContext = context;
  });
  await app.register(registerMarketplaceAffiliateDraftRoutes, {
    repository: { read, save, close: async () => {} },
  });
  return { app, read, save };
}
const headers = { authorization: "Bearer valid", "idempotency-key": "save-1" };
describe("hotel affiliate draft HTTP adapter", () => {
  it("returns empty state and forwards only the authorized save scope", async () => {
    const { app, read, save } = await setup();
    try {
      const get = await app.inject({ method: "GET", url, headers });
      expect(get.json()).toEqual({ revision: 0, draft: null });
      expect(read).toHaveBeenCalledWith("hotel-org", propertyId, offerId);
      const put = await app.inject({ method: "PUT", url, headers, payload });
      expect(put.statusCode).toBe(201);
      expect(put.headers["cache-control"]).toBe("no-store");
      expect(save.mock.calls[0]![0]).toMatchObject({
        propertyId,
        offerId,
        terms,
        expectedRevision: 0,
        idempotencyKey: "save-1",
      });
    } finally {
      await app.close();
    }
  });
  it("returns the stored commission resolution and a private policy-unavailable conflict", async () => {
    const { app, read, save } = await setup();
    try {
      for (const commission of [
        {
          status: "available" as const,
          policyVersionId: "policy-1",
          propertyId,
          policy: parseFinanceAffiliatePercentagePolicy({ percentageRate: "12.50" })!,
        },
        { status: "unavailable" as const, reason: "not_found" as const },
      ]) {
        const saved = { revision: 1, draft: { id: "draft-1", terms, commission } };
        read.mockResolvedValue(saved);
        const get = await app.inject({ method: "GET", url, headers });
        expect(get.statusCode).toBe(200);
        expect(get.json()).toEqual(saved);
        expect(get.headers["cache-control"]).toBe("no-store");
      }
      save.mockResolvedValue({ ok: false, code: "policy_unavailable" });
      const put = await app.inject({ method: "PUT", url, headers, payload });
      expect(put.statusCode).toBe(409);
      expect(put.json()).toEqual({ ok: false, code: "policy_unavailable" });
      expect(put.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
  it("denies missing or invalid sessions before accessing either port", async () => {
    const { app, read, save } = await setup();
    try {
      for (const authorization of [undefined, "Bearer invalid"])
        for (const method of ["GET", "PUT"] as const)
          expect(
            (await app.inject({ method, url, headers: authorization ? { authorization } : {} }))
              .statusCode,
          ).toBe(401);
      expect(read).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("denies missing permission, entitlement, linked scope and inactive identities", async () => {
    for (const mutate of [
      (c: RequestContext) => {
        c.membership.permissions = [];
      },
      (c: RequestContext) => {
        c.entitlements = [];
      },
      (c: RequestContext) => {
        c.entitlements[0]!.status = "suspended";
      },
      (c: RequestContext) => {
        c.linkedResources.pop();
      },
      (c: RequestContext) => {
        c.linkedResources.shift();
      },
      (c: RequestContext) => {
        c.actor.status = "suspended";
      },
      (c: RequestContext) => {
        c.selectedOrganization.kind = "creator_workspace";
      },
    ]) {
      const { app, read, save } = await setup(mutate);
      try {
        for (const method of ["GET", "PUT"] as const)
          expect((await app.inject({ method, url, headers })).statusCode).toBe(403);
        expect(read).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });
  it("maps conflicts and replay, rejects body identity and missing retry keys", async () => {
    const { app, read, save } = await setup();
    try {
      for (const body of [{ ...payload, organizationId: "other" }, [], null])
        expect(
          (
            await app.inject({
              method: "PUT",
              url,
              headers: { ...headers, "content-type": "application/json" },
              payload: JSON.stringify(body),
            })
          ).statusCode,
        ).toBe(422);
      expect(
        (
          await app.inject({
            method: "PUT",
            url,
            headers: { authorization: "Bearer valid" },
            payload,
          })
        ).statusCode,
      ).toBe(422);
      expect(save).not.toHaveBeenCalled();
      for (const code of [
        "policy_unavailable",
        "revision_conflict",
        "idempotency_conflict",
        "scope_unavailable",
        "invalid_request",
      ] as const) {
        save.mockResolvedValue({ ok: false, code });
        expect((await app.inject({ method: "PUT", url, headers, payload })).statusCode).toBe(
          code === "scope_unavailable" ? 404 : code === "invalid_request" ? 422 : 409,
        );
      }
      save.mockResolvedValue({ ok: true, draftId: "draft-1", revision: 1, replayed: true });
      expect((await app.inject({ method: "PUT", url, headers, payload })).statusCode).toBe(200);
      read.mockResolvedValue(null);
      expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
