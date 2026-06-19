import {
  Agent,
  type ModelResponse,
  MaxTurnsExceededError,
  ModelBehaviorError,
  ModelRefusalError,
  Runner,
  ToolCallError,
  ToolTimeoutError,
  tool,
  type Model,
} from "@openai/agents";
import type { RequestContext } from "@vayada/backend-auth";
import { z } from "zod";

import type { AskAnswer, AskScope } from "./ask.js";
import { clampAskLoopBudgets, type AskLoopBudgets } from "./budgets.js";
import { composeAskAnswer, type AskRunFailure, type AskRunIdentity } from "./composer.js";
import type {
  AskEvidenceToolId,
  AskEvidenceToolResult,
  AskEvidenceToolScope,
  AskUnavailableData,
} from "./evidence.js";
import { askModelOutputSchema, type AskModelOutput } from "./modelOutput.js";
import { planAskQuestion, type AskPlan, type AskPlannedToolCall } from "./planner.js";
import {
  ASK_ANSWER_SCHEMA_VERSION,
  ASK_PROMPT_VERSION,
  type AskAgentRuntime,
  type AskConversationState,
  type AskRunRequest,
} from "./runtime.js";

export type AskEvidenceToolExecutor = (
  context: RequestContext,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown>,
) => Promise<AskEvidenceToolResult>;

export type AskEvidenceToolExecutors = Partial<Record<AskEvidenceToolId, AskEvidenceToolExecutor>>;

export type AskAgentRuntimeConfig = {
  model: Model;
  evidenceTools: AskEvidenceToolExecutors;
  budgets?: Partial<AskLoopBudgets>;
  now?: () => Date;
  onRunComplete?: (telemetry: AskAgentRunTelemetry) => Promise<void> | void;
};

export type AskAgentRunTelemetry = {
  identity: AskRunIdentity;
  promptVersion: typeof ASK_PROMPT_VERSION;
  answerSchemaVersion: typeof ASK_ANSWER_SCHEMA_VERSION;
  plan: AskPlan;
  status: AskAnswer["status"];
  failure: AskRunFailure | null;
  latencyMs: number;
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
  traceId: string;
  modelResponseIds: string[];
  modelRequestIds: string[];
  toolCallIds: string[];
  deniedToolCallIds: string[];
  evidenceIds: string[];
  toolResults: AskEvidenceToolResult[];
};

type AskRuntimeContext = {
  requestContext: RequestContext;
  request: AskRunRequest;
  identity: AskRunIdentity;
  plan: Extract<AskPlan, { kind: "run_tools" }>;
  budgets: AskLoopBudgets;
  evidenceTools: AskEvidenceToolExecutors;
  toolResults: AskEvidenceToolResult[];
  toolCallCounts: Map<AskEvidenceToolId, number>;
  toolCallsStarted: number;
};

const TOOL_INPUT_SCHEMA = z.strictObject({
  filters: z.record(z.string(), z.unknown()),
});

class AskToolBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskToolBudgetExceededError";
  }
}

class AskRunTimeoutError extends Error {
  constructor() {
    super("Ask Intelligence run timed out");
    this.name = "AskRunTimeoutError";
  }
}

export function createOpenAIAgentsAskRuntime(config: AskAgentRuntimeConfig): AskAgentRuntime {
  const budgets = clampAskLoopBudgets(config.budgets);
  const runner = new Runner({
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    workflowName: "ask-intelligence",
  });
  const now = config.now ?? (() => new Date());

  return {
    async answer(request, context) {
      const startedAt = Date.now();
      const identity = buildIdentity(request, context, now());
      const plan = planAskQuestion({
        question: request.question,
        scope: request.scope,
        selectedOrganizationId: context.selectedOrganization.organizationId,
      });

      if (plan.kind !== "run_tools") {
        const answer = composeAskAnswer({
          question: request.question,
          scope: request.scope,
          identity,
          plan,
          modelOutput: null,
          toolResults: [],
          failure: null,
        });
        await config.onRunComplete?.(
          buildTelemetry({
            identity,
            plan,
            answer,
            failure: null,
            latencyMs: Date.now() - startedAt,
            usage: null,
            rawResponses: [],
            toolResults: [],
          }),
        );
        return answer;
      }

      const runtimeContext: AskRuntimeContext = {
        requestContext: context,
        request,
        identity,
        plan,
        budgets,
        evidenceTools: config.evidenceTools,
        toolResults: [],
        toolCallCounts: new Map(),
        toolCallsStarted: 0,
      };

      const agent = new Agent<AskRuntimeContext, typeof askModelOutputSchema>({
        name: "VayadaAskIntelligence",
        instructions: buildInstructions(plan, request.conversationState),
        model: config.model,
        modelSettings: {
          parallelToolCalls: budgets.maxConcurrentToolCalls > 1,
          toolChoice: "auto",
          store: false,
          retry: {
            maxRetries: budgets.maxProviderRetries,
            policy: ({ attempt, maxRetries }) => attempt <= maxRetries,
          },
        },
        tools: plan.toolPlan.map((plannedTool) => evidenceTool(plannedTool)),
        outputType: askModelOutputSchema,
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), budgets.runTimeoutMs);
      let modelOutput: AskModelOutput | null = null;
      let failure: AskRunFailure | null = null;
      let rawResponses: ModelResponse[] = [];
      let usage: AskAgentRunTelemetry["usage"] = null;

      try {
        const result = await withTimeout(
          runner.run(agent, buildRunInput(request, plan), {
            context: runtimeContext,
            maxTurns: budgets.maxModelTurns,
            signal: controller.signal,
            toolExecution: { maxFunctionToolConcurrency: budgets.maxConcurrentToolCalls },
          }),
          budgets.runTimeoutMs,
        );
        rawResponses = result.rawResponses;
        usage = {
          requests: result.runContext.usage.requests,
          inputTokens: result.runContext.usage.inputTokens,
          outputTokens: result.runContext.usage.outputTokens,
          totalTokens: result.runContext.usage.totalTokens,
        };
        modelOutput = result.finalOutput ?? null;
        if (!modelOutput) failure = "invalid_model_output";
      } catch (error) {
        failure = failureFromError(error);
      } finally {
        clearTimeout(timeout);
      }

      const answer = composeAskAnswer({
        question: request.question,
        scope: request.scope,
        identity,
        plan,
        modelOutput,
        toolResults: runtimeContext.toolResults,
        failure,
      });
      await config.onRunComplete?.(
        buildTelemetry({
          identity,
          plan,
          answer,
          failure,
          latencyMs: Date.now() - startedAt,
          usage,
          rawResponses,
          toolResults: runtimeContext.toolResults,
        }),
      );
      return answer;
    },
  };
}

function evidenceTool(plannedTool: AskPlannedToolCall) {
  return tool<typeof TOOL_INPUT_SCHEMA, AskRuntimeContext, AskEvidenceToolResult>({
    name: plannedTool.toolId,
    description: `Read approved Vayada evidence for ${plannedTool.metricKeys.join(", ")}. Use only when this tool was included in the runtime plan.`,
    parameters: TOOL_INPUT_SCHEMA,
    strict: true,
    timeoutMs: undefined,
    timeoutBehavior: "raise_exception",
    execute: async (input, runContext, details) => {
      const context = requireRuntimeContext(runContext?.context);
      enforceToolBudget(context, plannedTool.toolId);

      const executor = context.evidenceTools[plannedTool.toolId];
      const result = executor
        ? await executeToolExecutor(context, plannedTool.toolId, input.filters, executor)
        : missingToolResult(context, plannedTool.toolId, input.filters);
      const callId = details?.toolCall?.callId;
      const tracked = callId ? { ...result, toolCallId: callId } : result;
      context.toolResults.push(tracked);
      return tracked;
    },
  });
}

async function executeToolExecutor(
  context: AskRuntimeContext,
  toolId: AskEvidenceToolId,
  filters: Record<string, unknown>,
  executor: AskEvidenceToolExecutor,
): Promise<AskEvidenceToolResult> {
  let attempts = 0;
  for (;;) {
    try {
      const result = await executor(context.requestContext, context.request.scope, filters);
      if (result.status !== "error" || attempts >= context.budgets.maxToolRetries) return result;
    } catch {
      if (attempts >= context.budgets.maxToolRetries) {
        return missingToolResult(context, toolId, filters);
      }
    }
    attempts += 1;
  }
}

function enforceToolBudget(context: AskRuntimeContext, toolId: AskEvidenceToolId): void {
  if (context.toolCallsStarted >= context.budgets.maxEvidenceToolCalls) {
    throw new AskToolBudgetExceededError("Ask evidence tool-call budget exhausted");
  }
  const callsForTool = context.toolCallCounts.get(toolId) ?? 0;
  if (callsForTool >= context.budgets.maxCallsPerTool) {
    throw new AskToolBudgetExceededError(`Ask evidence tool ${toolId} exceeded same-tool budget`);
  }
  context.toolCallsStarted += 1;
  context.toolCallCounts.set(toolId, callsForTool + 1);
}

function buildIdentity(
  request: AskRunRequest,
  context: RequestContext,
  generatedAt: Date,
): AskRunIdentity {
  const requestId = context.audit.requestId;
  return {
    requestId,
    conversationId: request.conversationState?.conversationId ?? `ask_conversation_${requestId}`,
    runId: `ask_run_${requestId}`,
    answerId: `ask_answer_${requestId}`,
    generatedAt: generatedAt.toISOString(),
    actorInternalUserId: context.actor.internalUserId,
    organizationId: context.selectedOrganization.organizationId,
  };
}

function buildInstructions(
  plan: Extract<AskPlan, { kind: "run_tools" }>,
  conversationState: AskConversationState | undefined,
): string {
  return [
    "You are Vayada Ask Intelligence, a read-only hotel owner analyst.",
    "Use only the provided Vayada evidence tools and only for the planned metrics.",
    "Do not execute writes, invent metric definitions, infer authorization, or use external data.",
    "Every material metric, trend, table, setup gap, or recommendation must cite evidence IDs returned by tools.",
    "If required evidence is missing, return partial or unavailable with caveats and follow-up questions.",
    `Prompt version: ${ASK_PROMPT_VERSION}. Answer schema version: ${ASK_ANSWER_SCHEMA_VERSION}.`,
    `Allowed tool plan: ${JSON.stringify(plan.toolPlan)}.`,
    `Prior redacted turns: ${JSON.stringify(conversationState?.priorTurns ?? [])}.`,
  ].join("\n");
}

function buildRunInput(request: AskRunRequest, plan: Extract<AskPlan, { kind: "run_tools" }>) {
  return JSON.stringify({
    question: request.question,
    scope: request.scope,
    intent: plan.intent,
    toolPlan: plan.toolPlan,
    clarifiedScope: request.conversationState?.clarifiedScope ?? null,
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new AskRunTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function failureFromError(error: unknown): AskRunFailure {
  if (error instanceof AskToolBudgetExceededError || error instanceof MaxTurnsExceededError) {
    return "budget_exhausted";
  }
  if (error instanceof AskRunTimeoutError || error instanceof ToolTimeoutError)
    return "run_timeout";
  if (error instanceof ModelRefusalError) return "model_refusal_safety";
  if (error instanceof ModelBehaviorError) return "invalid_model_output";
  if (error instanceof ToolCallError && error.error instanceof AskToolBudgetExceededError) {
    return "budget_exhausted";
  }
  if (error instanceof ToolCallError && error.error instanceof ToolTimeoutError)
    return "run_timeout";
  return "provider_error";
}

function requireRuntimeContext(context: AskRuntimeContext | undefined): AskRuntimeContext {
  if (!context) throw new Error("Ask runtime context is missing");
  return context;
}

function missingToolResult(
  context: AskRuntimeContext,
  toolId: AskEvidenceToolId,
  filters: Record<string, unknown>,
): AskEvidenceToolResult {
  return {
    toolCallId: `${toolId}_${context.identity.requestId}`,
    toolId,
    status: "error",
    inputScope: context.request.scope,
    filters,
    evidence: [],
    unavailableData: [unavailable(toolId, "source_unavailable")],
    audit: {
      requestId: context.identity.requestId,
      actorInternalUserId: context.requestContext.actor.internalUserId,
      organizationId: context.requestContext.selectedOrganization.organizationId,
      resourceId: resourceId(context.request.scope),
      permissionKeys: ["intelligence.ask.read"],
    },
  };
}

function unavailable(
  requestedToolId: AskEvidenceToolId,
  reason: AskUnavailableData["reason"],
): AskUnavailableData {
  return {
    unavailableDataId: `${requestedToolId}_${reason}`,
    reason,
    requestedToolId,
    canRetry: true,
    canClarify: false,
  };
}

function resourceId(scope: AskScope): string | undefined {
  return scope.bookingHotelId ?? scope.pmsHotelId;
}

function buildTelemetry(input: {
  identity: AskRunIdentity;
  plan: AskPlan;
  answer: AskAnswer;
  failure: AskRunFailure | null;
  latencyMs: number;
  usage: AskAgentRunTelemetry["usage"];
  rawResponses: ModelResponse[];
  toolResults: AskEvidenceToolResult[];
}): AskAgentRunTelemetry {
  return {
    identity: input.identity,
    promptVersion: ASK_PROMPT_VERSION,
    answerSchemaVersion: ASK_ANSWER_SCHEMA_VERSION,
    plan: input.plan,
    status: input.answer.status,
    failure: input.failure,
    latencyMs: input.latencyMs,
    usage: input.usage,
    traceId: `ask_trace_${input.identity.runId}`,
    modelResponseIds: input.rawResponses
      .map((response) => response.responseId)
      .filter((id): id is string => Boolean(id)),
    modelRequestIds: input.rawResponses
      .map((response) => response.requestId)
      .filter((id): id is string => Boolean(id)),
    toolCallIds: input.answer.audit.toolCallIds,
    deniedToolCallIds: input.answer.audit.deniedToolCallIds,
    evidenceIds: input.toolResults.flatMap((result) =>
      result.evidence.map((entry) => entry.evidenceId),
    ),
    toolResults: input.toolResults,
  };
}
