import { describe, expect, it } from "vitest";
import { pricingDecimalMinor, pricingDecimalStepIssue } from "./pricingDecimalMinor.js";

describe("saved decimal prices", () => {
  it("converts exactly in the currency scale and refuses precision loss", () => {
    expect(pricingDecimalMinor("12.50", 2)).toBe("1250");
    expect(pricingDecimalMinor("12.500", 3)).toBe("12500");
    expect(pricingDecimalMinor("12.00", 0)).toBe("12");
    expect(pricingDecimalMinor("12.50", 0)).toBeNull();
  });
  it("requires whole rupiah for IDR and the currency's own scale elsewhere (VAY-2085)", () => {
    expect(pricingDecimalStepIssue("price", "150000", "IDR")).toBeNull();
    expect(pricingDecimalStepIssue("price", "150000.00", "IDR")).toBeNull();
    expect(pricingDecimalStepIssue("price", "0150000", "IDR")).toBeNull();
    expect(pricingDecimalStepIssue("price", "150000.50", "IDR")).toBe(
      "price must be a whole IDR amount without decimals.",
    );
    expect(pricingDecimalStepIssue("price", "12.50", "EUR")).toBeNull();
    expect(pricingDecimalStepIssue("discountValue", "12.50", "JPY")).toBe(
      "discountValue has more decimal places than JPY prices allow.",
    );
    expect(pricingDecimalStepIssue("price", "12.50", "XYZ")).toBeNull();
    expect(pricingDecimalStepIssue("price", "abc", "IDR")).toBeNull();
  });
});
