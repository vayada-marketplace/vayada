import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";

import { registerMarketplaceHotelSubmissionModerationRoutes } from "./routes/marketplaceHotelSubmissionModeration.js";

const revisionId = "33333333-3333-4333-8333-333333333333";
const propertyId = "22222222-2222-4222-8222-222222222222";
const adminUserId = "44444444-4444-4444-8444-444444444444";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

const decided = {
  ok: true,
  response: {
    contractVersion: "marketplace-hotel-submission-moderation.v1",
    revisionId,
    propertyId,
    revisionNumber: 1,
    status: "approved",
    note: null,
    decidedByUserId: adminUserId,
    decidedAt: "2026-10-14T10:00:00.000Z",
    publicPath: `/hotels/${propertyId}`,
  },
};

async function harness(context: Partial<RequestContext> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer admin") return;
    request.authContext = {
      actor: { internalUserId: adminUserId },
      selectedOrganization: { organizationId: "org_platform", kind: "platform" },
      membership: { permissions: ["platform.user.suspend"] },
      linkedResources: [
        {
          product: "platform",
          resourceType: "platform",
          resourceId: "vayada",
          relationship: "operator",
          status: "active",
        },
      ],
      entitlements: [
        {
          product: "platform",
          key: "platform-admin",
          status: "active",
          resource: { product: "platform", resourceType: "platform", resourceId: "vayada" },
        },
      ],
      audit: { requestId: "req", correlationId: "corr", receivedAt: "2026-10-14T10:00:00.000Z" },
      ...context,
    } as RequestContext;
  });
  const repository = {
    listPending: vi.fn().mockResolvedValue([{ revisionId, propertyId }]),
    getReview: vi.fn().mockResolvedValue({ revisionId, propertyId, status: "pending" }),
    decide: vi.fn().mockResolvedValue(decided),
  };
  const mediaResolver = vi.fn().mockReturnValue(null);
  await app.register(registerMarketplaceHotelSubmissionModerationRoutes, {
    prefix: "/api/marketplace",
    repository,
    mediaResolver,
  });
  return { app, repository, mediaResolver };
}

const admin = { authorization: "Bearer admin" };

it("lists and reads submissions for Vayada operators without caching", async () => {
  const h = await harness();
  const list = await h.app.inject({
    url: "/api/marketplace/admin/hotel-submissions",
    headers: admin,
  });
  expect(list.statusCode).toBe(200);
  expect(list.headers["cache-control"]).toBe("no-store");
  expect(list.json()).toEqual({
    contractVersion: "marketplace-hotel-submission-moderation.v1",
    submissions: [{ revisionId, propertyId }],
  });
  const read = await h.app.inject({
    url: `/api/marketplace/admin/hotel-submissions/${revisionId.toUpperCase()}`,
    headers: admin,
  });
  expect(read.statusCode).toBe(200);
  expect(read.json().review).toEqual({ revisionId, propertyId, status: "pending" });
  expect(h.repository.getReview).toHaveBeenCalledWith(revisionId, null);

  h.repository.getReview.mockResolvedValueOnce(null);
  const missing = await h.app.inject({
    url: `/api/marketplace/admin/hotel-submissions/${revisionId}`,
    headers: admin,
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().code).toBe("submission_not_found");
});

it("passes the decision, actor and idempotency key to the command", async () => {
  const h = await harness();
  const reply = await h.app.inject({
    method: "POST",
    url: `/api/marketplace/admin/hotel-submissions/${revisionId}/decision`,
    headers: { ...admin, "idempotency-key": "decision-1" },
    payload: { decision: "request_changes", note: "Use a photo of the hotel as the cover." },
  });
  expect(reply.statusCode).toBe(200);
  expect(reply.json()).toEqual(decided.response);
  expect(h.repository.decide).toHaveBeenCalledWith({
    revisionId,
    idempotencyKey: "decision-1",
    request: { decision: "request_changes", note: "Use a photo of the hotel as the cover." },
    audit: {
      actorUserId: adminUserId,
      actorOrganizationId: "org_platform",
      requestId: "req",
      correlationId: "corr",
      requestedAt: "2026-10-14T10:00:00.000Z",
    },
  });
});

it.each([
  [{ decision: "approve" }, {}, "idempotency_required"],
  [{ decision: "reject" }, { "idempotency-key": "k" }, "invalid_decision"],
  [{ decision: "request_changes", note: "" }, { "idempotency-key": "k" }, "invalid_note"],
  [{ decision: "request_changes" }, { "idempotency-key": "k" }, "invalid_decision"],
])("validates before calling the command %#", async (payload, extra, code) => {
  const h = await harness();
  const reply = await h.app.inject({
    method: "POST",
    url: `/api/marketplace/admin/hotel-submissions/${revisionId}/decision`,
    headers: { ...admin, ...extra },
    payload,
  });
  expect(reply.statusCode).toBe(422);
  expect(reply.json().code).toBe(code);
  expect(h.repository.decide).not.toHaveBeenCalled();
});

it("maps command refusals to 404 and 409", async () => {
  const h = await harness();
  for (const [code, status] of [
    ["submission_not_found", 404],
    ["submission_already_decided", 409],
    ["marketplace_entitlement_inactive", 409],
  ] as const) {
    h.repository.decide.mockResolvedValueOnce({ ok: false, error: { code } });
    const reply = await h.app.inject({
      method: "POST",
      url: `/api/marketplace/admin/hotel-submissions/${revisionId}/decision`,
      headers: { ...admin, "idempotency-key": code },
      payload: { decision: "approve" },
    });
    expect(reply.statusCode).toBe(status);
    expect(reply.json().code).toBe(code);
  }
});

it.each([
  ["signed out", {}, 401, false],
  ["missing permission", { membership: { permissions: [] } }, 403, true],
  ["missing platform-admin entitlement", { entitlements: [] }, 403, true],
  ["missing operator link", { linkedResources: [] }, 403, true],
] as const)("refuses %s", async (_label, context, status, signedIn) => {
  const h = await harness(context as Partial<RequestContext>);
  const headers = signedIn ? admin : {};
  const list = await h.app.inject({ url: "/api/marketplace/admin/hotel-submissions", headers });
  const decide = await h.app.inject({
    method: "POST",
    url: `/api/marketplace/admin/hotel-submissions/${revisionId}/decision`,
    headers: { ...headers, "idempotency-key": "k" },
    payload: { decision: "approve" },
  });
  expect([list.statusCode, decide.statusCode]).toEqual([status, status]);
  expect(h.repository.listPending).not.toHaveBeenCalled();
  expect(h.repository.decide).not.toHaveBeenCalled();
});

it("rejects a malformed revision id", async () => {
  const h = await harness();
  const reply = await h.app.inject({
    url: "/api/marketplace/admin/hotel-submissions/not-a-uuid",
    headers: admin,
  });
  expect(reply.statusCode).toBe(422);
  expect(h.repository.getReview).not.toHaveBeenCalled();
});
