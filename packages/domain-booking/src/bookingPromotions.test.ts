import { describe, expect, it } from "vitest";
import { parseBookingPromotions, type BookingPromotion } from "./bookingPromotions.js";
const promotion = (overrides: Partial<BookingPromotion> = {}): BookingPromotion => ({
  type: "LAST_MINUTE",
  active: true,
  roomTypeIds: [],
  discountPercent: 10,
  threshold: 5,
  freeNights: 0,
  weekdays: [],
  tiers: [],
  ...overrides,
});
describe("stored promotion configuration", () => {
  it("enforces unique types, strict parameters and valid room identifiers", () => {
    expect(parseBookingPromotions([promotion(), promotion()])).toBeNull();
    for (const invalid of [
      { discountPercent: 101 },
      { discountPercent: NaN },
      { threshold: -1 },
      { roomTypeIds: ["invalid"] },
      { active: "yes" },
      { surprise: true },
    ])
      expect(parseBookingPromotions([{ ...promotion(), ...invalid }])).toBeNull();
    expect(parseBookingPromotions([promotion({ type: "MIDWEEK" })])).toBeNull();
    expect(
      parseBookingPromotions([
        promotion({ type: "EXTENDED_STAY", freeNights: 5, discountPercent: 0, threshold: 5 }),
      ]),
    ).toBeNull();
  });
});
