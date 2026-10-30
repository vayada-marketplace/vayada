import { describe, expect, it } from "vitest";
import {
  cancellationPolicy,
  freeCancellationUntil,
  lastRefundDays,
  pricingOfferNameKeys,
  publicOfferCancellation,
} from "./replacementPricingBrowser.js";

const flexible = (days: number, extra: Record<string, unknown> = {}) =>
  ({
    kind: "flexible",
    terms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: days,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
      ...extra,
    },
  }) as const;

describe("public offer cancellation", () => {
  it("keeps only what guests may know before a quote", () => {
    expect(publicOfferCancellation({ kind: "non_refundable" })).toEqual({ kind: "non_refundable" });
    expect(publicOfferCancellation(flexible(3))).toEqual({
      kind: "free_until_days_before_arrival",
      days: 3,
    });
    expect(publicOfferCancellation(flexible(0))).toEqual({
      kind: "free_until_days_before_arrival",
      days: 0,
    });
    expect(
      publicOfferCancellation(
        flexible(14, {
          flexibleCancellationType: "partial_refund",
          partialRefundTiers: [{ minDaysBeforeCheckIn: 14, refundPercent: 50 }],
        }),
      ),
    ).toEqual({ kind: "partial_refund" });
    // A partial refund of nothing is no refund.
    expect(
      publicOfferCancellation(
        flexible(14, {
          flexibleCancellationType: "partial_refund",
          partialRefundTiers: [{ minDaysBeforeCheckIn: 14, refundPercent: 0 }],
        }),
      ),
    ).toEqual({ kind: "non_refundable" });
    expect(
      publicOfferCancellation(
        flexible(14, { flexibleCancellationType: "partial_refund", partialRefundAmountPercent: 0 }),
      ),
    ).toEqual({ kind: "non_refundable" });
  });

  it("finds a partial refund's last refund day, as Review & pay ends refunds (VAY-2406)", () => {
    const partial = (tiers: { minDaysBeforeCheckIn: number; refundPercent: number }[]) =>
      flexible(30, { flexibleCancellationType: "partial_refund", partialRefundTiers: tiers });
    // In any order; a 0% step adds nothing, before or after the refunds.
    expect(
      lastRefundDays(
        partial([
          { minDaysBeforeCheckIn: 3, refundPercent: 0 },
          { minDaysBeforeCheckIn: 30, refundPercent: 100 },
          { minDaysBeforeCheckIn: 7, refundPercent: 25 },
          { minDaysBeforeCheckIn: 14, refundPercent: 50 },
        ]),
      ),
    ).toBe(7);
    expect(lastRefundDays(partial([{ minDaysBeforeCheckIn: 0, refundPercent: 50 }]))).toBe(0);
    expect(lastRefundDays(partial([{ minDaysBeforeCheckIn: 14, refundPercent: 0 }]))).toBeNull();
    expect(lastRefundDays(flexible(3))).toBeNull();
    expect(lastRefundDays({ kind: "non_refundable" })).toBeNull();
  });

  it("ends refunds the day Review & pay starts saying no refund any more (VAY-2406)", () => {
    const terms = flexible(30, {
      flexibleCancellationType: "partial_refund",
      // A 0% step between refunds, and one after the last.
      partialRefundTiers: [
        { minDaysBeforeCheckIn: 30, refundPercent: 100 },
        { minDaysBeforeCheckIn: 14, refundPercent: 0 },
        { minDaysBeforeCheckIn: 3, refundPercent: 25 },
        { minDaysBeforeCheckIn: 1, refundPercent: 0 },
      ],
    });
    const checkIn = "2026-11-20";
    const last = freeCancellationUntil(checkIn, lastRefundDays(terms)!);
    expect(last).toBe("2026-11-17");
    for (const today of ["2026-11-10", "2026-11-16", last, "2026-11-18", "2026-11-19"]) {
      const { badge } = cancellationPolicy(terms as never, { checkIn, today }, "10000", {
        request: false,
        card: false,
      });
      expect(badge.kind === "noRefund", today).toBe(today > last);
    }
  });
});

describe("offer name keys", () => {
  it("names options by meal and cancellation and numbers repeats in order", () => {
    const free = { kind: "free_until_days_before_arrival", days: 3 } as const,
      none = { kind: "non_refundable" } as const;
    expect(
      pricingOfferNameKeys([
        { mealPlan: "room_only", cancellation: free },
        { mealPlan: "room_only", cancellation: none },
        { mealPlan: "breakfast", cancellation: free },
        {
          mealPlan: "room_only",
          cancellation: { kind: "free_until_days_before_arrival", days: 7 },
        },
        { mealPlan: "half_board", cancellation: { kind: "partial_refund" } },
        { mealPlan: "breakfast", cancellation: null },
        { mealPlan: "breakfast", cancellation: undefined },
        { mealPlan: "room_only", cancellation: free },
        { mealPlan: "half_board", cancellation: { kind: "partial_refund", days: 7 } },
      ]),
    ).toEqual([
      { meal: "room_only", cancellation: "free", days: 3, number: null },
      { meal: "room_only", cancellation: "non_refundable", days: null, number: null },
      { meal: "breakfast", cancellation: "free", days: 3, number: null },
      // Another deadline is still "Free cancellation", the second one; its days tell the two apart.
      { meal: "room_only", cancellation: "free", days: 7, number: 2 },
      { meal: "half_board", cancellation: "partial_refund", days: null, number: null },
      { meal: "breakfast", cancellation: null, days: null, number: null },
      { meal: "breakfast", cancellation: null, days: null, number: 2 },
      { meal: "room_only", cancellation: "free", days: 3, number: 3 },
      // A partial refund's last refund day, when known (VAY-2406).
      { meal: "half_board", cancellation: "partial_refund", days: 7, number: 2 },
    ]);
  });
});
