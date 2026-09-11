import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerMarketplaceSubmissionRoutes } from "./routes/marketplaceSubmission.js";
import { MarketplaceSubmissionError } from "./domains/marketplaceSubmissionRepository.js";
const propertyId = "22222222-2222-4222-8222-222222222222";
const organizationId = "11111111-1111-4111-8111-111111111111";
const body = {
  expectedLatestSubmissionRevisionId: null,
  expectedSourceManifestHash: `sha256:${"1".repeat(64)}`,
  expectedReadinessHash: `sha256:${"2".repeat(64)}`,
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});
async function harness(overrides: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer test") return;
    request.authContext = {
      actor: { internalUserId: propertyId },
      selectedOrganization: { organizationId, kind: "hotel_group" },
      membership: { permissions: ["marketplace.profile.manage"] },
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
        {
          product: "marketplace",
          key: "marketplace-hotel-profile",
          status: "active",
          resource: {
            product: "marketplace",
            resourceType: "hotel_profile",
            resourceId: propertyId,
          },
        },
      ],
      audit: {
        requestId: "req",
        correlationId: "corr",
        receivedAt: new Date().toISOString(),
        source: "api",
      },
      ...overrides,
    } as RequestContext;
  });
  const repository = {
    submit: vi.fn().mockResolvedValue({ propertyId, status: "pending" }),
    getReview: vi.fn().mockResolvedValue({
      propertyId,
      contractVersion: "marketplace-submission-review.v1",
      latestSubmission: null,
    }),
  };
  await app.register(registerMarketplaceSubmissionRoutes, { repository });
  return { app, repository };
}
const headers = { authorization: "Bearer test", "idempotency-key": "saved-key" };
it("loads scoped recovery without calling submit and prevents caching", async () => {
  const h = await harness();
  const reply = await h.app.inject({
    method: "GET",
    url: `/properties/${propertyId}/submission-review`,
    headers,
  });
  expect(reply.statusCode).toBe(200);
  expect(reply.headers["cache-control"]).toBe("no-store");
  expect(h.repository.submit).not.toHaveBeenCalled();
  expect(h.repository.getReview).toHaveBeenCalledWith(
    expect.objectContaining({ organizationId, propertyId }),
    "saved-key",
  );
});
it("passes only the authenticated scope and explicit guarded request to submit", async () => {
  const h = await harness();
  const reply = await h.app.inject({
    method: "POST",
    url: `/properties/${propertyId}/submissions`,
    headers,
    payload: body,
  });
  expect(reply.statusCode).toBe(201);
  expect(h.repository.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId,
      propertyId,
      audit: expect.objectContaining({ actor: { kind: "user", userId: propertyId } }),
    }),
    "saved-key",
    body,
  );
});
it.each(["GET", "POST"] as const)("rejects anonymous %s before owner calls", async (method) => {
  const h = await harness();
  const reply = await h.app.inject({
    method,
    url: `/properties/${propertyId}/${method === "GET" ? "submission-review" : "submissions"}`,
    payload: method === "POST" ? body : undefined,
  });
  expect(reply.statusCode).toBe(401);
  expect(h.repository.submit).not.toHaveBeenCalled();
  expect(h.repository.getReview).not.toHaveBeenCalled();
});
it.each([
  { membership: { permissions: [] } },
  { selectedOrganization: { organizationId, kind: "creator_workspace" } },
  { linkedResources: [] },
  { entitlements: [] },
  {
    entitlements: [
      { product: "marketplace", key: "marketplace-hotel-profile", status: "suspended" },
    ],
  },
])("rejects inaccessible scope %j", async (overrides) => {
  const h = await harness(overrides);
  for (const method of ["GET", "POST"] as const) {
    const reply = await h.app.inject({
      method,
      url: `/properties/${propertyId}/${method === "GET" ? "submission-review" : "submissions"}`,
      headers,
      payload: method === "POST" ? body : undefined,
    });
    expect(reply.statusCode).toBe(403);
  }
  expect(h.repository.submit).not.toHaveBeenCalled();
  expect(h.repository.getReview).not.toHaveBeenCalled();
});
it("rejects missing keys and malformed readiness guards", async () => {
  const h = await harness();
  for (const payload of [{ ...body, expectedReadinessHash: "bad" }, {}])
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: `/properties/${propertyId}/submissions`,
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(400);
  expect(
    (
      await h.app.inject({
        method: "POST",
        url: `/properties/${propertyId}/submissions`,
        headers: { authorization: "Bearer test" },
        payload: body,
      })
    ).statusCode,
  ).toBe(400);
  expect(h.repository.submit).not.toHaveBeenCalled();
});
it("returns conflict without manufacturing success and rejects foreign results", async () => {
  const h = await harness();
  h.repository.submit.mockRejectedValue(
    new MarketplaceSubmissionError("submission_revision_conflict"),
  );
  expect(
    (
      await h.app.inject({
        method: "POST",
        url: `/properties/${propertyId}/submissions`,
        headers,
        payload: body,
      })
    ).statusCode,
  ).toBe(409);
  h.repository.getReview.mockResolvedValue({ propertyId: "foreign" });
  expect(
    (
      await h.app.inject({
        method: "GET",
        url: `/properties/${propertyId}/submission-review`,
        headers,
      })
    ).statusCode,
  ).toBe(500);
});

it.each([
  { ...body, expectedLatestSubmissionRevisionId: "" },
  { ...body, expectedSourceManifestHash: [body.expectedSourceManifestHash] },
  { ...body, expectedReadinessHash: [body.expectedReadinessHash] },
  { ...body, organizationId: "foreign" },
])("rejects raw malformed guards without coercing them", async (payload) => {
  const h = await harness();
  const reply = await h.app.inject({
    method: "POST",
    url: `/properties/${propertyId}/submissions`,
    headers,
    payload,
  });
  expect(reply.statusCode).toBe(400);
  expect(h.repository.submit).not.toHaveBeenCalled();
});
