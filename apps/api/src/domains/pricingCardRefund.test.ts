import { describe, expect, it } from "vitest";

import { pricingCardRefundMinor } from "./pricingCardRefund.js";

describe("pricingCardRefundMinor (VAY-2205)", () => {
  it("refunds what was paid minus what the terms keep, never more than was paid", () => {
    expect(pricingCardRefundMinor(10000n, 3000n, "EUR")).toBe(7000n);
    expect(pricingCardRefundMinor(10000n, 0n, "EUR")).toBe(10000n);
    expect(pricingCardRefundMinor(10000n, 10000n, "EUR")).toBe(0n);
    // A deposit: the terms keep more than was paid, so nothing comes back and nothing more is owed.
    expect(pricingCardRefundMinor(3000n, 5000n, "EUR")).toBe(0n);
  });

  it("rounds up to the currency's step in the guest's favour", () => {
    // Whole rupiah (VAY-2085): 1,234.56 IDR owed comes back as 1,235.
    expect(pricingCardRefundMinor(1_000_000n, 1_000_000n - 123_456n, "IDR")).toBe(123_500n);
    expect(pricingCardRefundMinor(123_456n, 0n, "IDR")).toBe(123_456n);
    expect(pricingCardRefundMinor(10001n, 1n, "EUR")).toBe(10000n);
  });
});
