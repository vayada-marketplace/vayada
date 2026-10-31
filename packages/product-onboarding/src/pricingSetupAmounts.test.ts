import { describe, expect, it } from "vitest";
import { decimalAmount, parseMinorInput } from "./pricingSetupAmounts";

// No-break spaces as copied from formatted numbers (fr, id): built from code points, not typed.
const nbsp = String.fromCharCode(0xa0),
  narrow = String.fromCharCode(0x202f);

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
      "500000.00",
    ])
      expect(parseMinorInput(typed, 2, false, 100)).toBe("50000000");
    for (const typed of ["1.500.000", "1,500,000", "1 500 000"])
      expect(parseMinorInput(typed, 2, false, 100)).toBe("150000000");
    // Two decimals are still a fraction: Rp 500.
    expect(parseMinorInput("500.00", 2, false, 100)).toBe("50000");
    // JPY has no minor unit, so every price is whole yen.
    expect(parseMinorInput("5,000", 0)).toBe("5000");
  });

  it("refuses mixed or broken groups, and groups in a currency with a fraction", () => {
    for (const typed of ["1.500,000", "15.00.000", "500.0000", "500,00", "1 500.000"])
      expect(() => parseMinorInput(typed, 2, false, 100)).toThrow(
        expect.objectContaining({ key: "pricing.error.invalidPrice" }),
      );
    expect(() => parseMinorInput("500.000,50", 2, false, 100)).toThrow();
    // EUR keeps cents: "1,500" or "1.500" is no group there.
    for (const typed of ["1,500", "1.500", "1 500"])
      expect(() => parseMinorInput(typed, 2)).toThrow(
        expect.objectContaining({ key: "pricing.error.invalidPrice" }),
      );
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
});
