import { resolveBookedCancellationOutcome, type BookedCancellation } from "@vayada/domain-booking";
import { describe, expect, it } from "vitest";

import { resolveTargetCancellationPreview, type TargetBookingRow } from "./bookingWebPublic.js";

const booking = (currency = "EUR") =>
  ({
    bookingMetadata: { targetSource: "pricing_quote_draft", pricingQuoteId: "quote-1" },
    checkIn: "2026-12-01",
    currency,
    paymentStatus: "unpaid",
  }) as unknown as TargetBookingRow;
const flexible = (extra: Record<string, unknown> = {}): BookedCancellation =>
  ({
    kind: "flexible",
    terms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
      ...extra,
    },
  }) as BookedCancellation;
const tiered = flexible({
  flexibleCancellationType: "partial_refund",
  partialRefundTiers: [
    { minDaysBeforeCheckIn: 30, refundPercent: 100 },
    { minDaysBeforeCheckIn: 14, refundPercent: 50 },
  ],
});
const outcome = (cancelledOn: string, ...cancellations: BookedCancellation[]) =>
  resolveBookedCancellationOutcome({
    checkIn: "2026-12-01",
    cancelledOn,
    totalMinor: "40000000",
    rooms: cancellations.map((cancellation, i) => ({
      selectionId: `room-${i}`,
      cancellation,
      subtotalMinor: "20000000",
    })),
  });
const preview = (value: ReturnType<typeof outcome>, currency?: string) =>
  resolveTargetCancellationPreview(booking(currency), "Asia/Makassar", new Date(), value);

describe("pricing-v2 guest cancellation preview (VAY-2100)", () => {
  it("lets an unpaid partial-refund stay cancel in every tier and never promises a refund", () => {
    for (const [cancelledOn, fee] of [
      ["2026-10-01", 0],
      ["2026-11-10", 200000],
      ["2026-11-25", 400000],
    ] as const) {
      const value = outcome(cancelledOn, tiered);
      expect(preview(value, "IDR")).toEqual({
        amountPaid: 0,
        refundAmount: 0,
        refundPercentage: 0,
        cancellationFeeAmount: fee,
        freeCancellationDays: value!.rooms[0]!.matchedTierMinDays ?? 0,
        daysUntilCheckIn: value!.daysBeforeCheckIn,
        currency: "IDR",
        bookedTermsOutcome: value,
      });
    }
  });

  it("keeps free cancellation until its deadline and refuses non-refundable stays", () => {
    expect(preview(outcome("2026-11-24", flexible()))).toMatchObject({ cancellationFeeAmount: 0 });
    expect(() => preview(outcome("2026-11-25", flexible()))).toThrow(/period has expired/);
    expect(() => preview(outcome("2026-10-01", tiered, { kind: "non_refundable" }))).toThrow(
      /non-refundable/,
    );
  });

  it("cancels on the check-in day but not after it", () => {
    expect(preview(outcome("2026-12-01", tiered))).toMatchObject({ cancellationFeeAmount: 400000 });
    expect(() => preview(outcome("2026-12-02", tiered))).toThrow(/check-in date has passed/);
  });

  it("refuses when the booked terms cannot be read", () => {
    expect(() => preview(null)).toThrow(/cannot be verified online/);
    expect(() => preview(outcome("2026-10-01", tiered), "QQQ")).toThrow(/cannot be verified/);
  });
});
