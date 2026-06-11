import { askAnswerSchema } from "./answerSchema.js";
import { ASK_CONTRACT_VERSION, type AskAnswer, type AskScope } from "./ask.js";
import { computeAskConfidence } from "./confidence.js";
import type { AskEvidenceEntry, AskEvidenceToolResult } from "./evidence.js";
import type { AskModelBlock, AskModelOutput } from "./modelOutput.js";
import type { AskPlan, AskQuestionIntent } from "./planner.js";

/** Terminal loop failures that must degrade, never produce confident prose. */
export type AskRunFailure =
  | "budget_exhausted"
  | "run_timeout"
  | "invalid_model_output"
  | "provider_error"
  | "model_refusal_safety";

export type AskRunIdentity = {
  requestId: string;
  conversationId: string;
  runId: string;
  answerId: string;
  generatedAt: string;
  actorInternalUserId: string | null;
  organizationId: string | null;
};

export type AskComposeInput = {
  question: string;
  scope: AskScope;
  identity: AskRunIdentity;
  plan: AskPlan;
  modelOutput: AskModelOutput | null;
  toolResults: AskEvidenceToolResult[];
  failure: AskRunFailure | null;
};

/** Block types whose claims are material and must cite authorized evidence. */
const MATERIAL_BLOCK_TYPES = new Set([
  "metric",
  "trend",
  "breakdown",
  "table",
  "setup_gap",
  "recommendation",
]);

const WRITE_ACTION_SUGGESTION: Record<AskQuestionIntent, "adjust_rate_review" | "open_settings"> = {
  booking_performance: "adjust_rate_review",
  booking_source_mix: "adjust_rate_review",
  conversion_funnel: "adjust_rate_review",
  performance_overview: "adjust_rate_review",
  setup_completeness: "open_settings",
};

/**
 * Deterministically composes the final AskAnswer envelope from the plan, the
 * authorized evidence pack, and (when the loop ran) the model's structured
 * output. Owns layer-two validation per the VAY-736 decision: material
 * claims must cite collected evidence or be dropped, statuses are reconciled
 * against the evidence pack, and confidence comes from evidence metadata
 * only. The returned envelope always passes `askAnswerSchema`.
 */
export function composeAskAnswer(input: AskComposeInput): AskAnswer {
  return askAnswerSchema.parse(buildAnswer(input)) as AskAnswer;
}

function buildAnswer(input: AskComposeInput): AskAnswer {
  switch (input.plan.kind) {
    case "needs_clarification":
      return envelope(input, {
        status: "needs_clarification",
        summary: "I need a clearer scope before I can answer from approved Vayada data.",
        unavailableData: [
          unavailableItem("unavailable_ask_scope_clarification", "missing_scope", {
            canRetry: true,
            canClarify: true,
          }),
        ],
        followUpQuestions: input.plan.followUpQuestions,
      });
    case "external_data_needed":
      return envelope(input, {
        status: "external_data_needed",
        summary: "I cannot answer that from the approved internal-data catalog.",
        unavailableData: [
          unavailableItem("unavailable_external_enrichment", "external_data_needed", {
            topic: input.plan.topic,
            canRetry: false,
            canClarify: false,
          }),
        ],
        suggestedActions: [
          { type: "request_enrichment", label: "Request an enrichment connector", evidenceIds: [] },
        ],
      });
    case "write_action":
      return envelope(input, {
        status: "unavailable",
        summary:
          "I can analyze and suggest, but I do not execute changes. Here is a suggested next step instead.",
        unavailableData: [
          unavailableItem("unavailable_write_action", "write_action_not_supported", {
            canRetry: false,
            canClarify: true,
          }),
        ],
        caveats: [
          {
            code: "action_not_executed",
            message: "No change was made; suggested actions require an explicit action flow.",
            evidenceIds: [],
          },
        ],
        suggestedActions: [
          {
            type: input.plan.intent ? WRITE_ACTION_SUGGESTION[input.plan.intent] : "create_task",
            label: "Review this change in settings before applying it",
            evidenceIds: [],
          },
        ],
      });
    case "cross_tenant":
      return envelope(input, {
        status: "not_authorized",
        summary:
          input.plan.reason === "organization_mismatch"
            ? "I cannot answer for an organization outside the selected request context."
            : "I can only use this organization's own data — cross-tenant comparisons are not available.",
        unavailableData: [
          unavailableItem("unavailable_ask_tenant_boundary", "not_linked_resource", {
            canRetry: false,
            canClarify: input.plan.reason === "cross_tenant_question",
          }),
        ],
        deniedToolCallIds: [`tool_call_ask_tenant_denied_${input.identity.requestId}`],
      });
    case "unsupported":
      if (input.plan.reason === "blocked_sql") {
        return envelope(input, {
          status: "unavailable",
          summary: "I cannot run database queries; I answer from approved metric tools only.",
          unavailableData: [
            unavailableItem("unavailable_blocked_request", "unsupported_request", {
              canRetry: false,
              canClarify: false,
            }),
          ],
        });
      }
      return envelope(input, {
        status: "unavailable",
        summary: "No approved Ask Intelligence metric can answer this question yet.",
        unavailableData: [
          unavailableItem("unavailable_uncataloged_question", "source_not_in_catalog", {
            canRetry: false,
            canClarify: true,
          }),
        ],
        followUpQuestions: [
          "Ask about direct booking share, source mix, revenue, ADR, conversion funnel, or setup completeness.",
        ],
      });
    case "run_tools":
      return composeRunAnswer(input);
  }
}

function composeRunAnswer(input: AskComposeInput): AskAnswer {
  const evidenceById = new Map<string, AskEvidenceEntry>();
  for (const result of input.toolResults) {
    for (const entry of result.evidence) evidenceById.set(entry.evidenceId, entry);
  }
  const toolCallIds = input.toolResults.map((result) => result.toolCallId);
  const deniedToolCallIds = input.toolResults
    .filter((result) => result.status === "not_authorized")
    .map((result) => result.toolCallId);
  const failedToolCount = input.toolResults.filter(
    (result) =>
      result.status === "error" ||
      result.status === "not_authorized" ||
      result.status === "invalid_scope",
  ).length;
  const unavailableData: Record<string, unknown>[] = dedupeUnavailable(
    input.toolResults.flatMap((result) => result.unavailableData),
  );
  if (input.failure) unavailableData.push(failureUnavailable(input.failure));

  if (!input.modelOutput) {
    const confidence = computeAskConfidence({
      evidence: [],
      failedToolCount: failedToolCount + (input.failure ? 1 : 0),
      unavailableDataCount: unavailableData.length,
    });
    return envelope(input, {
      status: evidenceById.size > 0 ? "partial" : "unavailable",
      summary: "I could not finish synthesizing a reliable answer from the approved data sources.",
      unavailableData,
      confidence,
      toolCallIds,
      deniedToolCallIds,
    });
  }

  const output = input.modelOutput;
  const caveats = output.caveats.map((caveat) => ({
    ...caveat,
    evidenceIds: caveat.evidenceIds.filter((id) => evidenceById.has(id)),
  }));
  const suggestedActions = output.suggestedActions.map((action) => ({
    ...action,
    evidenceIds: action.evidenceIds.filter((id) => evidenceById.has(id)),
  }));

  const blocks: Record<string, unknown>[] = [];
  let droppedUncitedBlocks = 0;
  for (const block of output.blocks) {
    const citedIds = block.evidenceIds.filter((id) => evidenceById.has(id));
    if (MATERIAL_BLOCK_TYPES.has(block.type) && citedIds.length === 0) {
      droppedUncitedBlocks += 1;
      continue;
    }
    blocks.push(toEnvelopeBlock(block, citedIds));
  }
  if (droppedUncitedBlocks > 0) {
    caveats.push({
      code: "uncited_claims_removed",
      message: `${droppedUncitedBlocks} claim(s) were removed because they did not cite authorized evidence.`,
      evidenceIds: [],
    });
  }

  const citedEvidenceIds = new Set(
    [...blocks, ...caveats, ...suggestedActions].flatMap(
      (item) => (item.evidenceIds as string[] | undefined) ?? [],
    ),
  );
  const citedEvidence = [...citedEvidenceIds]
    .map((id) => evidenceById.get(id))
    .filter((entry): entry is AskEvidenceEntry => entry !== undefined);
  const evidenceReferences = citedEvidence.map((entry) => toEvidenceReference(entry, input));

  const status = reconcileStatus(output, blocks, citedEvidence, unavailableData, {
    hasDeniedTool: deniedToolCallIds.length > 0,
    droppedUncitedBlocks,
  });
  const confidence = computeAskConfidence({
    evidence: citedEvidence,
    failedToolCount,
    unavailableDataCount: unavailableData.length,
  });

  return envelope(input, {
    status,
    summary: output.summary,
    blocks,
    evidenceReferences,
    unavailableData,
    caveats,
    confidence,
    suggestedActions,
    followUpQuestions: output.followUpQuestions,
    toolCallIds,
    deniedToolCallIds,
  });
}

function reconcileStatus(
  output: AskModelOutput,
  blocks: Record<string, unknown>[],
  citedEvidence: AskEvidenceEntry[],
  unavailableData: Record<string, unknown>[],
  context: { hasDeniedTool: boolean; droppedUncitedBlocks: number },
): AskAnswer["status"] {
  // The model is not the authority for authorization outcomes.
  if (output.status === "not_authorized" && !context.hasDeniedTool) return "unavailable";
  if (output.status === "answered" || output.status === "partial") {
    if (citedEvidence.length === 0) return "unavailable";
    if (
      output.status === "answered" &&
      (unavailableData.length > 0 || context.droppedUncitedBlocks > 0)
    ) {
      return "partial";
    }
  }
  return output.status;
}

function toEnvelopeBlock(block: AskModelBlock, citedIds: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = { type: block.type, evidenceIds: citedIds };
  if (block.metricKey !== null) result.metricKey = block.metricKey;
  if (block.value !== null) result.value = block.value;
  if (block.unit !== null) result.unit = block.unit;
  if (block.text !== null) result.text = block.text;
  return result;
}

function toEvidenceReference(
  entry: AskEvidenceEntry,
  input: AskComposeInput,
): Record<string, unknown> {
  const toolResult = input.toolResults.find((result) =>
    result.evidence.some((candidate) => candidate.evidenceId === entry.evidenceId),
  );
  return {
    evidenceId: entry.evidenceId,
    toolCallId: toolResult?.toolCallId ?? "",
    toolId: toolResult?.toolId ?? "",
    sourceOwner: entry.sourceOwner,
    sourceView: entry.sourceView,
    resource: { type: entry.resourceType, id: entry.resourceId },
    metricKey: entry.metricKey,
    filters: entry.filters,
    freshness: entry.freshness,
    quality: entry.quality,
    ...(entry.sampleSize !== undefined ? { sampleSize: entry.sampleSize } : {}),
    ...(entry.aggregateId !== undefined ? { aggregateId: entry.aggregateId } : {}),
  };
}

function failureUnavailable(failure: AskRunFailure): Record<string, unknown> {
  const reasonByFailure: Record<AskRunFailure, string> = {
    budget_exhausted: "tool_budget_exhausted",
    run_timeout: "run_timeout",
    invalid_model_output: "invalid_model_output",
    provider_error: "provider_unavailable",
    model_refusal_safety: "pii_restricted",
  };
  return unavailableItem(`unavailable_${failure}`, reasonByFailure[failure], {
    canRetry: failure !== "model_refusal_safety",
    canClarify: false,
  });
}

function dedupeUnavailable(items: { unavailableDataId: string }[]): Record<string, unknown>[] {
  const seen = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    if (!seen.has(item.unavailableDataId)) {
      seen.set(item.unavailableDataId, item as unknown as Record<string, unknown>);
    }
  }
  return [...seen.values()];
}

function unavailableItem(
  id: string,
  reason: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return { unavailableDataId: id, reason, ...extra };
}

type EnvelopeOverrides = Partial<Omit<AskAnswer, "audit">> & {
  toolCallIds?: string[];
  deniedToolCallIds?: string[];
};

function envelope(input: AskComposeInput, overrides: EnvelopeOverrides): AskAnswer {
  return {
    answerId: input.identity.answerId,
    contractVersion: ASK_CONTRACT_VERSION,
    generatedAt: input.identity.generatedAt,
    conversationId: input.identity.conversationId,
    runId: input.identity.runId,
    question: input.question,
    scope: input.scope,
    status: overrides.status ?? "unavailable",
    summary: overrides.summary ?? "",
    blocks: overrides.blocks ?? [],
    evidenceReferences: overrides.evidenceReferences ?? [],
    unavailableData: overrides.unavailableData ?? [],
    caveats: overrides.caveats ?? [],
    confidence: overrides.confidence ?? { level: "unknown", reasons: [statusReason(overrides)] },
    suggestedActions: overrides.suggestedActions ?? [],
    followUpQuestions: overrides.followUpQuestions ?? [],
    audit: {
      requestId: input.identity.requestId,
      actorInternalUserId: input.identity.actorInternalUserId,
      organizationId: input.identity.organizationId,
      toolCallIds: overrides.toolCallIds ?? [],
      deniedToolCallIds: overrides.deniedToolCallIds ?? [],
    },
  };
}

function statusReason(overrides: EnvelopeOverrides): string {
  const first = overrides.unavailableData?.[0];
  if (first && typeof first.reason === "string") return first.reason;
  return "no_evidence";
}
