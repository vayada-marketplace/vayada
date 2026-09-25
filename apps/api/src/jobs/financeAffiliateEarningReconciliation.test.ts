import { describe, expect, it } from "vitest";
import { historicalQuoteFixture } from "../domains/pricingAcceptanceHistory.fixtures.js";
import {
  hasExactBookingPaymentCoverage,
  resolveNetAccommodationMinor,
} from "./financeAffiliateEarningReconciliation.js";

const row = (amount: string, economic_event = "room_night") => ({
  currency: "EUR",
  amount,
  economic_event,
  source_kind: "direct",
  evidence_quality: "exact",
  line_position: 1,
  corrects_evidence_id: economic_event === "room_night" ? null : "evidence-1",
});
const assignment = { position: 1, selectionId: "one" };

describe("affiliate earning accommodation evidence", () => {
  it("uses exact room revenue and applies an allocated refund correction", () => {
    expect(
      resolveNetAccommodationMinor(
        historicalQuoteFixture(),
        "EUR",
        [row("150.00"), row("150.00"), { ...row("-50.00", "refund"), source_kind: "manual" }],
        assignment,
      ),
    ).toEqual({ minor: "25000", scale: 2, bookingTotalMinor: "36000" });
  });

  it("rejects incomplete initial allocation, retained penalties and non-exact evidence", () => {
    const quote = historicalQuoteFixture();
    expect(resolveNetAccommodationMinor(quote, "EUR", [row("150.00")], assignment)).toBeNull();
    expect(
      resolveNetAccommodationMinor(
        quote,
        "EUR",
        [row("150.00"), row("150.00"), row("20.00", "retained_charge")],
        assignment,
      ),
    ).toBeNull();
    expect(
      resolveNetAccommodationMinor(
        quote,
        "EUR",
        [row("150.00"), { ...row("150.00"), evidence_quality: "estimated" }],
        assignment,
      ),
    ).toBeNull();
  });

  it("rejects discounts because the single-item path cannot prove their allocation", () => {
    const quote = structuredClone(historicalQuoteFixture()) as unknown as {
      evidence: { lines: unknown[] };
    };
    quote.evidence.lines.push({
      id: "discount",
      selectionId: "one",
      kind: "discount",
      amountMinor: "-1000",
    });
    expect(
      resolveNetAccommodationMinor(quote, "EUR", [row("150.00"), row("150.00")], assignment),
    ).toBeNull();
  });

  it("matches refund payment facts without counting the refund as new settlement", () => {
    const original = {
      currency: "EUR",
      amount: "360.00",
      refunded_amount: "50.00",
      status: "partially_refunded",
      payment_kind: "full",
    };
    const refund = {
      currency: "EUR",
      amount: "50.00",
      refunded_amount: "50.00",
      status: "refunded",
      payment_kind: "refund",
    };
    expect(hasExactBookingPaymentCoverage("36000", "EUR", 2, [original, refund])).toBe(true);
    expect(hasExactBookingPaymentCoverage("36000", "EUR", 2, [original])).toBe(false);
    expect(
      hasExactBookingPaymentCoverage("36000", "EUR", 2, [
        original,
        { ...refund, amount: "40.00", refunded_amount: "40.00" },
      ]),
    ).toBe(false);
  });
});
