/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parsePublicBookingQuote, type PublicBookingQuoteRequest } from "@vayada/domain-booking/replacement-pricing";
import { requestReplacementQuote } from "./replacementQuote";
import { resetServerClock } from "@/lib/serverClock";
const request: PublicBookingQuoteRequest = {
  version: "public-booking-quote-request.v1", paymentMethod: "pay_at_property",
  selection: { version: "public-pricing-selection.v1", checkIn: "2026-10-01", checkOut: "2026-10-03", currency: "EUR", promoCode: null, addons: [], rooms: [
    { selectionId: "one", publicOfferKey: `pricing-offer.v2:${"a".repeat(64)}`, guests: { adults: 2, childAgesAtCheckIn: [7] } },
    { selectionId: "two", publicOfferKey: `pricing-offer.v2:${"b".repeat(64)}`, guests: { adults: 1, childAgesAtCheckIn: [] } },
  ] },
};
const reply = () => ({
  acceptanceMode: "instant", version: "public-booking-quote.v1", quoteId: "11111111-1111-4111-8111-111111111111", replayed: false,
  checkIn: request.selection.checkIn, checkOut: request.selection.checkOut, currency: "EUR", paymentMethod: "pay_at_property",
  issuedAt: "2026-09-14T12:00:00.000Z", expiresAt: "2026-09-14T12:05:00.000Z", totalMinor: "20600", dueNowMinor: "0", dueLaterMinor: "20600",
  lines: [{ kind: "room", selectionId: "one", amountMinor: "15000" }, { kind: "room", selectionId: "two", amountMinor: "10000" }, { kind: "discount", selectionId: null, amountMinor: "4400" }],
  rooms: ["one", "two"].map(selectionId => ({ selectionId, mealPlan: "room_only", cancellation: { kind: "non_refundable" }, payment: { kind: "full", acceptedMethods: ["pay_at_property"] } })),
});
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  sessionStorage.clear(); resetServerClock(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-14T12:01:00.000Z"));
  vi.stubGlobal("fetch", fetcher); fetcher.mockReset();
  fetcher.mockImplementation(async () => new Response(JSON.stringify(reply()), { status: 200 }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const sentKey = (index: number) => (fetcher.mock.calls[index]![1]!.headers as Record<string, string>)["Idempotency-Key"];

it("sends exact age-aware input and keeps money as minor-unit strings", async () => {
  const result = await requestReplacementQuote("hotel/name", request);
  expect(fetcher.mock.calls[0]![0]).toBe("/api/booking-web/hotels/hotel%2Fname/bookings/quote");
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual(request);
  expect(fetcher.mock.calls[0]![1]?.cache).toBe("no-store");
  expect(result.totalMinor).toBe("20600");
  expect(result.rooms.map(room => room.selectionId)).toEqual(["one", "two"]);
});
it("retains uncertain retry keys and separates slug, guests, offers and payment", async () => {
  fetcher.mockRejectedValueOnce(new Error("network"));
  await expect(requestReplacementQuote("hotel", request)).rejects.toThrow("network");
  await requestReplacementQuote("hotel", request);
  expect(sentKey(1)).toBe(sentKey(0));
  await requestReplacementQuote("other", request);
  expect(sentKey(2)).not.toBe(sentKey(1));
  for (const change of [
    { ...request, paymentMethod: "card" as const },
    { ...request, selection: { ...request.selection, rooms: request.selection.rooms.map(room => ({ ...room, publicOfferKey: `pricing-offer.v2:${"c".repeat(64)}` })) } },
    { ...request, selection: { ...request.selection, rooms: request.selection.rooms.map(room => ({ ...room, guests: { ...room.guests, childAgesAtCheckIn: [8] } })) } },
  ]) await requestReplacementQuote("hotel", change).catch(() => {});
  expect(new Set([sentKey(1), sentKey(2), sentKey(3), sentKey(4), sentKey(5)]).size).toBe(5);
});
it("rejects expired historical replies and rotates the next retry key", async () => {
  // A replay keeps its original issue time, so it doesn't vouch for the server's clock.
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...reply(), replayed: true }), { status: 200 }));
  vi.setSystemTime(new Date("2026-09-14T12:06:00.000Z"));
  await expect(requestReplacementQuote("hotel", request)).rejects.toThrow("expired");
  await expect(requestReplacementQuote("hotel", request)).rejects.toThrow("expired");
  expect(sentKey(0)).not.toBe(sentKey(1));
});
it("propagates cancellation without returning a late response", async () => {
  const controller = new AbortController();
  fetcher.mockImplementationOnce(async () => { controller.abort(); return new Response(JSON.stringify(reply())); });
  await expect(requestReplacementQuote("hotel", request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher.mock.calls[0]![1]?.signal).toBe(controller.signal);
});
it("rejects mismatched money, selection, terms and private payloads", () => {
  for (const invalid of [
    { ...reply(), currency: "USD" }, { ...reply(), checkIn: "2026-10-02" }, { ...reply(), paymentMethod: "card" },
    { ...reply(), quoteId: "invalid" }, { ...reply(), expiresAt: "invalid" },
    { ...reply(), totalMinor: "206.00" }, { ...reply(), dueNowMinor: "1" }, { ...reply(), calculation: {} },
    { ...reply(), rooms: [reply().rooms[0], reply().rooms[0]] },
    { ...reply(), rooms: reply().rooms.map(room => ({ ...room, payment: { kind: "deposit", basisPoints: 3000 } })) },
    { ...reply(), rooms: reply().rooms.map(room => ({ ...room, cancellation: { kind: "flexible", terms: {} } })) },
    { ...reply(), lines: [{ kind: "charge", selectionId: null, amountMinor: "20600" }] },
    { ...reply(), lines: [{ kind: "room", selectionId: "foreign", amountMinor: "20600" }] },
  ]) expect(parsePublicBookingQuote(invalid, request)).toBeNull();
});
it("preserves exact large amounts without floating point rounding", () => {
  const result = parsePublicBookingQuote({ ...reply(), totalMinor: "9007199254740993", dueLaterMinor: "9007199254740993", lines: [
    { kind: "room", selectionId: "one", amountMinor: "9007199254740992" },
    { kind: "room", selectionId: "two", amountMinor: "1" },
  ] }, request);
  expect(result?.totalMinor).toBe("9007199254740993");
});

it("does not let a late expired response invalidate a newer retry key", async () => {
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  const late = requestReplacementQuote("hotel", request);
  await requestReplacementQuote("hotel", request);
  vi.setSystemTime(new Date("2026-09-14T12:06:00.000Z"));
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...reply(), issuedAt: "2026-09-14T12:06:00.000Z", expiresAt: "2026-09-14T12:11:00.000Z" })));
  await requestReplacementQuote("hotel", request);
  expect(sentKey(2)).not.toBe(sentKey(0));
  finish(new Response(JSON.stringify(reply())));
  await expect(late).rejects.toThrow("expired");
  await requestReplacementQuote("hotel", request);
  expect(sentKey(3)).toBe(sentKey(2));
});

it("requires an explicit confirmation mode without inferring an instant booking", () => {
  for (const acceptanceMode of ["instant", "request"])
    expect(parsePublicBookingQuote({ ...reply(), acceptanceMode }, request)?.acceptanceMode).toBe(acceptanceMode);
  const missing = { ...reply() };
  Reflect.deleteProperty(missing, "acceptanceMode");
  expect(parsePublicBookingQuote(missing, request)).toBeNull();
  for (const acceptanceMode of [undefined, null, "automatic", true])
    expect(parsePublicBookingQuote({ ...reply(), acceptanceMode }, request)).toBeNull();
});


it("rotates only the exact refresh-required request key, preserving newer and uncertain attempts", async () => {
  const stale = () => new Response(JSON.stringify({ code: "QUOTE_REFRESH_REQUIRED" }), { status: 409 });
  let late!: (value: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { late = resolve; }));
  const old = requestReplacementQuote("hotel", request);
  const oldRejected = expect(old).rejects.toMatchObject({ status: 409 });
  fetcher.mockResolvedValueOnce(stale());
  await expect(requestReplacementQuote("hotel", request)).rejects.toMatchObject({ status: 409 });
  expect(sentKey(0)).toBe(sentKey(1));
  await requestReplacementQuote("hotel", request);
  expect(sentKey(2)).not.toBe(sentKey(0));
  late(stale());
  await oldRejected;
  await requestReplacementQuote("hotel", request);
  expect(sentKey(3)).toBe(sentKey(2));
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: "OTHER_CONFLICT" }), { status: 409 }));
  await expect(requestReplacementQuote("hotel", request)).rejects.toMatchObject({ status: 409 });
  await requestReplacementQuote("hotel", request);
  expect(sentKey(5)).toBe(sentKey(4));
});

it.each([
  ["1 s behind", -1000],
  ["2 min behind", -120_000],
  ["1 s ahead", 1000],
  ["2 min ahead", 120_000],
  ["6 min ahead", 360_000],
])("accepts a fresh quote when the device clock is %s, and expires it on the server's clock (VAY-2134)", async (_label, skew) => {
  const issued = Date.parse(reply().issuedAt);
  vi.setSystemTime(issued + skew);
  await expect(requestReplacementQuote("hotel", request)).resolves.toMatchObject({ quoteId: reply().quoteId });
  vi.setSystemTime(Date.parse(reply().expiresAt) + skew);
  await expect(requestReplacementQuote("hotel", request)).rejects.toThrow("expired");
});

it("keeps the server clock across a reload, so a replayed quote is judged on it (VAY-2134)", async () => {
  // The device is 6 minutes ahead; a fresh quote calibrates the server clock.
  vi.setSystemTime(Date.parse(reply().issuedAt) + 360_000);
  await requestReplacementQuote("hotel", request);
  // After a reload the same checkout key replays the quote with its original timestamps.
  resetServerClock();
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...reply(), replayed: true }), { status: 200 }));
  await expect(requestReplacementQuote("hotel", request)).resolves.toMatchObject({ replayed: true });
  expect(sentKey(1)).toBe(sentKey(0));
  // Without the saved estimate the device clock would call the quote expired.
  sessionStorage.clear();
  resetServerClock();
  await expect(requestReplacementQuote("hotel", request)).rejects.toThrow("expired");
});
