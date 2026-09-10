import { AFFILIATE_TRACKING_PURPOSES } from "@vayada/domain-booking";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import { buildApp } from "./app.js";
import { type IdentityRepository, type RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMarketplaceAffiliateDestinationRoutes } from "./routes/marketplaceAffiliateDestinations.js";
import type { AffiliateDestinationRepository } from "./domains/bookingAffiliateDestinationRepository.js";
const propertyId = "15010000-0000-4000-8000-000000000003";
const versionId = "15010000-0000-4000-8000-000000000002";
const path = `/properties/${propertyId}/affiliate-destinations`;
const headers = { authorization: "Bearer valid", "idempotency-key": "request-1" };
const endpoints = [
  { method: "GET" as const, url: `${path}/${versionId}` },
  {
    method: "POST" as const,
    url: path,
    payload: { displayName: "Hotel", bookingUrl: "https://booking.example.com/" },
  },
];
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup(mutate: (c: RequestContext) => void = () => {}, authFailure = false) {
  const repository = {
    list: vi.fn<AffiliateDestinationRepository["list"]>().mockResolvedValue({ destinations: [] }),
    save: vi
      .fn<AffiliateDestinationRepository["save"]>()
      .mockResolvedValue({ ok: true, destinationVersionId: versionId, replayed: false }),
    get: vi.fn<AffiliateDestinationRepository["get"]>().mockResolvedValue(null),
    close: vi.fn<AffiliateDestinationRepository["close"]>().mockResolvedValue(undefined),
  };
  const app = authFailure
    ? buildApp({
        logger: false,
        marketplaceAffiliateDestinationRepository: repository,
        auth: {
          propertyAccessRepository: agencyPropertyAccessRepository,
          rolePermissionRepository: { findPermissionsForRole: async () => [] },
          verifier: async () => {
            throw Object.assign(new Error("database unavailable"), { code: "53300" });
          },
          repository: {} as IdentityRepository,
        },
      })
    : Fastify();
  apps.push(app);
  if (!authFailure) {
    app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request) => {
      if (request.headers.authorization !== "Bearer valid") return;
      const context = {
        actor: { internalUserId: "actor-1", status: "active" },
        membership: { status: "active", permissions: ["marketplace.profile.manage"] },
        selectedOrganization: {
          organizationId: "hotel-org",
          kind: "hotel_group",
          status: "active",
        },
        linkedResources: [
          {
            product: "marketplace",
            resourceType: "hotel_profile",
            resourceId: propertyId,
            relationship: "owner",
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
  }
  if (!authFailure)
    await app.register(registerMarketplaceAffiliateDestinationRoutes, { repository });
  return { app, repository };
}
describe("Marketplace affiliate destination HTTP", () => {
  it("passes authorized scope to save and scoped reads", async () => {
    const { app, repository } = await setup();
    expect((await app.inject({ ...endpoints[1]!, headers })).statusCode).toBe(201);
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId,
        configuration: endpoints[1]!.payload,
        idempotencyKey: "request-1",
      }),
    );
    expect((await app.inject({ ...endpoints[0]!, headers })).statusCode).toBe(404);
    expect(repository.get).toHaveBeenCalledWith(propertyId, "hotel-org", versionId);
    expect((await app.inject({ method: "GET", url: path, headers })).json()).toEqual({
      destinations: [],
    });
    expect(repository.list).toHaveBeenCalledWith(propertyId, "hotel-org");
  });
  it("keeps upstream authentication infrastructure failures uncached", async () => {
    const { app } = await setup(undefined, true);
    for (const endpoint of [...endpoints, { method: "GET" as const, url: path }]) {
      const response = await app.inject({
        ...endpoint,
        url: `/api/marketplace${endpoint.url}`,
        headers,
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });
  it("denies absent or invalid authentication on every endpoint", async () => {
    const { app, repository } = await setup();
    for (const authorization of [undefined, "Bearer invalid"])
      for (const endpoint of [...endpoints, { method: "GET" as const, url: path }]) {
        const result = await app.inject({
          ...endpoint,
          headers: authorization ? { authorization } : {},
        });
        expect(result.statusCode).toBe(401);
        expect(result.headers["cache-control"]).toBe("no-store");
      }
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.get).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
  });
  it("denies permission, entitlement, resource and inactive identity failures before repository access", async () => {
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
        c.linkedResources = [];
      },
      (c: RequestContext) => {
        c.linkedResources[0]!.relationship = "front_desk";
      },
      (c: RequestContext) => {
        c.actor.status = "suspended";
      },
      (c: RequestContext) => {
        c.membership.status = "inactive";
      },
      (c: RequestContext) => {
        c.selectedOrganization.status = "suspended";
      },
      (c: RequestContext) => {
        c.selectedOrganization.kind = "creator_workspace";
      },
    ]) {
      const { app, repository } = await setup(mutate);
      for (const endpoint of [...endpoints, { method: "GET" as const, url: path }])
        expect((await app.inject({ ...endpoint, headers })).statusCode).toBe(403);
      expect(repository.save).not.toHaveBeenCalled();
      expect(repository.get).not.toHaveBeenCalled();
      expect(repository.list).not.toHaveBeenCalled();
    }
  });
  it("requires bounded unique retry keys and valid resource IDs", async () => {
    const { app, repository } = await setup();
    for (const key of [undefined, " ", "a".repeat(201), ["one", "two"]])
      for (const endpoint of endpoints.slice(1)) {
        const response = await app.inject({
          ...endpoint,
          headers: { authorization: "Bearer valid", ...(key ? { "idempotency-key": key } : {}) },
        });
        expect(response.statusCode).toBe(422);
      }
    expect((await app.inject({ method: "GET", url: `${path}/bad`, headers })).statusCode).toBe(422);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/properties/15010000-0000-4000-8000-000000000099/affiliate-destinations/${versionId}`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.get).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
  });
  it("maps replay and conflicts and keeps storage failures uncached", async () => {
    const { app, repository } = await setup();
    for (const [code, status] of [
      ["invalid_request", 422],
      ["scope_unavailable", 404],
      ["idempotency_conflict", 409],
    ] as const) {
      repository.save.mockResolvedValue({ ok: false, code });
      const result = await app.inject({ ...endpoints[1]!, headers });
      expect(result.statusCode).toBe(status);
      expect(result.headers["cache-control"]).toBe("no-store");
    }
    repository.save.mockResolvedValue({
      ok: true,
      destinationVersionId: versionId,
      replayed: true,
    });
    expect((await app.inject({ ...endpoints[1]!, headers })).statusCode).toBe(200);
    repository.get.mockResolvedValue({
      destinationVersionId: versionId,
      configuration: { displayName: "Hotel", bookingUrl: "https://booking.example.com/" },
      createdAt: new Date(),
      trackingStatus: "not_validated",
      trackingReadiness: { status: "pending", missing: [...AFFILIATE_TRACKING_PURPOSES] },
    });
    expect((await app.inject({ ...endpoints[0]!, headers })).json()).toMatchObject({
      trackingStatus: "not_validated",
      trackingReadiness: { status: "pending", missing: [...AFFILIATE_TRACKING_PURPOSES] },
    });
    repository.get.mockRejectedValue(new Error("database unavailable"));
    const failed = await app.inject({ ...endpoints[0]!, headers });
    expect(failed.statusCode).toBe(500);
    expect(failed.headers["cache-control"]).toBe("no-store");
  });
});
