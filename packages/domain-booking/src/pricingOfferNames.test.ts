import { describe, expect, it } from "vitest";
import { pricingOfferNameKeys, publicOfferCancellation } from "./replacementPricingBrowser.js";

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
    ]);
  });
});
