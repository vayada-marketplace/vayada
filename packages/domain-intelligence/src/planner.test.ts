import { describe, expect, it } from "vitest";

import { planAskQuestion, type AskPlan } from "./planner.js";

const scope = {
  organizationId: "org_1",
  bookingHotelId: "hotel_1",
  pmsHotelId: "pms_hotel_1",
  dateRange: { from: "2026-05-01", to: "2026-05-31" },
};

function plan(question: string, overrides: Partial<typeof scope> = {}): AskPlan {
  return planAskQuestion({ question, scope: { ...scope, ...overrides } });
}

describe("planAskQuestion intent classification", () => {
  it.each([
    ["Why did my direct booking share drop this month?", "booking_performance"],
    ["Which room types have the highest booking value?", "booking_performance"],
    ["Which booking source generated the most revenue last week?", "booking_source_mix"],
    ["Where is my booking funnel leaking?", "conversion_funnel"],
    ["What setup fields are blocking my booking page from looking complete?", "setup_completeness"],
    ["What changed before revenue dropped?", "performance_overview"],
    [
      "What should I do next to improve direct bookings using only current Vayada data?",
      "performance_overview",
    ],
    [
      "Look at my hotel performance and tell me the top three things to fix.",
      "performance_overview",
    ],
    [
      "Help me understand what happened this week before I make pricing changes.",
      "performance_overview",
    ],
  ])("plans %s as %s", (question, intent) => {
    expect(plan(question)).toMatchObject({ kind: "run_tools", intent });
  });

  it("maps intents to the catalog tool subsets in priority order", () => {
    const performance = plan("Why did my direct booking share drop this month?");
    expect(performance).toMatchObject({
      toolPlan: [{ toolId: "get_booking_performance" }, { toolId: "get_booking_source_mix" }],
    });
    const setup = plan("Which setup items are missing?");
    expect(setup).toMatchObject({
      toolPlan: [{ toolId: "get_setup_gaps" }, { toolId: "get_hotel_settings_summary" }],
    });
    const overview = plan("Give me an overall health check.");
    if (overview.kind !== "run_tools") throw new Error("expected run_tools");
    expect(overview.toolPlan).toHaveLength(5);
    expect(overview.toolPlan[0]?.metricKeys).toContain("booking.direct_booking_share");
  });

  it("returns unsupported with a catalog reason for questions outside the MVP catalog", () => {
    expect(plan("Which upcoming arrivals need attention?")).toEqual({
      kind: "unsupported",
      reason: "no_cataloged_intent",
    });
    expect(plan("Which creator collaborations are overdue or underperforming?")).toEqual({
      kind: "unsupported",
      reason: "no_cataloged_intent",
    });
  });

  it("keeps OTA source questions on internal source-mix data", () => {
    expect(plan("What share of my bookings are OTA versus direct?")).toMatchObject({
      kind: "run_tools",
      intent: "booking_source_mix",
    });
  });
});

describe("planAskQuestion guardrails", () => {
  it.each([
    ["Compare my prices to nearby competitors.", "competitor_pricing"],
    ["Which local events should I price around?", "local_events"],
    ["What do Booking.com reviews say about my breakfast?", "reviews"],
    ["Which creators outside Vayada should I invite?", "external_creators"],
    ["Predict demand for next summer using market data.", "market_demand"],
  ])("routes enrichment question %s to external_data_needed", (question, topic) => {
    expect(plan(question)).toEqual({ kind: "external_data_needed", topic });
  });

  it.each([
    "Change my weekend rates.",
    "Send this message to every arriving guest.",
    "Publish these new booking page settings.",
    "Cancel risky bookings automatically.",
    "Mark these bookings as cancelled.",
    "Refund the bookings from last weekend.",
    "Delete the test bookings from last month.",
    "Turn off instant booking for next weekend.",
    "Add a new room type for the garden suite.",
    "Create a discount code for direct bookings.",
  ])("refuses to execute write action %s", (question) => {
    expect(plan(question).kind).toBe("write_action");
  });

  it("write-action detection beats metric keywords but keeps the read intent for evidence", () => {
    const result = plan("Cancel risky bookings before revenue drops further.");
    expect(result).toMatchObject({ kind: "write_action", intent: "booking_performance" });
    if (result.kind !== "write_action") throw new Error("expected write_action");
    expect(result.toolPlan.map((call) => call.toolId)).toContain("get_booking_performance");
  });

  it("treats advice framing about an action as a read question", () => {
    expect(plan("Should I lower my prices for August?")).toMatchObject({
      kind: "run_tools",
      intent: "booking_performance",
    });
    expect(plan("Should I raise my rates next month?").kind).toBe("run_tools");
  });

  it("does not flag past-tense booking questions as write actions", () => {
    expect(plan("How many bookings were cancelled last month?").kind).toBe("run_tools");
  });

  it("blocks arbitrary SQL requests with a distinct reason", () => {
    expect(plan("Run a SQL query against the bookings table.")).toEqual({
      kind: "unsupported",
      reason: "blocked_sql",
    });
    expect(plan("select * from guest_bookings")).toEqual({
      kind: "unsupported",
      reason: "blocked_sql",
    });
  });

  it("does not treat natural-language 'select … from' as SQL", () => {
    expect(plan("Select bookings from May and summarize them.").kind).toBe("run_tools");
  });

  it("denies cross-tenant benchmarking questions", () => {
    expect(plan("How does my revenue compare to other hotels on Vayada?")).toEqual({
      kind: "cross_tenant",
      reason: "cross_tenant_question",
    });
    expect(plan("Benchmark my direct share against all hotels.")).toEqual({
      kind: "cross_tenant",
      reason: "cross_tenant_question",
    });
  });

  it("allows benchmarking against the owner's own history and properties", () => {
    expect(plan("Benchmark this month's direct bookings against last month.").kind).toBe(
      "run_tools",
    );
    expect(plan("How is my other hotel doing?").kind).not.toBe("cross_tenant");
  });

  it("denies scope for a different organization than the request context", () => {
    const mismatched = planAskQuestion({
      question: "Why did my direct booking share drop this month?",
      scope,
      selectedOrganizationId: "org_2",
    });
    expect(mismatched).toEqual({ kind: "cross_tenant", reason: "organization_mismatch" });
    const matched = planAskQuestion({
      question: "Why did my direct booking share drop this month?",
      scope,
      selectedOrganizationId: "org_1",
    });
    expect(matched.kind).toBe("run_tools");
  });

  it("treats an empty scope organization as clarification, not a tenant denial", () => {
    const result = planAskQuestion({
      question: "Why did my direct booking share drop this month?",
      scope: { ...scope, organizationId: "" },
      selectedOrganizationId: "org_1",
    });
    expect(result).toMatchObject({ kind: "needs_clarification" });
  });
});

describe("planAskQuestion scope validation", () => {
  it("asks for clarification when booking metrics lack a hotel or date range", () => {
    const missingHotel = plan("Why did revenue drop?", { bookingHotelId: undefined });
    expect(missingHotel).toMatchObject({
      kind: "needs_clarification",
      reasons: ["missing_property"],
    });
    const missingRange = plan("Why did revenue drop?", { dateRange: undefined });
    expect(missingRange).toMatchObject({
      kind: "needs_clarification",
      reasons: ["missing_date_range"],
    });
  });

  it("rejects malformed or reversed date ranges", () => {
    expect(
      plan("Why did revenue drop?", { dateRange: { from: "2026-02-30", to: "2026-03-01" } }),
    ).toMatchObject({ kind: "needs_clarification", reasons: ["invalid_date_range"] });
    expect(
      plan("Why did revenue drop?", { dateRange: { from: "2026-05-31", to: "2026-05-01" } }),
    ).toMatchObject({ kind: "needs_clarification", reasons: ["invalid_date_range"] });
  });

  it("collects every missing scope element in one clarification", () => {
    const result = planAskQuestion({
      question: "Why did revenue drop?",
      scope: { organizationId: "" },
    });
    if (result.kind !== "needs_clarification") throw new Error("expected needs_clarification");
    expect(result.reasons).toEqual([
      "missing_organization",
      "missing_property",
      "missing_date_range",
    ]);
    expect(result.followUpQuestions).toHaveLength(3);
  });

  it("lets setup questions run without a date range and with only a PMS property", () => {
    const result = plan("Is my hotel setup complete?", {
      bookingHotelId: undefined,
      dateRange: undefined,
    });
    expect(result).toMatchObject({ kind: "run_tools", intent: "setup_completeness" });
  });

  it("still validates a provided date range for setup questions", () => {
    expect(
      plan("Is my hotel setup complete?", {
        dateRange: { from: "2026-13-01", to: "2026-13-02" },
      }),
    ).toMatchObject({ kind: "needs_clarification", reasons: ["invalid_date_range"] });
  });
});
