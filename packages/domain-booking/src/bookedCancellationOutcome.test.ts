import { describe, expect, it } from "vitest";

import {
  resolveBookedCancellationOutcome,
  type BookedCancellation,
} from "./bookedCancellationOutcome.js";

const flexible = (extra: Record<string, unknown> = {}, deadline = 7): BookedCancellation =>
  ({
    kind: "flexible",
    terms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: deadline,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
      ...extra,
    },
  }) as BookedCancellation;
const tiered = (tiers: [number, number][], deadline = 365) =>
  flexible(
    {
      flexibleCancellationType: "partial_refund",
      partialRefundTiers: tiers.map(([minDaysBeforeCheckIn, refundPercent]) => ({
        minDaysBeforeCheckIn,
        refundPercent,
      })),
    },
    deadline,
  );
const daysBefore = (days: number) =>
  new Date(Date.parse("2026-12-01T00:00:00Z") - days * 86_400_000).toISOString().slice(0, 10);
const one = (cancellation: BookedCancellation, days: number, totalMinor = "20000") =>
  resolveBookedCancellationOutcome({
    checkIn: "2026-12-01",
    cancelledOn: daysBefore(days),
    totalMinor,
    rooms: [{ selectionId: "room-1", cancellation, subtotalMinor: totalMinor }],
  });

describe("booked cancellation outcome", () => {
  // The legacy table (apps/pms-api tests/test_cancellation_refund.py): every boundary is inclusive.
  it.each([
    [45, 100, 30, "20000"],
    [30, 100, 30, "20000"],
    [20, 50, 14, "10000"],
    [14, 50, 14, "10000"],
    [10, 25, 7, "5000"],
    [7, 25, 7, "5000"],
    [3, 0, null, "0"],
    [0, 0, null, "0"],
    [-1, 0, null, "0"],
  ] as const)("refunds the met tier %i days before check-in", (days, percent, tier, refund) => {
    expect(
      one(
        tiered([
          [7, 25],
          [30, 100],
          [14, 50],
        ]),
        days,
      ),
    ).toEqual({
      daysBeforeCheckIn: days,
      totalMinor: "20000",
      refundMinor: refund,
      retainedMinor: String(20000 - Number(refund)),
      rooms: [
        {
          selectionId: "room-1",
          rule: "partial_refund",
          refundPercent: percent,
          matchedTierMinDays: tier,
          baseMinor: "20000",
          refundMinor: refund,
          retainedMinor: String(20000 - Number(refund)),
        },
      ],
    });
  });

  it("ignores the free-cancellation deadline once tiers decide, and honours a same-day tier", () => {
    expect(
      one(
        tiered(
          [
            [30, 50],
            [0, 10],
          ],
          365,
        ),
        400,
      )?.refundMinor,
    ).toBe("10000");
    expect(
      one(
        tiered(
          [
            [30, 50],
            [0, 10],
          ],
          365,
        ),
        0,
      )?.refundMinor,
    ).toBe("2000");
    expect(
      one(
        tiered(
          [
            [30, 50],
            [0, 10],
          ],
          365,
        ),
        -1,
      )?.refundMinor,
    ).toBe("0");
  });

  it("takes the largest notice met, not the largest percent", () => {
    expect(
      one(
        tiered([
          [30, 20],
          [14, 80],
        ]),
        40,
      )?.rooms[0],
    ).toMatchObject({ refundPercent: 20, matchedTierMinDays: 30 });
    expect(
      one(
        tiered([
          [30, 20],
          [14, 80],
        ]),
        20,
      )?.rooms[0],
    ).toMatchObject({ refundPercent: 80, matchedTierMinDays: 14 });
  });

  it("keeps flexible and non-refundable rules unchanged", () => {
    expect(one(flexible({}, 7), 7)).toMatchObject({
      refundMinor: "20000",
      rooms: [{ rule: "free_until_deadline", refundPercent: 100 }],
    });
    expect(one(flexible({ flexibleCancellationType: "free" }, 7), 6)).toMatchObject({
      refundMinor: "0",
      retainedMinor: "20000",
    });
    expect(one({ kind: "non_refundable" }, 300)).toMatchObject({
      refundMinor: "0",
      rooms: [{ rule: "non_refundable" }],
    });
  });

  it("rounds half up in minor units", () => {
    expect(one(tiered([[1, 50]]), 5, "333")).toMatchObject({
      refundMinor: "167",
      retainedMinor: "166",
    });
    expect(one(tiered([[1, 33]]), 5, "1500000")).toMatchObject({
      refundMinor: "495000",
      retainedMinor: "1005000",
    });
  });

  it("shares booking-level lines across rooms in proportion and follows each room's terms", () => {
    const outcome = resolveBookedCancellationOutcome({
      checkIn: "2026-12-01",
      cancelledOn: daysBefore(20),
      totalMinor: "44000",
      rooms: [
        { selectionId: "a", cancellation: { kind: "non_refundable" }, subtotalMinor: "10000" },
        { selectionId: "b", cancellation: tiered([[14, 50]]), subtotalMinor: "30000" },
      ],
    });
    expect(outcome).toMatchObject({
      refundMinor: "16500",
      retainedMinor: "27500",
      rooms: [
        { baseMinor: "11000", refundMinor: "0" },
        { baseMinor: "33000", refundMinor: "16500" },
      ],
    });
    // A promo below the room subtotals, and remainders that must still add up to the total.
    const split = resolveBookedCancellationOutcome({
      checkIn: "2026-12-01",
      cancelledOn: daysBefore(20),
      totalMinor: "100",
      rooms: ["x", "y", "z"].map((selectionId) => ({
        selectionId,
        cancellation: flexible(),
        subtotalMinor: "60",
      })),
    });
    expect(split?.rooms.map((room) => room.baseMinor)).toEqual(["34", "33", "33"]);
    expect(split).toMatchObject({ refundMinor: "100", retainedMinor: "0" });
  });

  it("refuses input it cannot trust", () => {
    const room = { selectionId: "a", cancellation: tiered([[7, 50]]), subtotalMinor: "100" };
    const base = {
      checkIn: "2026-12-01",
      cancelledOn: "2026-11-01",
      totalMinor: "100",
      rooms: [room],
    };
    for (const input of [
      { ...base, checkIn: "2026-02-30" },
      { ...base, cancelledOn: "2026-11-01T00:00:00Z" },
      { ...base, totalMinor: "0" },
      { ...base, totalMinor: "1.5" },
      { ...base, rooms: [] },
      { ...base, rooms: [room, room] },
      { ...base, rooms: [{ ...room, subtotalMinor: "0" }] },
      {
        ...base,
        rooms: [
          { ...room, cancellation: flexible({ flexibleCancellationType: "partial_refund" }) },
        ],
      },
      {
        ...base,
        rooms: [{ ...room, cancellation: { kind: "refundable" } as unknown as BookedCancellation }],
      },
      { ...base, rooms: [{ ...room, cancellation: null as unknown as BookedCancellation }] },
    ])
      expect(resolveBookedCancellationOutcome(input)).toBeNull();
  });
});
