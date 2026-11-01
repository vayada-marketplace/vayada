import { describe, expect, it } from "vitest";
import { formatDay, formatMinor, isNegative, isPositive } from "./vayadaPayouts";

describe("vayada Payment payout amounts (VAY-2442 P5)", () => {
  it("shows minor units exactly, rupiah without the hundredths Stripe counts", () => {
    expect(formatMinor("125000000", "IDR")).toBe("IDR 1,250,000");
    expect(formatMinor("100000050", "IDR")).toBe("IDR 1,000,000.50");
    expect(formatMinor("50", "IDR")).toBe("IDR 0.50");
    expect(formatMinor("1250", "EUR")).toBe("EUR 12.50");
    expect(formatMinor("5", "EUR")).toBe("EUR 0.05");
    expect(formatMinor("-450000", "LKR")).toBe("LKR −4,500.00");
    expect(formatMinor("2500", "JPY")).toBe("JPY 2,500");
    expect(formatMinor("0", "IDR")).toBe("IDR 0");
    expect(formatMinor("-0", "EUR")).toBe("EUR 0.00");
    // Beyond what a float can hold.
    expect(formatMinor("123456789012345678", "IDR")).toBe("IDR 1,234,567,890,123,456.78");
  });

  it("tells owed from owing without converting to a number", () => {
    expect(isPositive("100")).toBe(true);
    expect(isPositive("0")).toBe(false);
    expect(isPositive("-5")).toBe(false);
    expect(isNegative("-5")).toBe(true);
    expect(isNegative("0")).toBe(false);
  });

  it("names calendar days the same in every time zone", () => {
    expect(formatDay("2026-11-08", true)).toBe("Sun 8 Nov 2026");
    expect(formatDay("2026-11-09")).toBe("9 Nov 2026");
  });
});
