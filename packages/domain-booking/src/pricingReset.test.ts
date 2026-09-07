import { describe, expect, it } from "vitest";
import {
  calculateBookingPrice,
  createBookingNightlyRoomPriceResolver,
} from "./bookingPriceCalculation.js";
import { createBookingPriceSnapshotInput } from "./bookingPriceSnapshotInput.js";
import { bestBookingPromotion } from "./bookingPromotions.js";

describe("removed pricing boundaries", () => {
  it.each([
    calculateBookingPrice,
    createBookingNightlyRoomPriceResolver,
    createBookingPriceSnapshotInput,
    bestBookingPromotion,
  ])("cannot produce a price or snapshot", (calculate) => {
    expect(() => calculate(undefined as never)).toThrow(
      expect.objectContaining({ code: "PRICING_UNAVAILABLE", statusCode: 503 }),
    );
  });
});
