import { Usage, type Model, type ModelRequest, type ModelResponse } from "@openai/agents";
import type { RequestContext } from "@vayada/backend-auth";
import { describe, expect, it } from "vitest";

import { createOpenAIAgentsAskRuntime, type AskEvidenceToolExecutor } from "./agentRuntime.js";
import type { AskEvidenceEntry, AskEvidenceToolId, AskEvidenceToolResult } from "./evidence.js";
import type { AskModelOutput } from "./modelOutput.js";

const scope = {
  organizationId: "org_1",
  bookingHotelId: "hotel_1",
  dateRange: { from: "2026-05-01", to: "2026-05-31" },
};

const requestContext: RequestContext = {
  actor: {
    internalUserId: "user_1",
    providerIdentity: { provider: "workos", providerUserId: "workos_user_1" },
    email: "owner@example.com",
    status: "active",
  },
  selectedOrganization: {
    organizationId: "org_1",
    kind: "hotel_group",
    status: "active",
  },
  membership: {
    membershipId: "membership_1",
    status: "active",
    roleKey: "owner",
    workosRoleSlugs: ["owner"],
    permissions: ["intelligence.ask.read", "booking.analytics.read"],
  },
  linkedResources: [
    {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: "hotel_1",
      relationship: "owner",
      status: "active",
    },
  ],
  entitlements: [],
  locale: "en-US",
  currency: "USD",
  audit: { requestId: "req_1", source: "api", receivedAt: "2026-06-11T00:00:00Z" },
};

class FakeModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly respond: (request: ModelRequest, turn: number) => ModelResponse) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return this.respond(request, this.requests.length);
  }

  async *getStreamedResponse() {
    throw new Error("Streaming is not used in Ask runtime tests");
  }
}

function functionCall(
  name: AskEvidenceToolId,
  callId: string,
  filters: Record<string, unknown> = {},
): ModelResponse {
  return response({
    output: [
      {
        type: "function_call",
        callId,
        name,
        arguments: JSON.stringify({ filters }),
        status: "completed",
      },
    ],
  });
}

function finalOutput(output: Partial<AskModelOutput> = {}): ModelResponse {
  return response({
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(modelOutput(output)) }],
      },
    ],
  });
}

function refusal(text = "I cannot help with that."): ModelResponse {
  return response({
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: text }],
      },
    ],
  });
}

function response(overrides: Partial<ModelResponse>): ModelResponse {
  return {
    usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    output: [],
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

function evidenceTool(
  toolId: AskEvidenceToolId = "get_booking_performance",
  overrides: Partial<AskEvidenceToolResult> = {},
): AskEvidenceToolExecutor {
  return async (_context, toolScope, filters) => ({
    toolCallId: `${toolId}_req_1`,
    toolId,
    status: "available",
    inputScope: toolScope,
    filters,
    evidence: [evidence()],
    unavailableData: [],
    audit: {
      requestId: "req_1",
      actorInternalUserId: "user_1",
      organizationId: "org_1",
      resourceId: "hotel_1",
      permissionKeys: ["intelligence.ask.read", "booking.analytics.read"],
    },
    ...overrides,
  });
}

function evidence(overrides: Partial<AskEvidenceEntry> = {}): AskEvidenceEntry {
  return {
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
    ...overrides,
  };
}

function runtime(model: Model, evidenceTools: Record<string, AskEvidenceToolExecutor> = {}) {
  return createOpenAIAgentsAskRuntime({
    model,
    evidenceTools,
    now: () => new Date("2026-06-11T00:00:00.000Z"),
  });
}

describe("createOpenAIAgentsAskRuntime", () => {
  it("plans allowed tools, runs SDK function tools, and composes cited answers", async () => {
    const telemetry: unknown[] = [];
    const model = new FakeModel((_request, turn) =>
      turn === 1
        ? functionCall("get_booking_performance", "call_booking_perf", { segment: "direct" })
        : finalOutput(),
    );
    const answer = await createOpenAIAgentsAskRuntime({
      model,
      evidenceTools: { get_booking_performance: evidenceTool() },
      now: () => new Date("2026-06-11T00:00:00.000Z"),
      onRunComplete: (runTelemetry) => {
        telemetry.push(runTelemetry);
      },
    }).answer(
      { question: "Why did my direct booking share drop this month?", scope },
      requestContext,
    );

    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]!.tools.map((tool) => tool.name)).toEqual([
      "get_booking_performance",
      "get_booking_source_mix",
    ]);
    expect(answer.status).toBe("answered");
    expect(answer.audit).toMatchObject({
      requestId: "req_1",
      actorInternalUserId: "user_1",
      organizationId: "org_1",
      toolCallIds: ["call_booking_perf"],
    });
    expect(answer.evidenceReferences[0]).toMatchObject({
      evidenceId: "ev_share",
      toolCallId: "call_booking_perf",
      toolId: "get_booking_performance",
    });
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      promptVersion: "ask-prompt.v1",
      answerSchemaVersion: "ask-answer-schema.v1",
      status: "answered",
      failure: null,
      usage: { requests: 2, inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      toolCallIds: ["call_booking_perf"],
      evidenceIds: ["ev_share"],
    });
  });

  it("returns terminal policy envelopes without calling the model", async () => {
    const telemetry: unknown[] = [];
    const model = new FakeModel(() => {
      throw new Error("model should not be called");
    });
    const answer = await createOpenAIAgentsAskRuntime({
      model,
      evidenceTools: {},
      now: () => new Date("2026-06-11T00:00:00.000Z"),
      onRunComplete: (runTelemetry) => {
        telemetry.push(runTelemetry);
      },
    }).answer(
      {
        question: "Why did revenue drop?",
        scope: { ...scope, organizationId: "org_other" },
      },
      requestContext,
    );

    expect(answer.status).toBe("not_authorized");
    expect(answer.audit.deniedToolCallIds).toHaveLength(1);
    expect(model.requests).toHaveLength(0);
    expect(telemetry[0]).toMatchObject({
      status: "not_authorized",
      failure: null,
      usage: null,
      plan: { kind: "cross_tenant" },
      deniedToolCallIds: answer.audit.deniedToolCallIds,
    });
  });

  it("degrades when the SDK max-turn budget is exhausted", async () => {
    const model = new FakeModel(() => functionCall("get_booking_performance", "call_loop"));
    const answer = await createOpenAIAgentsAskRuntime({
      model,
      evidenceTools: { get_booking_performance: evidenceTool() },
      budgets: { maxModelTurns: 1 },
      now: () => new Date("2026-06-11T00:00:00.000Z"),
    }).answer(
      { question: "Why did my direct booking share drop this month?", scope },
      requestContext,
    );

    expect(answer.status).toBe("partial");
    expect(answer.unavailableData.at(-1)).toMatchObject({ reason: "tool_budget_exhausted" });
    expect(model.requests).toHaveLength(1);
  });

  it("enforces the Vayada same-tool budget around SDK tool calls", async () => {
    const model = new FakeModel((_request, turn) =>
      turn === 1
        ? functionCall("get_booking_performance", "call_first")
        : functionCall("get_booking_performance", "call_second"),
    );
    const answer = await createOpenAIAgentsAskRuntime({
      model,
      evidenceTools: { get_booking_performance: evidenceTool() },
      budgets: { maxCallsPerTool: 1, maxModelTurns: 3 },
      now: () => new Date("2026-06-11T00:00:00.000Z"),
    }).answer(
      { question: "Why did my direct booking share drop this month?", scope },
      requestContext,
    );

    expect(answer.status).toBe("partial");
    expect(answer.audit.toolCallIds).toEqual(["call_first"]);
    expect(answer.unavailableData.at(-1)).toMatchObject({ reason: "tool_budget_exhausted" });
  });

  it("enforces total tool-call budget before parallel tool executions complete", async () => {
    const model = new FakeModel(() =>
      response({
        output: [
          {
            type: "function_call",
            callId: "call_perf",
            name: "get_booking_performance",
            arguments: JSON.stringify({ filters: {} }),
            status: "completed",
          },
          {
            type: "function_call",
            callId: "call_source",
            name: "get_booking_source_mix",
            arguments: JSON.stringify({ filters: {} }),
            status: "completed",
          },
        ],
      }),
    );
    const answer = await createOpenAIAgentsAskRuntime({
      model,
      evidenceTools: {
        get_booking_performance: evidenceTool("get_booking_performance"),
        get_booking_source_mix: evidenceTool("get_booking_source_mix"),
      },
      budgets: { maxEvidenceToolCalls: 1, maxConcurrentToolCalls: 2 },
      now: () => new Date("2026-06-11T00:00:00.000Z"),
    }).answer(
      { question: "Why did my direct booking share drop this month?", scope },
      requestContext,
    );

    expect(answer.status).toBe("partial");
    expect(answer.audit.toolCallIds).toHaveLength(1);
    expect(answer.unavailableData.at(-1)).toMatchObject({ reason: "tool_budget_exhausted" });
  });

  it("maps model refusals to safety unavailable data", async () => {
    const model = new FakeModel(() => refusal());
    const answer = await runtime(model).answer(
      { question: "Why did my direct booking share drop this month?", scope },
      requestContext,
    );

    expect(answer.status).toBe("unavailable");
    expect(answer.unavailableData.at(-1)).toMatchObject({
      reason: "pii_restricted",
      canRetry: false,
    });
  });

  it("maps invalid structured output to degraded envelopes", async () => {
    const model = new FakeModel(() =>
      response({
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: JSON.stringify({ summary: "missing fields" }) }],
          },
        ],
      }),
    );
    const answer = await runtime(model).answer(
      { question: "Why did my direct booking share drop this month?", scope },
      requestContext,
    );

    expect(answer.status).toBe("unavailable");
    expect(answer.unavailableData.at(-1)).toMatchObject({ reason: "invalid_model_output" });
  });

  it("retries evidence tools within the configured wrapper retry budget", async () => {
    let calls = 0;
    const retryingTool: AskEvidenceToolExecutor = async (_context, toolScope, filters) => {
      calls += 1;
      return evidenceTool("get_booking_performance", {
        status: calls === 1 ? "error" : "available",
        evidence: calls === 1 ? [] : [evidence()],
      })(_context, toolScope, filters);
    };
    const model = new FakeModel((_request, turn) =>
      turn === 1 ? functionCall("get_booking_performance", "call_retry") : finalOutput(),
    );
    const answer = await createOpenAIAgentsAskRuntime({
      model,
      evidenceTools: { get_booking_performance: retryingTool },
      budgets: { maxToolRetries: 1 },
      now: () => new Date("2026-06-11T00:00:00.000Z"),
    }).answer(
      { question: "Why did my direct booking share drop this month?", scope },
      requestContext,
    );

    expect(calls).toBe(2);
    expect(answer.status).toBe("answered");
  });
});
