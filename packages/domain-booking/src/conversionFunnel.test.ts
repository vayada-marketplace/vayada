import { describe, expect, it } from "vitest";
import {
  buildBookingConversionFunnel,
  FUNNEL_EVENT_TYPES,
  FUNNEL_STAGES,
  isFunnelId,
  parseFunnelEventMetadata,
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

describe("funnel event allowlist (VAY-2197)", () => {
  const sequence = { funnelVersion: 1, funnelSequence: 3 };

  it("accepts each event with exactly its own properties", () => {
    for (const [type, properties] of [
      ["page_visit", {}],
      ["room_viewed", { roomTypeId: "f6853000-0000-4000-8000-000000000010" }],
      ["rate_selected", { entry: "room_card" }],
      ["step_viewed", { step: "extras" }],
      ["addons_step_passed", { extrasShown: false, extrasChosen: false }],
      ["details_completed", {}],
      ["complete_booking_clicked", { paymentMethod: "pay_at_property", mode: "request" }],
      ["payment_authorized", { paymentMethod: "card" }],
      ["booking_completed", { paymentMethod: "bank_transfer", outcome: "awaiting_payment" }],
      ["booking_error", { step: "payment", reason: "booking_uncertain" }],
      [
        "booking_error",
        { step: "payment", reason: "booking_unavailable", code: "CARD_PAYMENT_UNAVAILABLE" },
      ],
    ] as const) {
      expect(parseFunnelEventMetadata(type, { ...properties, ...sequence })).toEqual({
        ...properties,
        ...sequence,
      });
    }
  });

  it("rejects guest data, free text, unknown events and broken sequences", () => {
    for (const [type, metadata] of [
      ["page_visit", { ...sequence, email: "guest@example.com" }],
      ["page_visit", { ...sequence, locale: "de" }],
      ["details_completed", { ...sequence, firstName: "Ada" }],
      ["room_viewed", { ...sequence, roomTypeId: "guest@example.com" }],
      ["room_viewed", sequence],
      ["rate_selected", { ...sequence, entry: "elsewhere" }],
      ["step_viewed", { ...sequence, step: "confirmation" }],
      ["addons_step_passed", { ...sequence, extrasShown: "yes", extrasChosen: false }],
      ["complete_booking_clicked", { ...sequence, paymentMethod: "unknown", mode: "instant" }],
      ["payment_authorized", { ...sequence, paymentMethod: "pay_at_property" }],
      [
        "booking_completed",
        { ...sequence, paymentMethod: "card", outcome: "paid", reference: "VAY-1" },
      ],
      [
        "booking_error",
        { ...sequence, step: "payment", reason: "payment_failed", code: "card_declined" },
      ],
      [
        "booking_error",
        { ...sequence, step: "payment", reason: "payment_failed", message: "Declined" },
      ],
      ["page_visit", { funnelSequence: 1 }],
      ["page_visit", { funnelVersion: 1, funnelSequence: 0 }],
      ["page_visit", { funnelVersion: 1, funnelSequence: "1" }],
      ["page_visit", null],
      ["page_visit", []],
      ["searched_dates", sequence],
      ["toString", sequence],
      ["__proto__", sequence],
    ] as const) {
      expect(parseFunnelEventMetadata(type, metadata), `${type} ${JSON.stringify(metadata)}`).toBe(
        null,
      );
    }
  });

  it("keeps the new events out of the dashboard stages", () => {
    expect(FUNNEL_EVENT_TYPES).toEqual(expect.arrayContaining(["step_viewed", "booking_error"]));
    expect(FUNNEL_STAGES).not.toContain("step_viewed");
    expect(FUNNEL_STAGES).not.toContain("booking_error");
  });

  it("counts the same when step views and errors take sequence numbers between the stages", () => {
    const plain = journey("plain", "pay_at_property", true);
    const gapped = journey("gapped", "pay_at_property", true).map((event) => ({
      ...event,
      sequence: event.sequence * 3,
    }));
    expect(buildBookingConversionFunnel(gapped, true)).toEqual(
      buildBookingConversionFunnel(plain, true),
    );
  });

  it("only takes random UUIDs as session and event ids", () => {
    expect(isFunnelId("0b6f0f6e-6a1b-4c39-9d1e-5d3c2a1b0f9e")).toBe(true);
    for (const id of ["sid_123", "guest@example.com", "", 7, undefined])
      expect(isFunnelId(id)).toBe(false);
  });
});
