import { afterEach, expect, it, vi } from "vitest";
import {
  displayQuoteMoney,
  getReplacementOffers,
  roomQuoteRequest,
  type PricingRoom,
} from "./replacementOffers";
const key = `pricing-offer.v2:${"a".repeat(64)}`;
const rooms: PricingRoom[] = [
  {
    roomTypeId: "suite",
    name: "Suite",
    offers: [{ publicOfferKey: key, currency: "EUR", mealPlan: "breakfast" }],
  },
];
const choices = () => [
  { selectionId: "one", publicOfferKey: key, adults: "2", childAges: ["0", "7"] },
  { selectionId: "two", publicOfferKey: key, adults: "1", childAges: [] },
];
const make = (choice = choices(), catalog = rooms) =>
  roomQuoteRequest(catalog, choice, "2026-10-01", "2026-10-03", "pay_at_property");
afterEach(() => vi.unstubAllGlobals());
it("preserves explicit infant age and distinct physical rooms with the same offer", () => {
  expect(make()?.selection.rooms).toEqual([
    { selectionId: "one", publicOfferKey: key, guests: { adults: 2, childAgesAtCheckIn: [0, 7] } },
    { selectionId: "two", publicOfferKey: key, guests: { adults: 1, childAgesAtCheckIn: [] } },
  ]);
});
it("rejects unknown ages, malformed adults, missing offers and duplicate selections", () => {
  for (const age of ["", "-1", "18", "1.5", " 0"])
    expect(make([{ ...choices()[0], childAges: [age] }])).toBeNull();
  for (const adults of ["", "0", "-1", "1.5", "100"])
    expect(make([{ ...choices()[0], adults }])).toBeNull();
  expect(make([{ ...choices()[0], publicOfferKey: "old-rate" }])).toBeNull();
  expect(make([choices()[0], choices()[0]])).toBeNull();
  expect(make([])).toBeNull();
  expect(make(choices(), [...rooms, ...rooms])).toBeNull();
});
it("rejects mixed currencies, impossible dates and reversed stays", () => {
  const second = {
    publicOfferKey: `pricing-offer.v2:${"b".repeat(64)}`,
    currency: "USD",
    mealPlan: "room_only" as const,
  };
  expect(
    make(
      [choices()[0], { ...choices()[1], publicOfferKey: second.publicOfferKey }],
      [{ ...rooms[0], offers: [...rooms[0].offers, second] }],
    ),
  ).toBeNull();
  for (const [start, end] of [
    ["2026-02-30", "2026-03-03"],
    ["2026-10-03", "2026-10-01"],
    ["2026-01-01", "2028-01-01"],
  ])
    expect(roomQuoteRequest(rooms, choices(), start, end, "card")).toBeNull();
});
it("loads current keys from the same-origin no-store catalogue and rejects ambiguous content", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ version: "public-pricing-offers.v1", rooms })),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(await getReplacementOffers("a/b")).toEqual(rooms);
  expect(fetcher).toHaveBeenCalledWith("/api/booking-web/hotels/a%2Fb/pricing-offers", {
    signal: undefined,
    cache: "no-store",
  });
  for (const bad of [
    { version: "old", rooms },
    { version: "public-pricing-offers.v1", rooms: [...rooms, ...rooms] },
    {
      version: "public-pricing-offers.v1",
      rooms: [{ ...rooms[0], offers: [{ ...rooms[0].offers[0], publicOfferKey: "old" }] }],
    },
  ]) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(bad)));
    await expect(getReplacementOffers("hotel")).rejects.toThrow("verified");
  }
});
it("formats accounting units without float rounding or ICU zero-decimal shortcuts", () => {
  expect(displayQuoteMoney("9007199254740993", "EUR")).toBe("EUR 90071992547409.93");
  expect(displayQuoteMoney("1", "JPY")).toBe("JPY 1");
  expect(displayQuoteMoney("1", "KWD")).toBe("KWD 0.001");
  expect(displayQuoteMoney("10800", "IDR")).toBe("IDR 108.00");
});

it("sends the entered promo with the exact selection and clears it explicitly", () => {
  const request = (code: string) =>
    roomQuoteRequest(rooms, choices(), "2026-10-01", "2026-10-03", "card", code);
  expect(request(" SAVE10 ")?.selection.promoCode).toBe("SAVE10");
  expect(request(" ")?.selection.promoCode).toBeNull();
  expect(request("x".repeat(201))).toBeNull();
});
