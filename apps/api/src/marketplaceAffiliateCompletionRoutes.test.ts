import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import { buildApp } from "./app.js";
import { type IdentityRepository, type RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMarketplaceAffiliateCompletionRoutes } from "./routes/marketplaceAffiliateCompletion.js";
import type { AffiliateCompletionRepository } from "./domains/pmsAffiliateCompletionRepository.js";
const propertyId = "15050000-0000-4000-8000-000000000003";
const bookingId = "15050000-0000-4000-8000-000000000010";
const stayItemId = "15050000-0000-4000-8000-000000000011";
const path = `/properties/${propertyId}/bookings/${bookingId}/stay-items/${stayItemId}/affiliate-completion`;
const headers = { authorization: "Bearer valid" };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup(mutate: (c: RequestContext) => void = () => {}, authFailure = false) {
  const repository = {
    read: vi
      .fn<AffiliateCompletionRepository["read"]>()
      .mockResolvedValue({ status: "pending", reason: "completion_unconfirmed" }),
    close: vi.fn<AffiliateCompletionRepository["close"]>().mockResolvedValue(undefined),
  };
  const app = authFailure
    ? buildApp({
        logger: false,
        marketplaceAffiliateCompletionRepository: repository,
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
    await app.register(registerMarketplaceAffiliateCompletionRoutes, { repository });
  return { app, repository };
}

describe("Hotel affiliate completion HTTP read", () => {
  it("passes exact authorized scope and distinguishes pending, completed and unavailable", async () => {
    const { app, repository } = await setup();
    expect((await app.inject({ url: path, headers })).json()).toEqual({
      status: "pending",
      reason: "completion_unconfirmed",
    });
    expect(repository.read).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId,
        bookingId,
        stayItemId,
        context: expect.objectContaining({
          selectedOrganization: expect.objectContaining({ organizationId: "hotel-org" }),
        }),
      }),
    );
    const completed = {
      status: "completed" as const,
      propertyId,
      bookingId,
      stayItemId,
      source: "vayada_pms",
      assertion: "authenticated_hotel_checkout" as const,
      sourceRecordId: "checkout",
      auditEventId: "audit",
      actorUserId: "actor",
      causedByCommandId: "command",
      recordedAt: "2026-01-01T12:00:00Z",
      actualDepartureAt: null,
      hasPendingFlags: true,
    };
    repository.read.mockResolvedValue(completed);
    const response = await app.inject({ url: path, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(completed);
    expect(response.headers["cache-control"]).toBe("no-store");
    repository.read.mockResolvedValue({ status: "pending", reason: "scope_unavailable" });
    const unavailable = await app.inject({ url: path, headers });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).toEqual({ code: "scope_unavailable" });
  });
  it("denies absent/invalid authentication without reading evidence", async () => {
    const { app, repository } = await setup();
    for (const authorization of [undefined, "Bearer invalid"]) {
      const response = await app.inject({
        url: path,
        headers: authorization ? { authorization } : {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(repository.read).not.toHaveBeenCalled();
  });
  it("denies permission, entitlement, scope and inactive identity failures before reads", async () => {
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
        c.linkedResources[0]!.status = "suspended";
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
      const response = await app.inject({ url: path, headers });
      expect(response.statusCode).toBe(403);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(repository.read).not.toHaveBeenCalled();
    }
  });
  it("rejects malformed IDs and does not expose a verification write", async () => {
    const { app, repository } = await setup();
    for (const value of [propertyId, bookingId, stayItemId]) {
      const response = await app.inject({ url: path.replace(value, "invalid"), headers });
      expect(response.statusCode).toBe(422);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(
      (await app.inject({ method: "POST", url: path, headers, payload: { status: "completed" } }))
        .statusCode,
    ).toBe(404);
    expect(repository.read).not.toHaveBeenCalled();
  });
  it("keeps storage and upstream auth failures uncached", async () => {
    const { app, repository } = await setup();
    repository.read.mockRejectedValue(new Error("database unavailable"));
    const failed = await app.inject({ url: path, headers });
    expect(failed.statusCode).toBe(500);
    expect(failed.headers["cache-control"]).toBe("no-store");
    const upstream = await setup(undefined, true);
    const response = await upstream.app.inject({ url: `/api/marketplace${path}`, headers });
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
