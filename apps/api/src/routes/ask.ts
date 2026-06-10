import type { RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

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

export type AskStatus =
  | "answered"
  | "partial"
  | "needs_clarification"
  | "unavailable"
  | "external_data_needed"
  | "not_authorized";

export type AskScope = {
  organizationId: string;
  bookingHotelId?: string;
  pmsHotelId?: string;
  dateRange?: { from: string; to: string };
  locale?: string;
  currency?: string;
};

export type AskAnswer = {
  answerId: string;
  contractVersion: "ask-intelligence-evidence.v1";
  generatedAt: string;
  conversationId: string;
  runId: string;
  question: string;
  scope: AskScope;
  status: AskStatus;
  summary: string;
  blocks: Record<string, unknown>[];
  evidenceReferences: Record<string, unknown>[];
  unavailableData: Record<string, unknown>[];
  caveats: Record<string, unknown>[];
  confidence: { level: "high" | "medium" | "low" | "unknown"; reasons: string[] };
  suggestedActions: Record<string, unknown>[];
  followUpQuestions: string[];
  audit: {
    requestId: string;
    actorInternalUserId: string | null;
    organizationId: string | null;
    toolCallIds: string[];
    deniedToolCallIds: string[];
  };
};

export type AskAuditRecord = Pick<AskAnswer, "answerId" | "generatedAt" | "question" | "status"> & {
  requestId: string;
  actorInternalUserId: string | null;
  organizationId: string | null;
  bookingHotelId: string | null;
};

export type AskAuditRepository = {
  recordAskRun(record: AskAuditRecord): Promise<void>;
  close?(): Promise<void>;
};

export type AskRoutesOptions = {
  auditRepository?: AskAuditRepository;
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
  app.addHook("onClose", async () => auditRepository.close?.());

  app.post<{ Body: unknown }>("/ask", async (request, reply) => {
    let baseContext: RequestContext;
    try {
      baseContext = enforceRoutePolicy(request, { permission: "intelligence.ask.read" });
    } catch (error) {
      const answer = notAuthorized(request, parseFallback(request.body), error);
      await recordAudit(auditRepository, answer);
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
      await recordAudit(auditRepository, answer);
      return reply.code(400).send(answer);
    }

    let scopedContext: RequestContext;
    try {
      scopedContext = enforceScopedPolicy(request, parsed.body.scope.bookingHotelId);
    } catch (error) {
      const answer = notAuthorized(request, parsed.body, error);
      await recordAudit(auditRepository, answer);
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
      await recordAudit(auditRepository, answer);
      return reply.code(403).send(answer);
    }

    const answer = fixtureAnswer(request, parsed.body, scopedContext);
    await recordAudit(auditRepository, answer);
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
      bookingHotelId:
        typeof scope.bookingHotelId === "string" ? scope.bookingHotelId.trim() : undefined,
      pmsHotelId: typeof scope.pmsHotelId === "string" ? scope.pmsHotelId.trim() : undefined,
      dateRange: dateRange(scope.dateRange),
      locale: typeof scope.locale === "string" ? scope.locale.trim() : undefined,
      currency: typeof scope.currency === "string" ? scope.currency.trim() : undefined,
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

function fixtureAnswer(
  request: FastifyRequest,
  body: AskRequestBody,
  context: RequestContext,
): AskAnswer {
  if (!body.scope.bookingHotelId || !body.scope.dateRange) {
    return envelope(request, body, context, {
      status: "needs_clarification",
      summary: "I need a hotel and date range before I can answer from approved Vayada data.",
      unavailableData: unavailable("unavailable_missing_ask_scope", "missing_scope"),
      followUpQuestions: ["Which hotel and date range should I analyze?"],
    });
  }
  if (
    /\bcompetitor|nearby|market demand|local event|weather|review|booking\.com|ota parity\b/i.test(
      body.question,
    )
  ) {
    return envelope(request, body, context, {
      status: "external_data_needed",
      summary: "I cannot answer that from the approved MVP internal-data catalog.",
      unavailableData: unavailable("unavailable_external_enrichment", "external_data_needed", {
        sourceOwner: "enrichment",
        requestedToolId: "external_enrichment",
        canRetry: false,
      }),
      confidence: { level: "unknown", reasons: ["external_data_needed"] },
      suggestedActions: [
        { type: "request_enrichment", label: "Request an enrichment connector", evidenceIds: [] },
      ],
    });
  }
  if (/\bfunnel|conversion|page view|checkout\b/i.test(body.question)) {
    return envelope(request, body, context, {
      status: "unavailable",
      summary: "The approved funnel source is not loaded for this fixture-backed Ask endpoint.",
      unavailableData: unavailable("unavailable_conversion_funnel_source", "source_unavailable", {
        sourceOwner: "booking",
        requestedToolId: "get_conversion_funnel",
      }),
      confidence: { level: "unknown", reasons: ["source_unavailable"] },
    });
  }
  if (/\bsetup|settings|complete|completeness\b/i.test(body.question)) {
    return setupAnswer(request, body, context);
  }
  if (/\bdirect|revenue|booking|share|source\b/i.test(body.question)) {
    return bookingAnswer(request, body, context);
  }
  return envelope(request, body, context, {
    status: "unavailable",
    summary: "No approved MVP Ask Intelligence metric can answer this question yet.",
    unavailableData: unavailable("unavailable_uncataloged_question", "source_not_in_catalog", {
      canRetry: false,
    }),
    confidence: { level: "unknown", reasons: ["source_not_in_catalog"] },
    followUpQuestions: [
      "Ask about direct booking share, source mix, revenue, ADR, or setup completeness.",
    ],
  });
}

function bookingAnswer(request: FastifyRequest, body: AskRequestBody, context: RequestContext) {
  const evidenceId = "ev_booking_performance_fixture";
  return envelope(request, body, context, {
    status: "answered",
    summary: "Direct booking performance is available from fixture-backed internal metrics.",
    blocks: [
      {
        type: "metric",
        metricKey: "booking.direct_booking_share",
        value: 62.5,
        unit: "percentage",
        evidenceIds: [evidenceId],
      },
    ],
    evidenceReferences: [
      evidence(body, evidenceId, "get_booking_performance", "booking.direct_booking_share"),
    ],
    caveats: [
      {
        code: "fixture_backed",
        message: "This scaffold uses deterministic fixture data until evidence tools are added.",
        evidenceIds: [evidenceId],
      },
    ],
    confidence: { level: "high", reasons: ["fresh_internal_metrics", "complete_source"] },
    suggestedActions: [
      { type: "view_report", label: "View booking performance report", evidenceIds: [evidenceId] },
    ],
  });
}

function setupAnswer(request: FastifyRequest, body: AskRequestBody, context: RequestContext) {
  const evidenceId = "ev_setup_gap_fixture";
  return envelope(request, body, context, {
    status: "partial",
    summary: "Setup completeness is partially available; payment setup still has blocking items.",
    blocks: [
      {
        type: "setup_gap",
        metricKey: "hotel_catalog.setup_completeness_score",
        value: 70,
        unit: "score",
        evidenceIds: [evidenceId],
      },
    ],
    evidenceReferences: [
      evidence(
        body,
        evidenceId,
        "get_setup_gaps",
        "hotel_catalog.setup_completeness_score",
        "intelligence",
        "setup_completeness_snapshots",
      ),
    ],
    confidence: { level: "medium", reasons: ["fresh_internal_setup_snapshot", "partial_setup"] },
    suggestedActions: [
      { type: "open_settings", label: "Open payment settings", evidenceIds: [evidenceId] },
    ],
  });
}

function notAuthorized(request: FastifyRequest, body: AskRequestBody, error: unknown) {
  const reason = authReason(error);
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

async function recordAudit(repository: AskAuditRepository, answer: AskAnswer) {
  await repository.recordAskRun({
    requestId: answer.audit.requestId,
    actorInternalUserId: answer.audit.actorInternalUserId,
    organizationId: answer.audit.organizationId,
    bookingHotelId: answer.scope.bookingHotelId ?? null,
    question: answer.question,
    status: answer.status,
    answerId: answer.answerId,
    generatedAt: answer.generatedAt,
  });
}

function evidence(
  body: AskRequestBody,
  evidenceId: string,
  toolId: string,
  metricKey: string,
  sourceOwner = "booking",
  sourceView = "direct_booking_summary_read_model",
) {
  return {
    evidenceId,
    toolCallId: `${toolId}_fixture_call`,
    toolId,
    sourceOwner,
    sourceView,
    resource: { type: "booking_hotel", id: body.scope.bookingHotelId },
    metricKey,
    dateRange: body.scope.dateRange,
    freshness: { status: "fresh", generatedAt: "2026-06-09T08:30:00Z" },
    quality: toolId === "get_setup_gaps" ? "partial" : "complete",
    sampleSize: toolId === "get_setup_gaps" ? 2 : 48,
    aggregateId: `${metricKey}.fixture`,
  };
}

function unavailable(id: string, reason: string, extra: Record<string, unknown> = {}) {
  return [{ unavailableDataId: id, reason, canRetry: true, canClarify: true, ...extra }];
}

function dateRange(value: unknown): AskScope["dateRange"] {
  return record(value) && typeof value.from === "string" && typeof value.to === "string"
    ? { from: value.from, to: value.to }
    : undefined;
}

function statusCode(error: unknown): 401 | 403 {
  return statusError(error) && error.statusCode === 401 ? 401 : 403;
}

function authReason(error: unknown) {
  if (!statusError(error) || error.statusCode === 401) return "missing_permission";
  return error.message.toLowerCase().includes("permission")
    ? "missing_permission"
    : "not_linked_resource";
}

function statusError(error: unknown): error is Error & { statusCode: number } {
  return error instanceof Error && "statusCode" in error && typeof error.statusCode === "number";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
