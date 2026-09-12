import { clearAuthData, setAuthKitSession } from "../auth/sessionStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplacementPricingClient, PricingResponseError, type PricingSnapshot, type PricingDraft, type PricingChargeReview } from "./replacementPricingClient";
import { ApiClient, ApiErrorResponse } from "./client";
const id = "61000000-0000-4000-8000-000000000001", draftId = "61000000-0000-4000-8000-000000000002";
const token = "a".repeat(64), sources = { room: `pms.pricing.rooms.v2:${token}`, terms: `booking.pricing.terms.v2:${token}`, finance: `finance.pricing.source.v2:${token}` };
const snapshot: PricingSnapshot = { currency: "EUR", ownerReferences: { finance: `finance.pricing.v2:${token}` }, rooms: [{ version: "pricing.v2", propertyId: id,
  roomTypeId: id, revision: 1, currency: "EUR", capacity: { total: 2, adults: 2, children: 0 },
  children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }] },
  offers: [{ id: "flex", termsRevision: draftId, meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
    price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "10000" }, months: [], seasons: [], weekdays: [], dates: [] } },
    restrictions: { kind: "own", rules: { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] } }],
}] };
const draft: PricingDraft = { draftId, snapshot, sources, revision: 1, baseRevision: 0, stale: false };
const review: PricingChargeReview = { ...draft, fingerprint: token, declaration: "all_mandatory_charges_included" };
const http = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
const client = () => createReplacementPricingClient(id, http);
beforeEach(() => vi.resetAllMocks());
afterEach(() => { vi.unstubAllGlobals(); clearAuthData(); });
describe("replacement pricing browser workflow", () => {
  it("prepares and saves a draft without confirming or publishing and validates the returned version", async () => {
    const api = client(), input = { currency: "EUR", rooms: snapshot.rooms };
    http.post.mockResolvedValue({ sources, snapshot });
    expect(await api.prepare(input)).toEqual({ sources, snapshot });
    http.put.mockResolvedValue({ revision: 1 });
    expect(await api.saveDraft({ draftId, baseRevision: 0, expectedDraftRevision: 0, sources, snapshot })).toBe(1);
    const [url, body, options] = http.put.mock.calls[0];
    expect(url).toBe(`/api/pms/properties/${id}/pricing-v2/drafts/${draftId}`);
    expect(body).toEqual({ baseRevision: 0, expectedDraftRevision: 0, sources, snapshot });
    expect(new Headers(options.headers).get("X-Vayada-Omit-Hotel-Context")).toBe("true"); expect(options.cache).toBe("no-store");
    expect(http.post).toHaveBeenCalledTimes(1);
    http.put.mockResolvedValue({ revision: 99 });
    await expect(api.saveDraft({ draftId, baseRevision: 0, expectedDraftRevision: 0, sources, snapshot })).rejects.toBeInstanceOf(PricingResponseError);
  });
  it("reads exact saved data and only expected missing responses become null", async () => {
    const api = client(), stored = { snapshot, sources, revision: 1, baseRevision: 0, stale: false };
    http.get.mockResolvedValue(stored); expect(await api.readDraft(draftId)).toEqual(draft);
    http.get.mockResolvedValue(review); expect(await api.reviewCharges(draftId)).toEqual(review);
    expect(http.post).not.toHaveBeenCalled();
    http.get.mockResolvedValue({ ...snapshot, revision: 1, sources, stale: false }); expect(await api.read()).toMatchObject({ revision: 1 });
    http.get.mockRejectedValue(new ApiErrorResponse(404, { code: "not_found" })); expect(await api.read()).toBeNull();
    for (const error of [new ApiErrorResponse(403, { code: "denied" }), new ApiErrorResponse(409, { code: "stale" }), new ApiErrorResponse(404, { code: "other" })]) {
      http.get.mockRejectedValue(error); await expect(api.readDraft(draftId)).rejects.toBe(error);
    }
  });
  it("rejects foreign, malformed and inconsistent server data", async () => {
    for (const value of [{ ...snapshot, rooms: snapshot.rooms.map((room) => ({ ...room, propertyId: draftId })) },
      { ...snapshot, ownerReferences: { ...snapshot.ownerReferences, extra: "unverified" } },
      { ...snapshot, currency: "USD" }, { ...snapshot, rooms: [null] }]) {
      http.get.mockResolvedValue({ snapshot: value, revision: 1, baseRevision: 0, sources, stale: false });
      await expect(client().readDraft(draftId)).rejects.toBeInstanceOf(PricingResponseError);
    }
    for (const value of [{ ...review, draftId: id }, { ...review, stale: true }, { ...review, fingerprint: "fake" },
      { ...review, sources: { ...sources, extra: "value" } }, { ...review, baseRevision: 2 }, { ...review, declaration: "automatic" }]) {
      http.get.mockResolvedValue(value); await expect(client().reviewCharges(draftId)).rejects.toBeInstanceOf(PricingResponseError);
    }
  });
  it("accepts harmless object-key order but rejects changed prepared prices or automatic charges", async () => {
    http.post.mockResolvedValue({ snapshot, sources });
    await expect(client().prepare({ rooms: snapshot.rooms, currency: "EUR" })).resolves.toEqual({ snapshot, sources });
    for (const changed of [{ ...snapshot, ownerReferences: { ...snapshot.ownerReferences, charges: id } },
      { ...snapshot, rooms: snapshot.rooms.map((room) => ({ ...room, capacity: { ...room.capacity, adults: 1 } })) }]) {
      http.post.mockResolvedValue({ snapshot: changed, sources });
      await expect(client().prepare({ currency: "EUR", rooms: snapshot.rooms })).rejects.toBeInstanceOf(PricingResponseError);
    }
  });
  it("captures confirmation evidence once and retries the same request without auto-publication", async () => {
    const input = structuredClone(review), action = client().confirmationAction(input);
    expect(http.post).not.toHaveBeenCalled(); input.fingerprint = "b".repeat(64); input.revision = 2;
    const error = new Error("network failure"); http.post.mockRejectedValueOnce(error).mockResolvedValue({ id, fingerprint: token, declaration: review.declaration });
    await expect(action()).rejects.toBe(error); expect(await action()).toMatchObject({ id, fingerprint: token });
    const [first, second] = http.post.mock.calls;
    expect(first[0]).toBe(`/api/pms/properties/${id}/pricing-v2/charges`); expect(second[1]).toEqual(first[1]);
    expect(first[1]).toEqual({ draftId, expectedDraftRevision: 1, claimedFingerprint: token, declaration: review.declaration });
    expect(new Headers(first[2].headers).get("Idempotency-Key")).toBe(new Headers(second[2].headers).get("Idempotency-Key"));
    expect(http.put).not.toHaveBeenCalled();
  });
  it("requires a confirmed saved draft and retains exact publication inputs on retry", async () => {
    expect(() => client().publicationAction(draft)).toThrow(PricingResponseError);
    const input = { ...structuredClone(draft), snapshot: { ...structuredClone(snapshot), ownerReferences: { ...snapshot.ownerReferences, charges: id } } };
    expect(() => client().publicationAction({ ...input, stale: true })).toThrow(PricingResponseError);
    const action = client().publicationAction(input); input.revision = 9; input.sources.finance = "changed";
    http.post.mockRejectedValueOnce(new Error("lost response")).mockResolvedValue({ revision: 1, replayed: true });
    await expect(action()).rejects.toThrow("lost response"); expect(await action()).toEqual({ revision: 1, replayed: true });
    const [first, second] = http.post.mock.calls;
    expect(first[0]).toBe(`/api/pms/properties/${id}/pricing-v2/publish`); expect(second[1]).toEqual(first[1]);
    expect(first[1]).toMatchObject({ expectedRevision: 0, sources, draft: { id: draftId, revision: 1 } });
    const requestId = new Headers(first[2].headers).get("Idempotency-Key"); expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Headers(second[2].headers).get("Idempotency-Key")).toBe(requestId);
    http.post.mockResolvedValue({ revision: 2, replayed: false }); await expect(action()).rejects.toBeInstanceOf(PricingResponseError);
  });
  it("rejects successful null reads rather than treating malformed data as missing", async () => {
    http.get.mockResolvedValue(null);
    for (const read of [() => client().read(), () => client().readDraft(draftId), () => client().reviewCharges(draftId)])
      await expect(read()).rejects.toBeInstanceOf(PricingResponseError);
  });
  it("sends stable idempotency and auth headers through the actual transport", async () => {
    setAuthKitSession({ accessToken: "synthetic-token", csrfToken: "synthetic-csrf", user: { id, email: "owner@example.test", status: "active" } });
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("lost response")); vi.stubGlobal("fetch", fetchMock);
    const api = createReplacementPricingClient(id, new ApiClient("https://api.example.test", null));
    const confirm = api.confirmationAction(review);
    await expect(confirm()).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id, fingerprint: token, declaration: review.declaration }), { headers: { "content-type": "application/json" } }));
    await confirm();
    const publish = api.publicationAction({ ...draft, snapshot: { ...snapshot, ownerReferences: { ...snapshot.ownerReferences, charges: id } } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ revision: 1, replayed: false }), { headers: { "content-type": "application/json" } }));
    await publish();
    const firstKey = new Headers(fetchMock.mock.calls[0][1].headers).get("Idempotency-Key"); expect(firstKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("Idempotency-Key")).toBe(firstKey);
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get("Idempotency-Key")).toMatch(/^[a-f0-9-]{36}$/);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toContain(`https://api.example.test/api/pms/properties/${id}/pricing-v2/`);
      expect(new Headers(options.headers).get("Authorization")).toBe("Bearer synthetic-token");
      expect(new Headers(options.headers).has("X-Vayada-Omit-Hotel-Context")).toBe(false);
    }
  });
});
