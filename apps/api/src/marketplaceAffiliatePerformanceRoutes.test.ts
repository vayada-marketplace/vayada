import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AffiliatePerformanceReadModel } from "./domains/affiliatePerformanceReadModel.js";
import { registerMarketplaceAffiliatePerformanceRoutes } from "./routes/marketplaceAffiliatePerformance.js";

const creatorId = "15120000-0000-4000-8000-000000000080";
const propertyId = "15120000-0000-4000-8000-000000000001";
const now = new Date("2026-09-27T12:00:00.000Z");
const apps: ReturnType<typeof Fastify>[] = [];

describe("Marketplace affiliate performance HTTP", () => {
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("serves creator performance with explicit periods and filters", async () => {
    const { app, repository } = await setup(creatorContext());
    const response = await app.inject({
      method: "GET",
      url: "/affiliate-performance?period=3m&source=unknown&campaign=launch&limit=10",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({
      contractVersion: "affiliate-performance.v1",
      coverage: "available",
    });
    expect(repository.read).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedOrganization: expect.objectContaining({ kind: "creator_workspace" }),
      }),
      expect.objectContaining({
        from: "2026-06-27T12:00:00.000Z",
        to: now.toISOString(),
        source: "unknown",
        campaign: "launch",
        limit: 10,
      }),
    );
  });

  it("requires a selected, authorized hotel property", async () => {
    const allowed = await setup(hotelContext());
    expect(
      (
        await allowed.app.inject({
          method: "GET",
          url: `/affiliate-performance?propertyId=${propertyId}`,
        })
      ).statusCode,
    ).toBe(200);
    const missing = await setup(hotelContext());
    expect(
      (await missing.app.inject({ method: "GET", url: "/affiliate-performance" })).statusCode,
    ).toBe(403);
    const denied = hotelContext();
    denied.membership.permissions = [];
    const deniedApp = await setup(denied);
    expect(
      (
        await deniedApp.app.inject({
          method: "GET",
          url: `/affiliate-performance?propertyId=${propertyId}`,
        })
      ).statusCode,
    ).toBe(403);
    expect(deniedApp.repository.read).not.toHaveBeenCalled();
  });

  it("fails closed for missing auth, missing composition and invalid filters", async () => {
    const unauthenticated = await setup(null);
    expect(
      (await unauthenticated.app.inject({ method: "GET", url: "/affiliate-performance" }))
        .statusCode,
    ).toBe(401);
    const unavailable = Fastify();
    apps.push(unavailable);
    await unavailable.register(registerMarketplaceAffiliatePerformanceRoutes, {});
    const unavailableResponse = await unavailable.inject({
      method: "GET",
      url: "/affiliate-performance",
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.json()).toEqual({ code: "read_model_unavailable" });
    const invalid = await setup(creatorContext());
    for (const query of ["period=2m", "source=direct", "campaign=bad%20label", "limit=51"])
      expect(
        (await invalid.app.inject({ method: "GET", url: `/affiliate-performance?${query}` }))
          .statusCode,
      ).toBe(400);
    expect(invalid.repository.read).not.toHaveBeenCalled();
  });

  it("clamps calendar-month periods at month end", async () => {
    const monthEnd = new Date("2026-03-31T12:00:00.000Z");
    const { app, repository } = await setup(creatorContext(), () => monthEnd);
    expect(
      (await app.inject({ method: "GET", url: "/affiliate-performance?period=1m" })).statusCode,
    ).toBe(200);
    expect(repository.read).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: "2026-02-28T12:00:00.000Z", to: monthEnd.toISOString() }),
    );
  });

  it("keeps the first page period stable while the live clock advances", async () => {
    const clock = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-10-01T00:00:00.000Z"))
      .mockReturnValue(new Date("2026-10-02T00:00:00.000Z"));
    const { app, repository } = await setup(creatorContext(), clock);
    repository.read.mockImplementationOnce(async (_context, input) => ({
      coverage: "available",
      readAt: input.to,
      period: {
        from: input.from,
        to: input.to,
        clickCohort: "clicked_at",
        bookingCohort: "booked_at",
        earningCohort: "latest_outcome_recorded_at",
      },
      filters: { propertyId: null, source: null, campaign: null },
      partnerships: [],
      nextCursor: Buffer.from(
        JSON.stringify(["binding", input.from, input.to, propertyId, creatorId]),
      ).toString("base64url"),
    }));
    const first = await app.inject({ method: "GET", url: "/affiliate-performance?limit=1" });
    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    const second = await app.inject({
      method: "GET",
      url: `/affiliate-performance?limit=1&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(second.statusCode).toBe(200);
    expect(repository.read.mock.calls[1]?.[1]).toMatchObject({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    });
  });
});

async function setup(context: RequestContext | null, clock: () => Date = () => now) {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", (request, _reply, done) => {
    request.authContext = context;
    done();
  });
  const repository = {
    read: vi.fn<AffiliatePerformanceReadModel["read"]>().mockResolvedValue({
      coverage: "available",
      readAt: now.toISOString(),
      period: {
        from: "",
        to: "",
        clickCohort: "clicked_at",
        bookingCohort: "booked_at",
        earningCohort: "latest_outcome_recorded_at",
      },
      filters: { propertyId: null, source: null, campaign: null },
      partnerships: [],
      nextCursor: null,
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  await app.register(registerMarketplaceAffiliatePerformanceRoutes, {
    repository,
    now: clock,
  });
  return { app, repository };
}

function creatorContext() {
  return context("creator_workspace", creatorId, "creator_profile");
}
function hotelContext() {
  const value = context("hotel_group", propertyId, "hotel_profile");
  value.entitlements = [
    {
      product: "marketplace",
      key: "marketplace-hotel-profile",
      status: "active",
      resource: { product: "marketplace", resourceType: "hotel_profile", resourceId: propertyId },
    },
  ];
  return value;
}
function context(
  kind: "creator_workspace" | "hotel_group",
  resourceId: string,
  resourceType: "creator_profile" | "hotel_profile",
): RequestContext {
  return {
    actor: {
      internalUserId: "actor",
      status: "active",
      email: "test@example.test",
      providerIdentity: { provider: "workos", providerUserId: "workos" },
    },
    selectedOrganization: {
      organizationId: "15120000-0000-4000-8000-000000000081",
      kind,
      status: "active",
    },
    membership: {
      membershipId: "membership",
      status: "active",
      roleKey: "owner",
      workosRoleSlugs: [],
      permissions: ["marketplace.collaboration.read"],
    },
    linkedResources: [
      { product: "marketplace", resourceType, resourceId, relationship: "owner", status: "active" },
    ],
    entitlements: [],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request", source: "api", receivedAt: now.toISOString() },
  };
}
