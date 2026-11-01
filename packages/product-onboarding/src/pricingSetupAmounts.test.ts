import { describe, expect, it } from "vitest";
import { decimalAmount, parseMinorInput, signedAmountText } from "./pricingSetupAmounts";

// No-break spaces as copied from formatted numbers (fr, id): built from code points, not typed.
const nbsp = String.fromCharCode(0xa0),
  narrow = String.fromCharCode(0x202f);
const wholeRupiah = expect.objectContaining({ key: "pricing.error.wholeUnitsOnly" });
const invalid = expect.objectContaining({ key: "pricing.error.invalidPrice" });

describe("whole-unit price input (VAY-2425)", () => {
  it("takes thousands separators in a whole-unit currency", () => {
    // IDR: scale 2, priced in whole rupiah (step 100).
    for (const typed of [
      "500.000",
      "500,000",
      "500 000",
      `500${nbsp}000`,
      `500${narrow}000`,
      "500000",
    ])
      expect(parseMinorInput(typed, 2, false, 100)).toBe("50000000");
    for (const typed of ["1.500.000", "1,500,000", "1 500 000"])
      expect(parseMinorInput(typed, 2, false, 100)).toBe("150000000");
    // JPY has no minor unit, so every price is whole yen.
    expect(parseMinorInput("5,000", 0)).toBe("5000");
  });

  it("takes no fraction in a whole-unit currency, so a dropped digit can't mean a thousandth", () => {
    // "150.00" would otherwise be Rp 150 next to "150.000", Rp 150,000.
    for (const typed of ["150.00", "1500000.00", "500.5", "500,000.00", "1.500,000", "15.00.000"])
      expect(() => parseMinorInput(typed, 2, false, 100)).toThrow(wholeRupiah);
    // Groups never start with 0.
    for (const typed of ["0.500", "000,000", "0 500"])
      expect(() => parseMinorInput(typed, 2, false, 100)).toThrow(wholeRupiah);
  });

  it("keeps currencies with a fraction as they were", () => {
    expect(parseMinorInput("123.45", 2)).toBe("12345");
    expect(parseMinorInput("500.00", 2)).toBe("50000");
    for (const typed of ["1,500", "1.500", "1 500"])
      expect(() => parseMinorInput(typed, 2)).toThrow(invalid);
    // KWD has three decimals and a step of one fils: "1.500" stays 1.5 dinar.
    expect(parseMinorInput("1.500", 3)).toBe("1500");
    expect(() => parseMinorInput("1,500", 3)).toThrow(invalid);
  });

  it("shows a whole-unit amount without its zero fraction", () => {
    expect(decimalAmount("50000000", 2, 100)).toBe("500000");
    expect(decimalAmount("0", 2, 100)).toBe("0");
    // A stored amount that isn't whole stays visible as it is.
    expect(decimalAmount("4999", 2, 100)).toBe("49.99");
    expect(decimalAmount("12345", 2)).toBe("123.45");
    expect(decimalAmount("10000", 2)).toBe("100.00");
    expect(decimalAmount("5000", 0)).toBe("5000");
  });

  it("accepts signed amounts with groups only in a whole-unit currency", () => {
    expect(signedAmountText("-1,250,000", 2, 100)).toBe(true);
    expect(signedAmountText("+250 000", 2, 100)).toBe(true);
    expect(signedAmountText("+12.5", 2, 1)).toBe(true);
    expect(signedAmountText("+1,500", 2, 1)).toBe(false);
    expect(signedAmountText("abc", 2, 100)).toBe(false);
  });
});
