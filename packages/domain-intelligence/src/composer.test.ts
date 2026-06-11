import { describe, expect, it } from "vitest";

import { composeAskAnswer, type AskComposeInput } from "./composer.js";
import type { AskEvidenceToolResult } from "./evidence.js";
import type { AskModelOutput } from "./modelOutput.js";
import { planAskQuestion } from "./planner.js";

const scope = {
  organizationId: "org_1",
  bookingHotelId: "hotel_1",
  dateRange: { from: "2026-05-01", to: "2026-05-31" },
};

const identity = {
  requestId: "req_1",
  conversationId: "ask_conversation_req_1",
  runId: "ask_run_req_1",
  answerId: "ask_answer_req_1",
  generatedAt: "2026-06-11T00:00:00.000Z",
  actorInternalUserId: "user_1",
  organizationId: "org_1",
};

function toolResult(overrides: Partial<AskEvidenceToolResult> = {}): AskEvidenceToolResult {
  return {
    toolCallId: "get_booking_performance_req_1",
    toolId: "get_booking_performance",
    status: "available",
    inputScope: scope,
    filters: {},
    evidence: [
      {
        evidenceId: "ev_share",
        sourceOwner: "booking",
        sourceView: "direct_booking_summary_read_model",
        product: "booking",
        resourceId: "hotel_1",
        resourceType: "booking_hotel",
        metricKey: "booking.direct_booking_share",
        filters: {},
        freshness: { status: "fresh", generatedAt: "2026-06-10T08:00:00Z" },
        quality: "complete",
        sampleSize: 48,
        aggregateId: "booking.direct_booking_share.2026-05",
        valueSummary: { directSharePct: 62.5 },
      },
    ],
    unavailableData: [],
    audit: {
      requestId: "req_1",
      actorInternalUserId: "user_1",
      organizationId: "org_1",
      resourceId: "hotel_1",
      permissionKeys: ["intelligence.ask.read", "booking.analytics.read"],
    },
    ...overrides,
  };
}

function modelOutput(overrides: Partial<AskModelOutput> = {}): AskModelOutput {
  return {
    status: "answered",
    summary: "Direct booking share is 62.5% for May.",
    blocks: [
      {
        type: "metric",
        metricKey: "booking.direct_booking_share",
        value: 62.5,
        unit: "percentage",
        text: null,
        evidenceIds: ["ev_share"],
      },
    ],
    caveats: [],
    suggestedActions: [],
    followUpQuestions: [],
    ...overrides,
  };
}

function compose(overrides: Partial<AskComposeInput>): ReturnType<typeof composeAskAnswer> {
  return composeAskAnswer({
    question: "Why did my direct booking share drop this month?",
    scope,
    identity,
    plan: planAskQuestion({ question: "Why did my direct booking share drop?", scope }),
    modelOutput: modelOutput(),
    toolResults: [toolResult()],
    failure: null,
    ...overrides,
  });
}

describe("composeAskAnswer plan envelopes", () => {
  it("composes a clarification envelope with the planner's follow-ups", () => {
    const answer = compose({
      plan: planAskQuestion({
        question: "Why did revenue drop?",
        scope: { organizationId: "org_1" },
      }),
      modelOutput: null,
      toolResults: [],
    });
    expect(answer.status).toBe("needs_clarification");
    expect(answer.followUpQuestions.length).toBeGreaterThan(0);
    expect(answer.unavailableData[0]).toMatchObject({ reason: "missing_scope" });
  });

  it("composes external_data_needed with a request_enrichment action and topic", () => {
    const answer = compose({
      plan: planAskQuestion({ question: "Compare my prices to nearby competitors.", scope }),
      modelOutput: null,
      toolResults: [],
    });
    expect(answer.status).toBe("external_data_needed");
    expect(answer.unavailableData[0]).toMatchObject({
      reason: "external_data_needed",
      topic: "competitor_pricing",
    });
    expect(answer.suggestedActions[0]).toMatchObject({ type: "request_enrichment" });
  });

  it("refuses write actions with a non-executed suggested action", () => {
    const answer = compose({
      plan: planAskQuestion({ question: "Change my weekend rates.", scope }),
      modelOutput: null,
      toolResults: [],
    });
    expect(answer.status).toBe("unavailable");
    expect(answer.caveats[0]).toMatchObject({ code: "action_not_executed" });
    expect(answer.suggestedActions[0]).toMatchObject({ type: "adjust_rate_review" });
  });

  it("denies cross-tenant plans with audit-visible denial", () => {
    const answer = compose({
      plan: { kind: "cross_tenant", reason: "organization_mismatch" },
      modelOutput: null,
      toolResults: [],
    });
    expect(answer.status).toBe("not_authorized");
    expect(answer.audit.deniedToolCallIds).toHaveLength(1);
    expect(answer.confidence.level).toBe("unknown");
  });

  it("maps uncataloged questions to source_not_in_catalog with catalog follow-ups", () => {
    const answer = compose({
      plan: { kind: "unsupported", reason: "no_cataloged_intent" },
      modelOutput: null,
      toolResults: [],
    });
    expect(answer.status).toBe("unavailable");
    expect(answer.unavailableData[0]).toMatchObject({ reason: "source_not_in_catalog" });
    expect(answer.followUpQuestions).toHaveLength(1);
  });

  it("refuses blocked SQL distinctly from uncataloged questions", () => {
    const answer = compose({
      plan: { kind: "unsupported", reason: "blocked_sql" },
      modelOutput: null,
      toolResults: [],
    });
    expect(answer.unavailableData[0]).toMatchObject({ reason: "unsupported_request" });
  });
});

describe("composeAskAnswer run synthesis", () => {
  it("composes an answered envelope with evidence references and computed confidence", () => {
    const answer = compose({});
    expect(answer.status).toBe("answered");
    expect(answer.evidenceReferences).toHaveLength(1);
    expect(answer.evidenceReferences[0]).toMatchObject({
      evidenceId: "ev_share",
      toolId: "get_booking_performance",
      quality: "complete",
    });
    expect(answer.confidence).toEqual({
      level: "high",
      reasons: ["fresh_internal_metrics", "complete_source"],
    });
    expect(answer.audit.toolCallIds).toEqual(["get_booking_performance_req_1"]);
  });

  it("drops material blocks without authorized evidence and downgrades to partial", () => {
    const answer = compose({
      modelOutput: modelOutput({
        blocks: [
          {
            type: "metric",
            metricKey: "booking.gross_booking_revenue",
            value: 999,
            unit: "currency",
            text: null,
            evidenceIds: ["ev_invented"],
          },
          {
            type: "metric",
            metricKey: "booking.direct_booking_share",
            value: 62.5,
            unit: "percentage",
            text: null,
            evidenceIds: ["ev_share"],
          },
        ],
      }),
    });
    expect(answer.status).toBe("partial");
    expect(answer.blocks).toHaveLength(1);
    expect(answer.caveats.some((caveat) => caveat.code === "uncited_claims_removed")).toBe(true);
  });

  it("keeps explanation blocks without citations", () => {
    const answer = compose({
      modelOutput: modelOutput({
        blocks: [
          modelOutput().blocks[0]!,
          {
            type: "explanation",
            metricKey: null,
            value: null,
            unit: null,
            text: "Direct share held steady because partner volume dropped.",
            evidenceIds: [],
          },
        ],
      }),
    });
    expect(answer.status).toBe("answered");
    expect(answer.blocks).toHaveLength(2);
  });

  it("returns unavailable when the model claims an answer with no cited evidence", () => {
    const answer = compose({
      modelOutput: modelOutput({
        blocks: [
          {
            type: "explanation",
            metricKey: null,
            value: null,
            unit: null,
            text: "Everything looks fine.",
            evidenceIds: [],
          },
        ],
      }),
      toolResults: [],
    });
    expect(answer.status).toBe("unavailable");
  });

  it("downgrades answered to partial when tools reported unavailable data", () => {
    const answer = compose({
      toolResults: [
        toolResult({
          status: "partial",
          unavailableData: [
            {
              unavailableDataId: "get_conversion_funnel_source_unavailable",
              reason: "source_unavailable",
              requestedToolId: "get_conversion_funnel",
              canRetry: true,
              canClarify: false,
            },
          ],
        }),
      ],
    });
    expect(answer.status).toBe("partial");
    expect(answer.unavailableData).toHaveLength(1);
    expect(answer.confidence.level).toBe("medium");
  });

  it("does not let the model claim not_authorized without a denied tool", () => {
    const answer = compose({ modelOutput: modelOutput({ status: "not_authorized" }) });
    expect(answer.status).toBe("unavailable");
    const denied = compose({
      modelOutput: modelOutput({ status: "not_authorized", blocks: [] }),
      toolResults: [toolResult({ status: "not_authorized", evidence: [] })],
    });
    expect(denied.status).toBe("not_authorized");
    expect(denied.audit.deniedToolCallIds).toEqual(["get_booking_performance_req_1"]);
  });

  it("degrades loop failures without confident prose", () => {
    const exhausted = compose({ modelOutput: null, failure: "budget_exhausted" });
    expect(exhausted.status).toBe("partial");
    expect(exhausted.unavailableData.at(-1)).toMatchObject({
      reason: "tool_budget_exhausted",
      canRetry: true,
    });
    const refused = compose({
      modelOutput: null,
      toolResults: [],
      failure: "model_refusal_safety",
    });
    expect(refused.status).toBe("unavailable");
    expect(refused.unavailableData.at(-1)).toMatchObject({
      reason: "pii_restricted",
      canRetry: false,
    });
  });

  it("filters unknown evidence ids from caveats and suggested actions", () => {
    const answer = compose({
      modelOutput: modelOutput({
        caveats: [{ code: "note", message: "May data only.", evidenceIds: ["ev_unknown"] }],
        suggestedActions: [
          { type: "view_report", label: "Open report", evidenceIds: ["ev_share", "ev_unknown"] },
        ],
      }),
    });
    expect(answer.caveats[0]).toMatchObject({ evidenceIds: [] });
    expect(answer.suggestedActions[0]).toMatchObject({ evidenceIds: ["ev_share"] });
  });

  it("always returns a schema-valid envelope", () => {
    const answer = compose({});
    expect(answer.contractVersion).toBe("ask-intelligence-evidence.v1");
    expect(answer.answerId).toBe("ask_answer_req_1");
  });
});
