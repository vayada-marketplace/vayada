import Fastify from "fastify";
import type { RequestContext } from "@vayada/backend-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerReplacementPricingRoutes, type ReplacementPricingRoutesOptions } from "./routes/replacementPricing.js";
import { PricingStorageError } from "./domains/replacementPricingStore.js";
import { buildApp } from "./app.js";
const id = "61000000-0000-4000-8000-000000000001", draftId = "61000000-0000-4000-8000-000000000002";
const resource = { product: "pms", resourceType: "pms_property", resourceId: id };
const context = { actor: { internalUserId: id }, selectedOrganization: { organizationId: id, kind: "hotel_group" },
  membership: { permissions: ["pms.rooms_rates.read", "pms.rooms_rates.manage"] },
  linkedResources: [{ ...resource, relationship: "owner", status: "active" }],
  entitlements: [{ product: "pms", key: "property-management", status: "active", resource }],
} as RequestContext;
const snapshot = { currency: "EUR", ownerReferences: { finance: "evidence", charges: draftId }, rooms: [{ version: "pricing.v2", propertyId: id,
  roomTypeId: id, revision: 1, currency: "EUR", capacity: { total: 2, adults: 2, children: 0 },
  children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }] },
  offers: [{ id: "flex", termsRevision: draftId, meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
    price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "10000" }, months: [], seasons: [], weekdays: [], dates: [] } },
    restrictions: { kind: "own", rules: { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] } }],
}] };
const sources = { room: "room", terms: "terms", finance: "finance" };
const publish = { expectedRevision: 0, sources, snapshot, draft: { id: draftId, revision: 2 } };
const endpoints = [
  ["GET", "", undefined], ["GET", `/drafts/${draftId}`, undefined],
  ["POST", "/prepare", { currency: "EUR", rooms: snapshot.rooms }],
  ["PUT", `/drafts/${draftId}`, { expectedDraftRevision: 0, baseRevision: 0, sources, snapshot }],
  ["POST", "/charges", { draftId, expectedDraftRevision: 1, claimedFingerprint: "a".repeat(64), declaration: "all_mandatory_charges_included" }],
  ["POST", "/publish", publish],
  ["GET", `/rooms/${id}/offers/flex/terms`, undefined],
  ["PUT", `/rooms/${id}/offers/flex/terms`, { expectedRevision: null, cancellation: { kind: "non_refundable" }, payment: { kind: "full" } }],
  ["GET", `/drafts/${draftId}/charge-review`, undefined],
] as const;
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
async function fixture(auth: RequestContext | null = context) {
  const app = Fastify(); apps.push(app); app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => { if (request.headers.authorization === "Bearer valid") request.authContext = auth; });
  const commands = { readTerms: vi.fn().mockResolvedValue({ revision: draftId }), saveTerms: vi.fn().mockResolvedValue({ revision: draftId }),
    reviewCharges: vi.fn().mockResolvedValue({ fingerprint: "a".repeat(64) }), read: vi.fn().mockResolvedValue(snapshot), readDraft: vi.fn().mockResolvedValue({ snapshot, revision: 2 }),
    prepare: vi.fn().mockResolvedValue({ snapshot, sources }), saveDraft: vi.fn().mockResolvedValue(1),
    confirmCharges: vi.fn().mockResolvedValue({ id: draftId }), publish: vi.fn().mockResolvedValue({ revision: 1, replayed: false }) };
  const factory = vi.fn(() => commands as unknown as ReturnType<ReplacementPricingRoutesOptions["commands"]>);
  await app.register(registerReplacementPricingRoutes, { prefix: "/api/pms", commands: factory });
  return { app, commands, factory, inject: (index: number, body: unknown = endpoints[index][2], headers: Record<string, string> = {}) => app.inject({
    method: endpoints[index][0], url: `/api/pms/properties/${id}/pricing-v2${endpoints[index][1]}`,
    ...(body === undefined ? {} : { payload: body as object }), headers: { authorization: "Bearer valid", "idempotency-key": "request-1", ...headers },
  }) };
}
describe("replacement pricing HTTP boundary", () => {
  it("forwards authorized commands, preserves draft/idempotency binding and wraps draft revisions", async () => {
    const f = await fixture();
    for (let i = 0; i < endpoints.length; i++) expect((await f.inject(i)).statusCode).toBe(200);
    expect(f.factory).toHaveBeenCalledWith(context);
    expect(f.commands.publish).toHaveBeenCalledWith(id, { ...publish, requestId: "request-1" });
    expect(f.commands.confirmCharges).toHaveBeenCalledWith(id, { ...endpoints[4][2], requestId: "request-1" });
    expect((await f.inject(3)).json()).toEqual({ revision: 1 });
    f.commands.publish.mockResolvedValue({ revision: 1, replayed: true });
    expect((await f.inject(5)).json()).toEqual({ revision: 1, replayed: true });
  });
  it("rejects missing/invalid auth before malformed body parsing", async () => {
    const f = await fixture();
    for (const token of ["", "Bearer invalid"]) for (let i = 0; i < endpoints.length; i++)
      expect((await f.inject(i, undefined, { authorization: token })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "POST", url: `/api/pms/properties/${id}/pricing-v2/publish`,
      headers: { "content-type": "application/json" }, payload: "{" })).statusCode).toBe(401);
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("denies missing permission, entitlement, inactive entitlement, missing link and wrong organization", async () => {
    for (const patch of [{ membership: { permissions: [] } }, { entitlements: [] },
      { entitlements: [{ ...context.entitlements[0], status: "suspended" }] }, { linkedResources: [] },
      { selectedOrganization: { ...context.selectedOrganization, kind: "creator" } }]) {
      const f = await fixture({ ...context, ...patch } as RequestContext);
      for (let i = 0; i < endpoints.length; i++) expect((await f.inject(i)).statusCode).toBe(403);
      expect(f.factory).not.toHaveBeenCalled();
    }
    const f = await fixture({ ...context, membership: { ...context.membership!, permissions: ["pms.rooms_rates.read"] } });
    expect((await f.inject(0)).statusCode).toBe(200); expect((await f.inject(2)).statusCode).toBe(403);
  });
  it("rejects extra identity, malformed nested data, missing draft and missing/duplicate idempotency keys", async () => {
    const f = await fixture();
    for (const body of [{ ...publish, actorUserId: id }, { ...publish, requestId: "body-key" }, { ...publish, draft: undefined },
      { ...publish, draft: { ...publish.draft, extra: true } }, { ...publish, snapshot: null }, { ...publish, sources: [] },
      { ...publish, sources: { ...sources, actorUserId: id } }, { ...publish, sources: { room: "room" } },
      { ...publish, snapshot: { ...snapshot, ownerReferences: { ...snapshot.ownerReferences, actorUserId: id } } },
      { ...publish, snapshot: { ...snapshot, ownerReferences: { charges: draftId } } },
      { ...publish, expectedRevision: -1 }, { ...publish, snapshot: { ...snapshot, rooms: [null] } }])
      expect((await f.inject(5, body)).statusCode).toBe(400);
    for (const index of [4, 5, 7]) expect((await f.inject(index, endpoints[index][2], { "idempotency-key": "" })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url: `/api/pms/properties/${id}/pricing-v2/publish`, payload: publish,
      headers: { authorization: "Bearer valid", "idempotency-key": ["a", "b"] } })).statusCode).toBe(400);
    expect(f.commands.publish).not.toHaveBeenCalled();
  });
  it("rejects malformed offer policies and body identity before the Booking command", async () => {
    const f = await fixture(), valid = endpoints[7][2];
    for (const body of [{ ...valid, actorUserId: id }, { ...valid, roomTypeId: id }, { ...valid, expectedRevision: 1 },
      { ...valid, payment: { kind: "deposit", basisPoints: 10001, balanceDaysBeforeArrival: 1 } },
      { ...valid, cancellation: { kind: "non_refundable", extra: true } }]) expect((await f.inject(7, body)).statusCode).toBe(400);
    expect(f.commands.saveTerms).not.toHaveBeenCalled();
    expect((await f.inject(7)).statusCode).toBe(200);
    expect(f.commands.saveTerms).toHaveBeenCalledWith(id, { requestId: "request-1", expectedRevision: null,
      terms: { roomTypeId: id, offerId: "flex", cancellation: valid.cancellation, payment: valid.payment } });
    f.commands.reviewCharges.mockResolvedValue(null);
    expect((await f.inject(8)).statusCode).toBe(404);
    f.commands.reviewCharges.mockRejectedValue(new PricingStorageError("stale"));
    expect((await f.inject(8)).statusCode).toBe(409);
  });
  it("maps domain failures and sanitizes unexpected failures", async () => {
    const f = await fixture();
    for (const [code, status] of [["invalid", 400], ["denied", 403], ["stale", 409], ["idempotency_conflict", 409], ["currency_conversion_required", 409]] as const) {
      f.commands.publish.mockRejectedValue(new PricingStorageError(code));
      const response = await f.inject(5); expect(response.statusCode).toBe(status); expect(response.json()).toEqual({ code });
    }
    f.commands.publish.mockRejectedValue(new Error("secret database detail"));
    const response = await f.inject(5); expect(response.statusCode).toBe(503); expect(response.body).not.toContain("secret");
    f.commands.read.mockResolvedValue(null); expect((await f.inject(0)).statusCode).toBe(404);
  });
  it("registers the protected API only when its runtime is supplied", async () => {
    const disabled = buildApp({ logger: false }); apps.push(disabled);
    expect((await disabled.inject({ url: `/api/pms/properties/${id}/pricing-v2` })).statusCode).toBe(404);
    const enabled = buildApp({ logger: false, replacementPricing: { commands: vi.fn() } }); apps.push(enabled);
    expect((await enabled.inject({ url: `/api/pms/properties/${id}/pricing-v2` })).statusCode).toBe(401);
  });
});
