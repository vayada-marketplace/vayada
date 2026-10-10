import { describe, expect, it } from "vitest";
import {
  buildBookingConversionFunnel,
  FUNNEL_EVENT_TYPES,
  FUNNEL_STAGES,
  type BookingFunnelEvent,
  type FunnelPaymentMethod,
} from "./conversionFunnel.js";

function journey(
  sessionId: string,
  method: FunnelPaymentMethod,
  addons = false,
): BookingFunnelEvent[] {
  return FUNNEL_STAGES.filter(
    (stage) =>
      (addons || stage !== "addons_step_passed") &&
      (method === "card" || stage !== "payment_authorized"),
  ).map((stage, i) => ({ sessionId, sequence: i + 1, stage, paymentMethod: method }));
}

describe("sequential Booking conversion funnel", () => {
  it("deduplicates retries, restores interaction order, and bypasses authorization for non-card guests", () => {
    const events = [
      ...journey("card", "card"),
      ...journey("bank", "bank_transfer"),
      ...journey("cash", "pay_at_property"),
      ...journey("abandoned", "card").slice(0, -2),
    ];
    const funnel = buildBookingConversionFunnel([...events, ...events].reverse(), false);
    expect(funnel.steps.map((step) => step.count)).toEqual([4, 4, 4, 4, 1, 3]);
    expect(funnel.steps.at(-2)).toMatchObject({
      conversionPercent: 50,
      percentOfVisits: 25,
      previousCount: 2,
    });
    expect(funnel.steps.at(-1)).toMatchObject({
      conversionPercent: 100,
      percentOfVisits: 75,
      previousCount: 3,
    });
    expect(funnel.biggestDrop).toBe("payment_authorized");
    expect(funnel.paymentMethods).toEqual([
      { method: "card", count: 2 },
      { method: "bank_transfer", count: 1 },
      { method: "pay_at_property", count: 1 },
    ]);
  });

  it("requires every previous shown stage and ignores early, missing and duplicate sequence events", () => {
    const valid = journey("valid", "card", true);
    const missingAddon = journey("missing-addon", "card", true).filter(
      (event) => event.stage !== "addons_step_passed",
    );
    const noVisit = journey("no-visit", "card", true).slice(1);
    const early = journey("early", "card", true).map((event) =>
      event.stage === "details_completed" ? { ...event, sequence: 2 } : event,
    );
    const result = buildBookingConversionFunnel(
      [...valid, ...missingAddon, ...noVisit, ...early],
      true,
    );
    expect(result.steps.map((step) => step.count)).toEqual([3, 3, 2, 1, 1, 1, 1]);
    expect(result.steps[3]?.conversionPercent).toBe(50);
    expect(result.biggestDrop).toBe("details_completed");
  });

  it("moves a session to its new payment branch and rejects stale completions", () => {
    const events = journey("switch", "card").slice(0, -1);
    events.push(
      {
        sessionId: "switch",
        sequence: 7,
        stage: "complete_booking_clicked",
        paymentMethod: "bank_transfer",
      },
      { sessionId: "switch", sequence: 8, stage: "booking_completed", paymentMethod: "card" },
    );
    const result = buildBookingConversionFunnel(events, false);
    expect(result.steps.at(-2)).toMatchObject({ count: 0, conversionPercent: null });
    expect(result.steps.at(-1)).toMatchObject({ count: 0, previousCount: 1 });
    expect(result.paymentMethods).toEqual([{ method: "bank_transfer", count: 1 }]);
  });

  it("counts a rate selection without a room-detail view, which stays accepted telemetry only", () => {
    const result = buildBookingConversionFunnel(
      [
        { sessionId: "direct", sequence: 1, stage: "page_visit" },
        { sessionId: "direct", sequence: 2, stage: "rate_selected" },
      ],
      false,
    );
    expect(result.steps.slice(0, 3).map(({ stage, count }) => [stage, count])).toEqual([
      ["page_visit", 1],
      ["rate_selected", 1],
      ["details_completed", 0],
    ]);
    expect(result.biggestDrop).toBe("details_completed");
    expect(FUNNEL_STAGES).not.toContain("room_viewed");
    expect(FUNNEL_EVENT_TYPES).toContain("room_viewed");
  });

  it("returns finite empty counts without a false biggest drop", () => {
    const result = buildBookingConversionFunnel([], false);
    expect(result.steps).toHaveLength(6);
    expect(
      result.steps.every(
        (step) =>
          step.count === 0 && step.conversionPercent === null && step.percentOfVisits === null,
      ),
    ).toBe(true);
    expect(result.biggestDrop).toBeNull();
  });
});
