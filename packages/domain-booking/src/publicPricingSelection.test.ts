import { describe, expect, it, vi } from "vitest";
import {
  bindPublicPricingSelection,
  parsePublicPricingSelection,
  PUBLIC_PRICING_SELECTION_VERSION,
} from "./publicPricingSelection.js";
import { replacementStayKey } from "./replacementPricingEvidence.js";

const input = () => ({
  version: PUBLIC_PRICING_SELECTION_VERSION,
  checkIn: "2026-10-01",
  checkOut: "2026-10-04",
  currency: "EUR",
  rooms: [
    {
      selectionId: "room-1",
      publicOfferKey: "offer-with-breakfast",
      guests: { adults: 2, childAgesAtCheckIn: [0, 8] },
    },
  ],
  addons: [{ id: "tour", quantity: 2, dates: ["2026-10-04"] }],
  promoCode: null,
});
const offer = {
  propertyId: "hotel-1",
  publicOfferKey: "offer-with-breakfast",
  roomTypeId: "double",
  offerId: "breakfast",
};
const bind = (value: unknown) => bindPublicPricingSelection(value, "hotel-1", [offer]);

describe("public replacement pricing selection", () => {
  it("maps exact offers and preserves each physical room and child age", () => {
    const request = input();
    request.rooms.push({
      ...request.rooms[0],
      selectionId: "room-2",
      guests: { adults: 1, childAgesAtCheckIn: [] },
    });
    const stay = bind(request)!;
    expect(stay.propertyId).toBe("hotel-1");
    expect(stay.rooms.map((r) => [r.selectionId, r.roomTypeId, r.offerId, r.guests])).toEqual([
      ["room-1", "double", "breakfast", { adults: 2, childAgesAtCheckIn: [0, 8] }],
      ["room-2", "double", "breakfast", { adults: 1, childAgesAtCheckIn: [] }],
    ]);
    request.rooms[0].guests.childAgesAtCheckIn[0] = 17;
    request.addons[0].dates[0] = "2026-10-02";
    expect(stay.rooms[0].guests.childAgesAtCheckIn).toEqual([0, 8]);
    expect(stay.addons[0].dates).toEqual(["2026-10-04"]);
  });
  it("rejects client authority, old child counts, invalid ages and malformed selections", () => {
    for (const change of [
      { propertyId: "other" },
      { totalMinor: "1" },
      { version: "booking-room-selection.v1" },
      { rooms: [] },
      { rooms: [input().rooms[0], input().rooms[0]] },
      { rooms: new Array(1) },
      { checkIn: "2026-02-30" },
      { checkOut: "2026-10-01" },
      { currency: "ZZZ" },
      { promoCode: " " },
    ]) {
      expect(parsePublicPricingSelection({ ...input(), ...change })).toBeNull();
    }
    for (const guests of [
      { adults: 1, children: 1 },
      { adults: 1 },
      { adults: 0, childAgesAtCheckIn: [] },
      { adults: 1.5, childAgesAtCheckIn: [] },
      ...[-1, 18, 2.5, "8", null].map((age) => ({ adults: 1, childAgesAtCheckIn: [age] })),
      { adults: 1, childAgesAtCheckIn: new Array(1) },
    ]) {
      expect(bind({ ...input(), rooms: [{ ...input().rooms[0], guests }] })).toBeNull();
    }
    expect(bind({ ...input(), rooms: [{ ...input().rooms[0], offerId: "forged" }] })).toBeNull();
  });
  it("enforces resource ceilings at and beyond the boundary", () => {
    const request = {
      ...input(),
      checkOut: "2027-10-02",
      rooms: Array.from({ length: 99 }, (_, i) => ({
        ...input().rooms[0],
        selectionId: String(i),
        guests: { adults: 1, childAgesAtCheckIn: Array(98).fill(17) },
      })),
      addons: Array.from({ length: 99 }, (_, i) => ({ id: String(i), quantity: 99, dates: null })),
    };
    expect(bind(request)).not.toBeNull();
    for (const change of [
      { checkOut: "2027-10-03" },
      { rooms: [...request.rooms, { ...request.rooms[0], selectionId: "extra" }] },
      { addons: [...request.addons, { ...request.addons[0], id: "extra" }] },
      {
        rooms: [
          { ...request.rooms[0], guests: { adults: 2, childAgesAtCheckIn: Array(98).fill(17) } },
        ],
      },
      { addons: [{ id: "a", quantity: 100, dates: null }] },
    ])
      expect(bind({ ...request, ...change })).toBeNull();
    expect(
      bind({ ...input(), rooms: [{ ...input().rooms[0], publicOfferKey: "x".repeat(513) }] }),
    ).toBeNull();
  });
  it("rejects malformed extras instead of silently pricing a different selection", () => {
    for (const addons of [
      [input().addons[0], input().addons[0]],
      [null],
      new Array(1),
      [{ id: "a", quantity: 1, dates: null, personIds: ["child-1"] }],
      ...[[], ["2026-09-30"], ["2026-10-05"], ["2026-10-02", "2026-10-02"], new Array(1)].map(
        (dates) => [{ id: "a", quantity: 1, dates }],
      ),
    ]) {
      expect(bind({ ...input(), addons })).toBeNull();
    }
  });
  it("rejects missing, foreign and ambiguous owner mappings without label fallback", () => {
    for (const offers of [
      [],
      [{ ...offer, propertyId: "other" }],
      [offer, offer],
      [{ ...offer, publicOfferKey: "flexible" }],
      [{ ...offer, offerId: "" }],
    ]) {
      expect(bindPublicPricingSelection(input(), "hotel-1", offers)).toBeNull();
    }
    expect(
      bindPublicPricingSelection(input(), "hotel-1", [offer, { ...offer, propertyId: "other" }]),
    ).not.toBeNull();
  });
  it("uses locale-independent identity and binds mapped offer, ages and extras", () => {
    const request = input();
    request.rooms.push({ ...request.rooms[0], selectionId: "Ä" });
    request.rooms.push({ ...request.rooms[0], selectionId: "Z" });
    const stay = bind(request)!;
    const locale = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale-dependent key");
    });
    try {
      const key = replacementStayKey(stay);
      expect(replacementStayKey({ ...stay, rooms: [...stay.rooms].reverse() })).toBe(key);
      for (const changed of [
        { ...stay, rooms: [{ ...stay.rooms[0], offerId: "room-only" }, ...stay.rooms.slice(1)] },
        {
          ...stay,
          rooms: [
            { ...stay.rooms[0], guests: { adults: 2, childAgesAtCheckIn: [0, 9] } },
            ...stay.rooms.slice(1),
          ],
        },
        { ...stay, addons: [{ ...stay.addons[0], dates: ["2026-10-02"] }] },
      ])
        expect(replacementStayKey(changed)).not.toBe(key);
    } finally {
      locale.mockRestore();
    }
    for (const currency of ["JPY", "KWD"])
      expect(bind({ ...request, currency })?.currency).toBe(currency);
  });
});
