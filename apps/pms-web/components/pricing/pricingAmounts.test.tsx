import { describe, expect, it } from "vitest";

import deMessages from "@/messages/de.json";
import { PmsPropertySelectionRequiredError } from "@/services/api/pmsPropertyClient";
import {
  amountInput,
  errorText,
  parseAdjustmentInput,
  parseMinorInput,
  PricingError,
} from "./pricingAmounts";

const german = (key: string) => (deMessages as Record<string, string>)[key] ?? key;

describe("pricing errorText", () => {
  it("shows the property-selection error in the selected language", () => {
    const error = new PmsPropertySelectionRequiredError("loading pricing");

    expect(errorText(error, german, "pricing.page.loadFailed")).toBe(
      "Wählen Sie eine Unterkunft aus, um fortzufahren.",
    );
  });

  it("keeps pricing errors translated and other messages unchanged", () => {
    expect(
      errorText(new PricingError("pricing.page.loadFailed"), german, "pricing.page.loadFailed"),
    ).toBe(german("pricing.page.loadFailed"));
    expect(errorText(new Error("Rate conflict"), german, "pricing.page.loadFailed")).toBe(
      "Rate conflict",
    );
    expect(errorText("offline", german, "pricing.page.loadFailed")).toBe(
      german("pricing.page.loadFailed"),
    );
  });
});

describe("IDR whole-rupiah prices (VAY-2085)", () => {
  it("shows price fields in whole rupiah and takes thousands separators (VAY-2425)", () => {
    expect(amountInput("50000000", "IDR")).toBe("500000");
    expect(amountInput("10000", "EUR")).toBe("100.00");
    expect(amountInput("12345", "EUR")).toBe("123.45");
    expect(amountInput("5000", "JPY")).toBe("5000");
    expect(parseAdjustmentInput({ kind: "fixed", value: "+250.000" }, "IDR")).toEqual({
      kind: "fixed",
      deltaMinor: "25000000",
    });
    expect(parseAdjustmentInput({ kind: "fixed", value: "-1,250,000" }, "IDR")).toEqual({
      kind: "fixed",
      deltaMinor: "-125000000",
    });
    // A percentage takes no groups.
    expect(() => parseAdjustmentInput({ kind: "percentage", value: "1,5" }, "IDR")).toThrow(
      expect.objectContaining({ key: "pricing.error.adjustmentInvalid" }),
    );
  });

  it("accepts whole rupiah and refuses a fractional rupiah with its own message", () => {
    expect(parseMinorInput("1500000", 2, false, 100)).toBe("150000000");
    // VAY-2425: no fraction at all, so "150.00" can't stand for a mistyped "150.000".
    expect(() => parseMinorInput("1500000.00", 2, false, 100)).toThrow(
      expect.objectContaining({ key: "pricing.error.wholeUnitsOnly" }),
    );
    expect(() => parseMinorInput("1500000.50", 2, false, 100)).toThrow(
      expect.objectContaining({ key: "pricing.error.wholeUnitsOnly" }),
    );
    // Other currencies keep cent precision.
    expect(parseMinorInput("12.34", 2)).toBe("1234");
  });

  it("keeps fixed IDR adjustments whole and percentages unchanged", () => {
    expect(parseAdjustmentInput({ kind: "fixed", value: "-25000" }, "IDR")).toEqual({
      kind: "fixed",
      deltaMinor: "-2500000",
    });
    expect(() => parseAdjustmentInput({ kind: "fixed", value: "+12.5" }, "IDR")).toThrow(
      expect.objectContaining({ key: "pricing.error.wholeUnitsOnly" }),
    );
    expect(parseAdjustmentInput({ kind: "percentage", value: "-12.5" }, "IDR")).toEqual({
      kind: "percentage",
      basisPoints: -1250,
    });
  });
});
