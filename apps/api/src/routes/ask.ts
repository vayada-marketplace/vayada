import { Usage, type Model, type ModelRequest, type ModelResponse } from "@openai/agents";
import type { RequestContext } from "@vayada/backend-auth";
import {
  ASK_ANSWER_SCHEMA_VERSION,
  createOpenAIAgentsAskRuntime,
  type AskAgentRunTelemetry,
  type AskAgentRuntime,
  AskAnswer,
  AskAuditRecord,
  AskAuditRepository,
  ASK_PROMPT_VERSION,
  type AskEvidenceEntry,
  type AskEvidenceRepository,
  type AskEvidenceToolResult,
  type AskLoopBudgets,
  type AskModelOutput,
  AskScope,
} from "@vayada/domain-intelligence";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { createAskEvidenceToolExecutors } from "./askEvidenceTools.js";
import { enforceRoutePolicy } from "./policy.js";

export type {
  AskAnswer,
  AskAuditRecord,
  AskAuditRepository,
  AskScope,
  AskStatus,
} from "@vayada/domain-intelligence";

export const ASK_API_CONTRACT = {
  method: "POST",
  path: "/api/ai/ask",
  permission: "intelligence.ask.read",
  entitlement: { product: "booking", key: "booking-engine", resourceType: "booking_hotel" },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export type AskRoutesOptions = {
  auditRepository?: AskAuditRepository;
  runtime?: AskAgentRuntime;
  evidenceRepository?: AskEvidenceRepository;
  model?: Model;
  modelMetadata?: { provider: string; model: string };
  budgets?: Partial<AskLoopBudgets>;
  now?: () => Date;
};

type AskRequestBody = {
  question: string;
  scope: AskScope;
};

type AskEnvelopeOverrides = Partial<AskAnswer> & {
  deniedToolCallIds?: string[];
};

export function createInMemoryAskAuditRepository(): AskAuditRepository & {
  records: AskAuditRecord[];
} {
  const records: AskAuditRecord[] = [];
  return {
    records,
    async recordAskRun(record) {
      records.push(record);
    },
  };
}

export async function registerAskRoutes(
  app: FastifyInstance,
  options: AskRoutesOptions = {},
): Promise<void> {
  const auditRepository = options.auditRepository ?? createInMemoryAskAuditRepository();
  const evidenceRepository = options.evidenceRepository ?? createFixtureAskEvidenceRepository();
  const model = options.model ?? createDeterministicAskModel();
  const modelMetadata =
    options.modelMetadata ??
    (options.model ? null : { provider: "fixture", model: "deterministic-ask-route-fixture.v1" });
  app.addHook("onClose", async () => auditRepository.close?.());

  app.post<{ Body: unknown }>("/ask", async (request, reply) => {
    let baseContext: RequestContext;
    try {
      baseContext = enforceRoutePolicy(request, { permission: "intelligence.ask.read" });
    } catch (error) {
      const answer = notAuthorized(request, parseFallback(request.body), error);
      await recordAudit(request, auditRepository, answer, null, modelMetadata);
      return reply.code(statusCode(error)).send(answer);
    }

    const parsed = parseAskRequest(request.body);
    if (!parsed.ok) {
      const answer = envelope(request, parsed.body, baseContext, {
        status: "needs_clarification",
        summary: parsed.message,
        unavailableData: [
          {
            unavailableDataId: "unavailable_invalid_ask_request",
            reason: "missing_scope",
            canRetry: true,
            canClarify: true,
          },
        ],
        followUpQuestions: ["Which hotel, date range, and question should I analyze?"],
      });
      await recordAudit(request, auditRepository, answer, null, modelMetadata);
      return reply.code(400).send(answer);
    }

    let scopedContext: RequestContext;
    try {
      scopedContext = enforceScopedPolicy(request, parsed.body.scope.bookingHotelId);
    } catch (error) {
      const answer = notAuthorized(request, parsed.body, error);
      await recordAudit(request, auditRepository, answer, null, modelMetadata);
      return reply.code(statusCode(error)).send(answer);
    }

    if (parsed.body.scope.organizationId !== scopedContext.selectedOrganization.organizationId) {
      const answer = envelope(request, parsed.body, scopedContext, {
        status: "not_authorized",
        summary: "I cannot answer for an organization outside the selected request context.",
        unavailableData: [
          {
            unavailableDataId: "unavailable_ask_organization_scope",
            reason: "not_linked_resource",
            canRetry: false,
            canClarify: true,
          },
        ],
        confidence: { level: "unknown", reasons: ["not_linked_resource"] },
        deniedToolCallIds: ["tool_call_ask_organization_denied"],
      });
      await recordAudit(request, auditRepository, answer, null, modelMetadata);
      return reply.code(403).send(answer);
    }

    let telemetry: AskAgentRunTelemetry | null = null;
    const runtime =
      options.runtime ??
      createOpenAIAgentsAskRuntime({
        model,
        evidenceTools: createAskEvidenceToolExecutors(evidenceRepository),
        budgets: options.budgets,
        now: options.now,
        onRunComplete: (runTelemetry) => {
          telemetry = runTelemetry;
        },
      });
    const answer = await runtime.answer(parsed.body, scopedContext);
    await recordAudit(request, auditRepository, answer, telemetry, modelMetadata);
    return answer;
  });
}

function enforceScopedPolicy(request: FastifyRequest, bookingHotelId: string | undefined) {
  if (!bookingHotelId) return request.authContext!;
  return enforceRoutePolicy(request, {
    permission: "intelligence.ask.read",
    entitlement: {
      product: "booking",
      key: "booking-engine",
      resource: { product: "booking", resourceType: "booking_hotel", resourceId: bookingHotelId },
    },
    resource: {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: bookingHotelId,
      allowedRelationships: ["owner", "operator"],
    },
  });
}

function parseAskRequest(
  body: unknown,
): { ok: true; body: AskRequestBody } | { ok: false; body: AskRequestBody; message: string } {
  const fallback = { question: "", scope: { organizationId: "" } };
  if (!record(body))
    return { ok: false, body: fallback, message: "Ask request body must be an object." };
  const scope = record(body.scope) ? body.scope : {};
  const parsed = {
    question: typeof body.question === "string" ? body.question.trim() : "",
    scope: {
      organizationId: typeof scope.organizationId === "string" ? scope.organizationId.trim() : "",
      bookingHotelId: optionalString(scope.bookingHotelId),
      pmsHotelId: optionalString(scope.pmsHotelId),
      dateRange: dateRange(scope.dateRange),
      locale: optionalString(scope.locale),
      currency: optionalString(scope.currency),
    },
  };
  if (!parsed.question) return { ok: false, body: parsed, message: "Ask question is required." };
  if (!parsed.scope.organizationId) {
    return { ok: false, body: parsed, message: "Ask scope must include a selected organization." };
  }
  return { ok: true, body: parsed };
}

function parseFallback(body: unknown): AskRequestBody {
  return parseAskRequest(body).body;
}

function createFixtureAskEvidenceRepository(): AskEvidenceRepository {
  return {
    async findMetricEvidence({ metricKeys, resourceId, dateRange, filters }) {
      return fixtureEvidence(resourceId, dateRange, filters).filter((entry) =>
        metricKeys.includes(entry.metricKey),
      );
    },
    async findSetupEvidence({ resourceId, filters }) {
      return fixtureEvidence(resourceId, undefined, filters).filter(
        (entry) => entry.metricKey === "hotel_catalog.setup_completeness_score",
      );
    },
  };
}

function fixtureEvidence(
  resourceId: string,
  dateRange: AskScope["dateRange"],
  filters: Record<string, unknown>,
): AskEvidenceEntry[] {
  const base = {
    resourceId,
    resourceType: "booking_hotel" as const,
    filters: { ...filters, ...(dateRange ? { dateRange } : {}) },
    freshness: { status: "fresh" as const, generatedAt: "2026-06-09T08:30:00Z" },
  };
  return [
    {
      ...base,
      evidenceId: "ev_booking_direct_share",
      sourceOwner: "booking",
      sourceView: "direct_booking_summary_read_model",
      product: "booking",
      metricKey: "booking.direct_booking_share",
      quality: "complete",
      sampleSize: 48,
      aggregateId: "booking.direct_booking_share.fixture",
      valueSummary: {
        directSharePct: 62.5,
        previousDirectSharePct: 71.2,
        includedBookingCount: 48,
      },
    },
    {
      ...base,
      evidenceId: "ev_booking_revenue",
      sourceOwner: "booking",
      sourceView: "direct_booking_summary_read_model",
      product: "booking",
      metricKey: "booking.gross_booking_revenue",
      quality: "complete",
      sampleSize: 48,
      aggregateId: "booking.gross_booking_revenue.fixture",
      valueSummary: { grossRevenue: 18420, currency: "EUR" },
    },
    {
      ...base,
      evidenceId: "ev_booking_adr",
      sourceOwner: "booking",
      sourceView: "direct_booking_summary_read_model",
      product: "booking",
      metricKey: "booking.average_daily_rate",
      quality: "complete",
      sampleSize: 48,
      aggregateId: "booking.average_daily_rate.fixture",
      valueSummary: { averageDailyRate: 148, currency: "EUR" },
    },
    {
      ...base,
      evidenceId: "ev_booking_source_mix",
      sourceOwner: "booking",
      sourceView: "direct_booking_summary_read_model",
      product: "booking",
      metricKey: "booking.booking_source_mix",
      quality: "complete",
      sampleSize: 48,
      aggregateId: "booking.booking_source_mix.fixture",
      valueSummary: {
        topSource: "direct",
        directBookings: 30,
        otaBookings: 18,
      },
    },
    {
      ...base,
      evidenceId: "ev_setup_payment_gap",
      sourceOwner: "intelligence",
      sourceView: "setup_completeness_snapshots",
      product: "intelligence",
      metricKey: "hotel_catalog.setup_completeness_score",
      quality: "partial",
      sampleSize: 2,
      aggregateId: "hotel_catalog.setup_completeness_score.fixture",
      valueSummary: {
        score: 70,
        blockingArea: "payments",
        blockingItem: "online_payment",
      },
    },
  ];
}

function createDeterministicAskModel(): Model {
  return {
    async getResponse(request) {
      const toolResults = toolResultsFromInput(request.input);
      if (toolResults.length === 0) {
        return modelResponse(
          request,
          request.tools
            .filter((tool) => tool.type === "function")
            .map((tool, index) => ({
              type: "function_call",
              callId: `ask_tool_call_${index + 1}_${tool.name}`,
              name: tool.name,
              arguments: JSON.stringify({ filters: {} }),
              status: "completed",
            })),
        );
      }
      return modelResponse(request, [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(modelOutputFromToolResults(toolResults)),
            },
          ],
        },
      ]);
    },
    async *getStreamedResponse() {
      throw new Error("Ask route deterministic model does not support streaming");
    },
  };
}

function modelResponse(request: ModelRequest, output: ModelResponse["output"]): ModelResponse {
  return {
    usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    output,
    responseId: `ask_model_response_${request.input instanceof Array ? request.input.length : 1}`,
    requestId: `ask_model_request_${request.input instanceof Array ? request.input.length : 1}`,
  };
}

function toolResultsFromInput(input: ModelRequest["input"]): AskEvidenceToolResult[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    if (!record(item) || item.type !== "function_call_result") return [];
    const output = record(item.output) && item.output.type === "text" ? item.output.text : null;
    if (typeof output !== "string") return [];
    try {
      return [JSON.parse(output) as AskEvidenceToolResult];
    } catch {
      return [];
    }
  });
}

function modelOutputFromToolResults(toolResults: AskEvidenceToolResult[]): AskModelOutput {
  const evidence = toolResults.flatMap((result) => result.evidence);
  const unavailableData = toolResults.flatMap((result) => result.unavailableData);
  const denied = toolResults.some((result) => result.status === "not_authorized");
  const firstEvidenceId = evidence[0]?.evidenceId;
  return {
    status: denied
      ? "not_authorized"
      : evidence.length > 0
        ? unavailableData.length > 0 || evidence.some((entry) => entry.quality === "partial")
          ? "partial"
          : "answered"
        : "unavailable",
    summary: summarizeToolResults(evidence, unavailableData),
    blocks: evidence.map((entry) => blockFromEvidence(entry)),
    caveats: unavailableData.map((item) => ({
      code: item.reason,
      message: `The ${item.requestedToolId} source reported ${item.reason}.`,
      evidenceIds: [],
    })),
    suggestedActions: firstEvidenceId
      ? [
          {
            type: evidence.some((entry) => entry.metricKey.startsWith("hotel_catalog."))
              ? "open_settings"
              : "view_report",
            label: evidence.some((entry) => entry.metricKey.startsWith("hotel_catalog."))
              ? "Open setup settings"
              : "View the underlying report",
            evidenceIds: [firstEvidenceId],
          },
        ]
      : [],
    followUpQuestions: [],
  };
}

function summarizeToolResults(
  evidence: AskEvidenceEntry[],
  unavailableData: AskEvidenceToolResult["unavailableData"],
): string {
  if (evidence.some((entry) => entry.metricKey === "hotel_catalog.setup_completeness_score")) {
    return "Setup completeness has approved internal evidence, with payment setup still incomplete.";
  }
  if (evidence.some((entry) => entry.metricKey === "booking.booking_source_mix")) {
    return "Booking source mix is available from approved internal booking evidence.";
  }
  if (evidence.some((entry) => entry.metricKey === "booking.direct_booking_share")) {
    return "Direct booking performance is available from approved internal booking evidence.";
  }
  if (unavailableData.length > 0) {
    return "I could not load enough approved internal evidence to answer this question.";
  }
  return "No approved Ask Intelligence evidence was returned for this question.";
}

function blockFromEvidence(entry: AskEvidenceEntry): AskModelOutput["blocks"][number] {
  return {
    type: entry.metricKey.startsWith("hotel_catalog.") ? "setup_gap" : "metric",
    metricKey: entry.metricKey,
    value: numericValue(entry.valueSummary),
    unit: unitForMetric(entry.metricKey),
    text: textForEvidence(entry),
    evidenceIds: [entry.evidenceId],
  };
}

function numericValue(valueSummary: Record<string, unknown>): number | null {
  for (const value of Object.values(valueSummary)) {
    if (typeof value === "number") return value;
  }
  return null;
}

function unitForMetric(metricKey: string): AskModelOutput["blocks"][number]["unit"] {
  if (metricKey.includes("share")) return "percentage";
  if (metricKey.includes("revenue") || metricKey.includes("rate")) return "currency";
  if (metricKey.includes("score")) return "score";
  return "count";
}

function textForEvidence(entry: AskEvidenceEntry): string | null {
  if (entry.metricKey === "booking.booking_source_mix") {
    return `Top source: ${String(entry.valueSummary.topSource ?? "unknown")}.`;
  }
  if (entry.metricKey === "hotel_catalog.setup_completeness_score") {
    return `Blocking setup area: ${String(entry.valueSummary.blockingArea ?? "unknown")}.`;
  }
  return null;
}

function notAuthorized(request: FastifyRequest, body: AskRequestBody, error: unknown) {
  const reason = authReason(error, request, body.scope.bookingHotelId);
  return envelope(request, body, request.authContext, {
    status: "not_authorized",
    summary: "I cannot access that Ask Intelligence scope with the current authorization context.",
    unavailableData: unavailable("unavailable_ask_authorization", reason, {
      requestedResource: body.scope.bookingHotelId
        ? { type: "booking_hotel", id: body.scope.bookingHotelId }
        : undefined,
      canRetry: reason === "missing_permission",
      canClarify: reason === "not_linked_resource",
    }),
    confidence: { level: "unknown", reasons: [reason] },
    deniedToolCallIds: ["tool_call_ask_authorization_denied"],
  });
}

function envelope(
  request: FastifyRequest,
  body: AskRequestBody,
  context: RequestContext | null,
  overrides: AskEnvelopeOverrides,
): AskAnswer {
  const requestId = context?.audit.requestId ?? request.id;
  return {
    answerId: `ask_answer_${requestId}`,
    contractVersion: "ask-intelligence-evidence.v1",
    generatedAt: "2026-06-10T00:00:00.000Z",
    conversationId: `ask_conversation_${requestId}`,
    runId: `ask_run_${requestId}`,
    question: body.question,
    scope: body.scope,
    status: overrides.status ?? "unavailable",
    summary: overrides.summary ?? "",
    blocks: overrides.blocks ?? [],
    evidenceReferences: overrides.evidenceReferences ?? [],
    unavailableData: overrides.unavailableData ?? [],
    caveats: overrides.caveats ?? [],
    confidence: overrides.confidence ?? { level: "unknown", reasons: [] },
    suggestedActions: overrides.suggestedActions ?? [],
    followUpQuestions: overrides.followUpQuestions ?? [],
    audit: {
      requestId,
      actorInternalUserId: context?.actor.internalUserId ?? null,
      organizationId: context?.selectedOrganization.organizationId ?? null,
      toolCallIds: (overrides.evidenceReferences ?? []).map((item) => String(item.toolCallId)),
      deniedToolCallIds: (overrides.audit?.deniedToolCallIds ??
        overrides.deniedToolCallIds ??
        []) as string[],
    },
  };
}

async function recordAudit(
  request: FastifyRequest,
  repository: AskAuditRepository,
  answer: AskAnswer,
  telemetry: AskAgentRunTelemetry | null,
  modelMetadata: AskRoutesOptions["modelMetadata"] | null,
) {
  try {
    await repository.recordAskRun({
      requestId: answer.audit.requestId,
      actorInternalUserId: answer.audit.actorInternalUserId,
      organizationId: answer.audit.organizationId,
      bookingHotelId: answer.scope.bookingHotelId ?? null,
      question: answer.question,
      status: answer.status,
      answerId: answer.answerId,
      summary: answer.summary,
      blocks: answer.blocks,
      conversationId: answer.conversationId,
      runId: answer.runId,
      contractVersion: answer.contractVersion,
      generatedAt: answer.generatedAt,
      scope: answer.scope,
      toolPlan: telemetry?.plan ? (telemetry.plan as unknown as Record<string, unknown>) : null,
      toolResults: telemetry?.toolResults ?? [],
      toolCallIds: answer.audit.toolCallIds,
      deniedToolCallIds: answer.audit.deniedToolCallIds,
      evidenceIds: telemetry?.evidenceIds ?? evidenceIds(answer),
      evidenceReferences: answer.evidenceReferences,
      unavailableData: answer.unavailableData,
      caveats: answer.caveats,
      confidence: answer.confidence,
      suggestedActions: answer.suggestedActions,
      followUpQuestions: answer.followUpQuestions,
      modelProvider: modelMetadata?.provider ?? null,
      modelName: modelMetadata?.model ?? null,
      promptVersion: telemetry?.promptVersion ?? ASK_PROMPT_VERSION,
      answerSchemaVersion: telemetry?.answerSchemaVersion ?? ASK_ANSWER_SCHEMA_VERSION,
      traceId: telemetry?.traceId ?? null,
      modelResponseIds: telemetry?.modelResponseIds ?? [],
      modelRequestIds: telemetry?.modelRequestIds ?? [],
      latencyMs: telemetry?.latencyMs ?? null,
      usage: telemetry?.usage ?? null,
      estimatedCostUsd: null,
      failure: telemetry?.failure ?? null,
    });
  } catch (error) {
    // Ask answers remain available when the audit sink is unavailable. The
    // failure is logged with the request ID and covered by route tests.
    request.log.warn(
      { err: error, requestId: answer.audit.requestId },
      "Ask Intelligence audit persistence failed",
    );
  }
}

function evidenceIds(answer: AskAnswer): string[] {
  return answer.evidenceReferences
    .map((reference) => reference.evidenceId)
    .filter((id): id is string => typeof id === "string");
}

function unavailable(id: string, reason: string, extra: Record<string, unknown> = {}) {
  return [{ unavailableDataId: id, reason, canRetry: true, canClarify: true, ...extra }];
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function dateRange(value: unknown): AskScope["dateRange"] {
  return record(value) && typeof value.from === "string" && typeof value.to === "string"
    ? { from: value.from, to: value.to }
    : undefined;
}

function statusCode(error: unknown): 401 | 403 {
  return statusError(error) && error.statusCode === 401 ? 401 : 403;
}

function authReason(error: unknown, request: FastifyRequest, bookingHotelId: string | undefined) {
  if (!statusError(error) || error.statusCode === 401) return "missing_permission";
  const message = error.message.toLowerCase();
  if (message.includes("permission")) return "missing_permission";
  if (message.includes("entitlement")) {
    return hasInactiveBookingEngineEntitlement(request, bookingHotelId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "not_linked_resource";
}

function hasInactiveBookingEngineEntitlement(
  request: FastifyRequest,
  bookingHotelId: string | undefined,
): boolean {
  return Boolean(
    request.authContext?.entitlements.some((entitlement) => {
      if (
        entitlement.product !== "booking" ||
        entitlement.key !== "booking-engine" ||
        entitlement.status === "active"
      ) {
        return false;
      }

      return (
        !bookingHotelId ||
        entitlement.resource === undefined ||
        (entitlement.resource.product === "booking" &&
          entitlement.resource.resourceType === "booking_hotel" &&
          entitlement.resource.resourceId === bookingHotelId)
      );
    }),
  );
}

function statusError(error: unknown): error is Error & { statusCode: number } {
  return error instanceof Error && "statusCode" in error && typeof error.statusCode === "number";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
