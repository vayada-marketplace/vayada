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
      roomTypeId: `type-${i}`,
      cancellation,
      subtotalMinor: "20000000",
    })),
  });
const preview = (value: ReturnType<typeof outcome>, currency?: string) =>
  resolveTargetCancellationPreview(
    booking(currency),
    "Asia/Makassar",
    new Date(),
    value,
    null,
    new Map([
      ["type-0", "Deluxe Double Room"],
      ["type-1", "Garden Double Room"],
    ]),
  );

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
    expect(() =>
      preview(outcome("2026-10-01", { kind: "non_refundable" }, { kind: "non_refundable" })),
    ).toThrow(/non-refundable/);
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

describe("rooms with different terms (VAY-2320)", () => {
  const nonRefundable: BookedCancellation = { kind: "non_refundable" };

  it("cancels online under each room's own terms and lists what each room keeps", () => {
    // Room 1 is still free to cancel; room 2 is non-refundable and keeps its 200000.00.
    expect(preview(outcome("2026-11-20", flexible(), nonRefundable))).toMatchObject({
      amountPaid: 0,
      refundAmount: 0,
      cancellationFeeAmount: 200000,
      rooms: [
        {
          roomName: "Deluxe Double Room",
          rule: "free_until_deadline",
          refundPercent: 100,
          refundAmount: 200000,
          keptAmount: 0,
        },
        {
          roomName: "Garden Double Room",
          rule: "non_refundable",
          refundPercent: 0,
          refundAmount: 0,
          keptAmount: 200000,
        },
      ],
    });
    // A partial-refund room cancels in every tier, beside a room past its free cancellation.
    expect(preview(outcome("2026-11-25", tiered, flexible()))).toMatchObject({
      cancellationFeeAmount: 400000,
      rooms: [
        { rule: "partial_refund", refundPercent: 0, keptAmount: 200000 },
        { rule: "free_until_deadline", refundPercent: 0, keptAmount: 200000 },
      ],
    });
  });

  it("stays off online only when every room keeps everything", () => {
    expect(() => preview(outcome("2026-11-25", flexible(), nonRefundable))).toThrow(
      /non-refundable/,
    );
    expect(() => preview(outcome("2026-11-25", flexible(), flexible()))).toThrow(
      /period has expired/,
    );
  });

  it("lists rooms whose name isn't known without one, and one room not at all", () => {
    const [first] = (
      resolveTargetCancellationPreview(
        booking(),
        "Asia/Makassar",
        new Date(),
        outcome("2026-10-01", tiered, tiered),
      ) as { rooms: unknown[] }
    ).rooms;
    expect(first).toMatchObject({ roomName: null, rule: "partial_refund" });
    expect(preview(outcome("2026-10-01", tiered))).not.toHaveProperty("rooms");
  });
});

describe("guest cancellation refusals carry a code booking-web translates (VAY-2308)", () => {
  const refusal = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return { ...(error as object), message: (error as Error).message };
    }
    throw new Error("expected a refusal");
  };

  it.each([
    [
      "non-refundable",
      () => preview(outcome("2026-10-01", { kind: "non_refundable" })),
      "BOOKING_CANCEL_NON_REFUNDABLE",
    ],
    [
      "past the deadline",
      () => preview(outcome("2026-11-25", flexible())),
      "BOOKING_CANCEL_DEADLINE_PASSED",
    ],
    [
      "after check-in",
      () => preview(outcome("2026-12-02", tiered)),
      "BOOKING_CANCEL_CHECK_IN_PASSED",
    ],
    ["unreadable terms", () => preview(null), "BOOKING_CANCEL_NOT_ONLINE"],
  ])("%s", (_name, run, code) => {
    expect(refusal(run)).toMatchObject({ statusCode: 409, code });
  });
});
