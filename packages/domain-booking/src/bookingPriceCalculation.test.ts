import { describe, expect, it } from "vitest";
import {
  applyBookingPricePercentageDiscount,
  BOOKING_PRICE_MAX_MINOR_UNITS,
  formatBookingPriceMinorUnits,
  roundBookingPriceDecimalToMinorUnits,
} from "./bookingPriceCalculation.js";
describe("shared exact money primitives", () => {
  it("uses named scale-2 decimal round-half-up fixtures", () => {
    expect(roundBookingPriceDecimalToMinorUnits("1.0049")).toBe("100");
    expect(roundBookingPriceDecimalToMinorUnits("1.0050")).toBe("101");
    expect(roundBookingPriceDecimalToMinorUnits("1.0051")).toBe("101");
    expect(roundBookingPriceDecimalToMinorUnits("9.999")).toBe("1000");
    expect(roundBookingPriceDecimalToMinorUnits("0.004999999999999999")).toBe("0");
    expect(formatBookingPriceMinorUnits("0")).toBe("0.00");
    expect(formatBookingPriceMinorUnits("1000")).toBe("10.00");

    for (const invalid of ["-1.00", "01.00", "1.", ".50", "1e2", 1.005, "x"]) {
      expect(roundBookingPriceDecimalToMinorUnits(invalid)).toBeNull();
    }
    expect(formatBookingPriceMinorUnits("01")).toBeNull();
    expect(
      formatBookingPriceMinorUnits((BigInt(BOOKING_PRICE_MAX_MINOR_UNITS) + 1n).toString()),
    ).toBeNull();
  });

  it("applies integer-rational percentage discounts with one half-up rounding", () => {
    expect(applyBookingPricePercentageDiscount("15", 10)).toEqual({
      discountMinorUnits: "1",
      finalMinorUnits: "14",
    });
    expect(applyBookingPricePercentageDiscount("14", 10)).toEqual({
      discountMinorUnits: "1",
      finalMinorUnits: "13",
    });
    expect(applyBookingPricePercentageDiscount("999", 50)).toEqual({
      discountMinorUnits: "499",
      finalMinorUnits: "500",
    });
    expect(applyBookingPricePercentageDiscount("15", 0)).toBeNull();
    expect(applyBookingPricePercentageDiscount("15", 51)).toBeNull();
  });
});
