import { describe, expect, it } from "vitest";

import {
  ASK_CONTRACT_VERSION,
  ASK_LOOP_HARD_LIMITS,
  askAnswerSchema,
  clampAskLoopBudgets,
  DEFAULT_ASK_LOOP_BUDGETS,
  type AskAnswer,
} from "./index.js";

const validAnswer: AskAnswer = {
  answerId: "ask_answer_req_1",
  contractVersion: ASK_CONTRACT_VERSION,
  generatedAt: "2026-06-11T00:00:00.000Z",
  conversationId: "ask_conversation_req_1",
  runId: "ask_run_req_1",
  question: "How is my direct booking share developing?",
  scope: {
    organizationId: "org_1",
    bookingHotelId: "hotel_1",
    dateRange: { from: "2026-05-01", to: "2026-05-31" },
  },
  status: "answered",
  summary: "Direct booking share is 62.5% for May.",
  blocks: [{ type: "metric", metricKey: "booking.direct_booking_share", value: 62.5 }],
  evidenceReferences: [{ evidenceId: "ev_1", toolCallId: "call_1" }],
  unavailableData: [],
  caveats: [],
  confidence: { level: "high", reasons: ["fresh_internal_metrics"] },
  suggestedActions: [],
  followUpQuestions: [],
  audit: {
    requestId: "req_1",
    actorInternalUserId: "user_1",
    organizationId: "org_1",
    toolCallIds: ["call_1"],
    deniedToolCallIds: [],
  },
};

describe("askAnswerSchema", () => {
  it("accepts a complete answer envelope", () => {
    expect(askAnswerSchema.parse(validAnswer)).toEqual(validAnswer);
  });

  it("accepts null actor and organization on denied answers", () => {
    const denied: AskAnswer = {
      ...validAnswer,
      status: "not_authorized",
      audit: { ...validAnswer.audit, actorInternalUserId: null, organizationId: null },
    };
    expect(askAnswerSchema.parse(denied)).toEqual(denied);
  });

  it("rejects unknown envelope statuses", () => {
    expect(askAnswerSchema.safeParse({ ...validAnswer, status: "maybe" }).success).toBe(false);
  });

  it("rejects a wrong contract version", () => {
    expect(askAnswerSchema.safeParse({ ...validAnswer, contractVersion: "ask.v0" }).success).toBe(
      false,
    );
  });

  it("rejects extra top-level keys", () => {
    expect(askAnswerSchema.safeParse({ ...validAnswer, prose: "raw text" }).success).toBe(false);
  });

  it("rejects a missing audit block", () => {
    const { audit: _audit, ...withoutAudit } = validAnswer;
    expect(askAnswerSchema.safeParse(withoutAudit).success).toBe(false);
  });

  it("rejects an empty scope organization", () => {
    expect(
      askAnswerSchema.safeParse({ ...validAnswer, scope: { organizationId: "" } }).success,
    ).toBe(false);
  });
});

describe("clampAskLoopBudgets", () => {
  it("returns MVP defaults when nothing is configured", () => {
    expect(clampAskLoopBudgets()).toEqual(DEFAULT_ASK_LOOP_BUDGETS);
  });

  it("clamps values above the hard limits", () => {
    const clamped = clampAskLoopBudgets({
      maxModelTurns: 99,
      maxEvidenceToolCalls: 99,
      maxCallsPerTool: 99,
      maxProviderRetries: 99,
      maxToolRetries: 99,
      runTimeoutMs: 999_999,
      maxConcurrentToolCalls: 99,
      maxConversationTurns: 99,
    });
    expect(clamped).toEqual(ASK_LOOP_HARD_LIMITS);
  });

  it("floors loop budgets at one and retries at zero", () => {
    const clamped = clampAskLoopBudgets({
      maxModelTurns: -1,
      maxEvidenceToolCalls: 0,
      maxProviderRetries: -5,
      maxToolRetries: -5,
    });
    expect(clamped.maxModelTurns).toBe(1);
    expect(clamped.maxEvidenceToolCalls).toBe(1);
    expect(clamped.maxProviderRetries).toBe(0);
    expect(clamped.maxToolRetries).toBe(0);
  });

  it("falls back to defaults for non-finite values", () => {
    const clamped = clampAskLoopBudgets({ runTimeoutMs: Number.NaN, maxModelTurns: Infinity });
    expect(clamped.runTimeoutMs).toBe(DEFAULT_ASK_LOOP_BUDGETS.runTimeoutMs);
    expect(clamped.maxModelTurns).toBe(DEFAULT_ASK_LOOP_BUDGETS.maxModelTurns);
  });

  it("truncates fractional configuration values", () => {
    expect(clampAskLoopBudgets({ maxModelTurns: 2.9 }).maxModelTurns).toBe(2);
  });
});
