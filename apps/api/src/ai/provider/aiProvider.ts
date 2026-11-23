/**
 * The one way vayada calls an AI model (VAY-2504, plan 3.11, design note §8.3). Every AI feature
 * (Inbox buttons, the in-app assistant, Concierge, the model test) goes through `run`, so the
 * model per job, the EU-only rule, prices, the budget and the limits live in one place.
 * Only this folder imports the AI SDK (see importBoundary.test.ts). The in-app assistant
 * (VAY-2518) calls `step`: one streamed model call that may ask for tools but never runs them;
 * its loop, in ai/assistant, runs them through the action registry. Mastra can replace that loop
 * later behind the same two calls, once its licence is settled.
 */
import { createAmazonBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  generateText,
  jsonSchema,
  streamText,
  tool,
  type JSONSchema7,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type Tool,
} from "ai";

import { createCallLimit } from "./callLimit.js";

import {
  AI_PROVIDERS,
  CUSTOMER_DATA_ROUTES,
  PRICE_TABLE_VERSION,
  TASK_SETTINGS,
  costMicroUsd,
  maxCostMicroUsd,
  routeKey,
  type AiProviderName,
  type AiTask,
  type ModelRoute,
  type TaskSetting,
  type TokenUsage,
} from "./catalog.js";

export type AiSurface = "inbox" | "assistant" | "concierge" | "model_test";

/** Who a call is for. The organization's AI budget pays for it (VAY-2504 budgets). */
export type AiCallContext = {
  organizationId: string;
  propertyId: string | null;
  /** Null when no person asked, e.g. Concierge answering a guest. */
  userId: string | null;
  surface: AiSurface;
  requestId: string;
};

export type AiRunInput = {
  /** vayada's own instructions. Guest-written text belongs in `messages`, marked as data (VAY-2503). */
  instructions: string;
  messages: readonly { role: "user" | "assistant"; content: string }[];
};

export type AiRunOptions = {
  context: AiCallContext;
  /** "synthetic" is only for made-up test data; it may use routes that are not cleared for customer data. */
  data?: "customer" | "synthetic";
  /** Model test (VAY-2520) only: use this route instead of the job's setting. */
  route?: ModelRoute;
  abortSignal?: AbortSignal;
};

/** What a model call that got an answer used and cost. */
export type AiCallRecord = {
  route: ModelRoute;
  usage: TokenUsage;
  costMicroUsd: number;
  priceTableVersion: string;
  latencyMs: number;
};

export type AiRunResult =
  | ({ ok: true; text: string } & AiCallRecord)
  /** The model answered, but refused or ran out of output tokens: no usable text, still billed. */
  | ({ ok: false; reason: "refused" | "truncated" } & AiCallRecord)
  /**
   * No model was called. "unavailable": switched off, not allowed, unpriced, or the budget could
   * not be checked. "allowance_used_up": the account's monthly AI budget is spent. "busy": the
   * account already has its calls running, or the provider-call limit stayed full.
   */
  | { ok: false; reason: "unavailable" | "allowance_used_up" | "busy" }
  /** The call errored, timed out or came back empty. */
  | { ok: false; reason: "failed" };

/** Reserved before a call, against the account's monthly AI budget (ai/usage). */
export type AiReservationRequest = {
  task: AiTask;
  context: AiCallContext;
  route: ModelRoute;
  priceTableVersion: string;
  /** The most the call can cost; it counts against the budget until the call is settled. */
  reservedMicroUsd: number;
  /** How long an unsettled reservation counts as a running call (the task may have died). */
  holdMs: number;
};

export type AiReservation =
  | { ok: true; reservationId: string }
  | { ok: false; reason: "allowance_used_up" | "busy" };

export type AiSettlement =
  | { status: "completed"; costMicroUsd: number; usage: TokenUsage }
  /** No answer: cost 0 when no request was billable, else the reserved amount. */
  | { status: "failed"; costMicroUsd: number };

export type AiBudget = {
  reserve(request: AiReservationRequest): Promise<AiReservation>;
  settle(reservationId: string, settlement: AiSettlement): Promise<void>;
};

/** A conversation message as the assistant stores it: the AI SDK's ModelMessage, plain JSON. */
export type AiMessage = {
  role: "user" | "assistant" | "tool";
  content: unknown;
  providerOptions?: unknown;
};

/** A tool the model may ask for; the loop runs it, never the SDK. */
export type AiToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AiStepInput = {
  instructions: string;
  /** The whole history so far, exactly as stored. */
  messages: readonly AiMessage[];
  /** In the order they are sent, which is part of the cached prefix. */
  tools: readonly AiToolDefinition[];
};

export type AiStepOptions = AiRunOptions & {
  /** Each piece of answer text as it arrives. */
  onTextDelta?: (text: string) => void;
};

export type AiStepResult =
  /**
   * "stop": the answer is complete. "tool-calls": the model asks for the tool calls in its
   * message; the caller runs them and calls `step` again with their results.
   */
  | ({ ok: true; finishReason: "stop" | "tool-calls"; messages: AiMessage[] } & AiCallRecord)
  /** Billed, but nothing to keep: a refusal, or an answer cut off at the output limit. */
  | ({ ok: false; reason: "refused" | "truncated" } & AiCallRecord)
  | { ok: false; reason: "unavailable" | "allowance_used_up" | "busy" | "failed" };

export type AiProvider = {
  run(task: AiTask, input: AiRunInput, options: AiRunOptions): Promise<AiRunResult>;
  /** The route a task's next call would use; undefined while no allowed route is switched on. */
  routeFor(task: AiTask, options?: Pick<AiRunOptions, "data" | "route">): ModelRoute | undefined;
  /** One streamed model call with tools (the in-app assistant's loop step). */
  step(task: AiTask, input: AiStepInput, options: AiStepOptions): Promise<AiStepResult>;
};

type Log = { warn(fields: object, message: string): void };
type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export type AiProviderConfig = {
  /** Providers switched on. Empty means no model is ever called. */
  enabledProviders: readonly AiProviderName[];
  /** Every call is reserved against the account's monthly AI budget and recorded. */
  budget: AiBudget;
  /** Model calls running at once in this process, across all hotels and AI features. */
  maxConcurrentCalls?: number;
  /** How long a call waits for a free place under that limit before it is "busy". */
  callWaitMs?: number;
  log?: Log;
  /** Tests replace the network, the AWS credentials and the job settings. */
  fetch?: typeof globalThis.fetch;
  awsCredentials?: () => Promise<AwsCredentials>;
  tasks?: Readonly<Record<AiTask, TaskSetting>>;
  timeoutMs?: number;
  /** For one streamed assistant step; the answer streams, so it may take longer than `run`. */
  stepTimeoutMs?: number;
  now?: () => number;
};

/** With the wait for a free place, below the load balancer's 60 s idle timeout (research 09 §10). */
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_CONCURRENT_CALLS = 8;
const DEFAULT_CALL_WAIT_MS = 5_000;
const DEFAULT_STEP_TIMEOUT_MS = 120_000;
/**
 * Prompt-cache breakpoints for the assistant (plan 3.9): one after the tools and the system
 * prompt, two in the history (see withBreakpointOnLast), so each step reads everything before
 * it from the cache.
 * One hour, as priced in the catalog. The markers may move between requests without breaking
 * Claude's thinking replay; the history itself is never changed.
 */
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } } as const;
/** A reservation stops counting as running this long after the call's own timeout. */
const HOLD_MARGIN_MS = 15_000;
/** Tokens the request format adds around the text, per message and once (generous). */
const FORMAT_TOKENS = 64;

/** Reads `AI_PROVIDERS_ENABLED`, a comma-separated list such as "bedrock". Unset means off. */
export function enabledAiProvidersFromEnv(env: NodeJS.ProcessEnv): AiProviderName[] {
  const names = (env.AI_PROVIDERS_ENABLED ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names)
    if (!(AI_PROVIDERS as readonly string[]).includes(name))
      throw new Error(`AI_PROVIDERS_ENABLED names an unknown AI provider: ${name}`);
  return names as AiProviderName[];
}

export function createAiProvider(config: AiProviderConfig): AiProvider {
  const enabled = new Set<string>(config.enabledProviders);
  const allowed = new Set(CUSTOMER_DATA_ROUTES.map(routeKey));
  const tasks = config.tasks ?? TASK_SETTINGS;
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stepTimeoutMs = config.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const callLimit = createCallLimit(
    config.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS,
    config.callWaitMs ?? DEFAULT_CALL_WAIT_MS,
  );
  const credentials = config.awsCredentials ?? defaultProvider();
  const baseFetch = config.fetch ?? globalThis.fetch;

  /**
   * A client per call, so its network layer can note whether Bedrock may bill the call: once a
   * request was sent and not turned down with an error status (Bedrock bills none of those).
   */
  function languageModel(route: ModelRoute, trace: { maybeBilled: boolean }): LanguageModel {
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      // As fetch itself does: an abandoned call sends nothing.
      if (init?.signal?.aborted) throw init.signal.reason;
      try {
        const response = await baseFetch(url, init);
        if (response.status < 400) trace.maybeBilled = true;
        return response;
      } catch (error) {
        // The connection may have broken after Bedrock took the request.
        trace.maybeBilled = true;
        throw error;
      }
    }) as typeof globalThis.fetch;
    return createAmazonBedrockAnthropic({
      region: route.region,
      // An explicit address and an empty API key make the SDK ignore AWS_ENDPOINT_URL* and
      // AWS_BEARER_TOKEN_BEDROCK, which would otherwise move calls out of the EU or off the
      // task role's signed requests (research 09c a).
      baseURL: `https://bedrock-runtime.${route.region}.amazonaws.com`,
      apiKey: "",
      credentialProvider: credentials,
      fetch,
    })(route.model);
  }

  type Prepared = {
    setting: TaskSetting;
    route: ModelRoute;
    fields: object;
    reservedMicroUsd: number;
  };
  type RouteOptions = Pick<AiRunOptions, "data" | "route">;

  /** The task's setting and route, when the route's provider is switched on. */
  function selected(task: AiTask, options: RouteOptions) {
    const setting = tasks[task] as TaskSetting | undefined;
    const route = options.route ?? setting?.routes.find((each) => enabled.has(each.provider));
    return setting && route && enabled.has(route.provider) ? { setting, route } : undefined;
  }
  const cleared = (route: ModelRoute, options: RouteOptions) =>
    (options.data ?? "customer") !== "customer" || allowed.has(routeKey(route));

  function routeFor(task: AiTask, options: RouteOptions = {}): ModelRoute | undefined {
    const chosen = selected(task, options);
    const usable =
      chosen && cleared(chosen.route, options) && maxCostMicroUsd(chosen.route, 0, 0) !== null;
    return usable ? chosen.route : undefined;
  }

  /** The route, its setting and the most the call can cost; or why no model may be called. */
  function prepare(
    task: AiTask,
    options: AiRunOptions,
    maxInputTokens: number,
  ): Prepared | { ok: false; reason: "unavailable" } {
    const chosen = selected(task, options);
    if (!chosen) return { ok: false, reason: "unavailable" };
    const { setting, route } = chosen;
    const fields = {
      task,
      surface: options.context.surface,
      requestId: options.context.requestId,
      route: routeKey(route),
    };
    if (!cleared(route, options)) {
      config.log?.warn(fields, "AI route is not cleared for customer data");
      return { ok: false, reason: "unavailable" };
    }
    const reservedMicroUsd = maxCostMicroUsd(route, maxInputTokens, setting.maxOutputTokens);
    if (reservedMicroUsd === null) {
      config.log?.warn(fields, "AI route has no price");
      return { ok: false, reason: "unavailable" };
    }
    return { setting, route, fields, reservedMicroUsd };
  }

  /**
   * Waits for a place under the provider-call limit, reserves the call's highest cost against the
   * account's budget, makes the call and settles it with what it really cost.
   */
  async function reserveAndCall<R>(
    task: AiTask,
    options: AiRunOptions,
    prepared: Prepared,
    holdMs: number,
    call: () => Promise<{ result: R; settlement: AiSettlement | null }>,
  ): Promise<R | { ok: false; reason: "unavailable" | "allowance_used_up" | "busy" }> {
    const { route, fields, reservedMicroUsd } = prepared;
    const release = await callLimit.acquire();
    if (!release) {
      config.log?.warn(fields, "AI provider-call limit is full");
      return { ok: false, reason: "busy" };
    }
    try {
      let reservation: AiReservation;
      try {
        reservation = await config.budget.reserve({
          task,
          context: options.context,
          route,
          priceTableVersion: PRICE_TABLE_VERSION,
          reservedMicroUsd,
          holdMs,
        });
      } catch (error) {
        config.log?.warn({ ...fields, error: errorSummary(error) }, "AI budget check failed");
        return { ok: false, reason: "unavailable" };
      }
      if (!reservation.ok) return { ok: false, reason: reservation.reason };

      const { result, settlement } = await call();
      const settleAs =
        settlement ?? ({ status: "failed", costMicroUsd: reservedMicroUsd } as const);
      try {
        await config.budget.settle(reservation.reservationId, settleAs);
      } catch (error) {
        // The reservation keeps counting at its full amount, so the budget still holds.
        config.log?.warn(
          { ...fields, reservationId: reservation.reservationId, error: errorSummary(error) },
          "AI usage could not be recorded",
        );
      }
      return result;
    } finally {
      release();
    }
  }

  return {
    routeFor,

    async run(task, input, options) {
      const prepared = prepare(task, options, inputTokenBound(input));
      if (!("setting" in prepared)) return prepared;
      return reserveAndCall(task, options, prepared, timeoutMs + HOLD_MARGIN_MS, () =>
        call(task, prepared.route, prepared.setting, input, options, prepared.fields),
      );
    },

    async step(task, input, options) {
      const prepared = prepare(task, options, stepInputTokenBound(input));
      if (!("setting" in prepared)) return prepared;
      return reserveAndCall(task, options, prepared, stepTimeoutMs + HOLD_MARGIN_MS, () =>
        streamStep(task, prepared, input, options),
      );
    },
  };

  /**
   * One model call. The settlement is null when a request may have been billed but no answer
   * says what it cost (a timeout, a broken connection): the full reservation is then kept.
   */
  async function call(
    task: AiTask,
    route: ModelRoute,
    setting: TaskSetting,
    input: AiRunInput,
    options: AiRunOptions,
    fields: object,
  ): Promise<{ result: AiRunResult; settlement: AiSettlement | null }> {
    const started = now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const trace = { maybeBilled: false };
    try {
      const result = await generateText({
        model: languageModel(route, trace),
        instructions: input.instructions,
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        maxOutputTokens: setting.maxOutputTokens,
        maxRetries: 1,
        abortSignal: options.abortSignal
          ? AbortSignal.any([options.abortSignal, timeout])
          : timeout,
        providerOptions: { anthropic: { effort: setting.effort } },
        // Guest data must never reach traces.
        telemetry: { recordInputs: false, recordOutputs: false, functionId: `ai.${task}` },
      });
      const usage = tokenUsage(result.totalUsage);
      const record: AiCallRecord = {
        route: { ...route },
        usage,
        costMicroUsd: costMicroUsd(route, usage) ?? 0,
        priceTableVersion: PRICE_TABLE_VERSION,
        latencyMs: now() - started,
      };
      const settlement: AiSettlement = {
        status: "completed",
        costMicroUsd: record.costMicroUsd,
        usage,
      };
      // A refusal or a cut-off answer must never pass as a usable one.
      if (result.finishReason === "content-filter")
        return { result: { ok: false, reason: "refused", ...record }, settlement };
      if (result.finishReason === "length")
        return { result: { ok: false, reason: "truncated", ...record }, settlement };
      if (result.finishReason !== "stop" || !result.text.trim()) {
        config.log?.warn(
          { ...fields, finishReason: result.finishReason },
          "AI answer was not usable",
        );
        return { result: { ok: false, reason: "failed" }, settlement };
      }
      return { result: { ok: true, text: result.text, ...record }, settlement };
    } catch (error) {
      config.log?.warn({ ...fields, error: errorSummary(error) }, "AI provider call failed");
      return {
        result: { ok: false, reason: "failed" },
        settlement: trace.maybeBilled ? null : { status: "failed", costMicroUsd: 0 },
      };
    }
  }

  /**
   * One streamed assistant step. The tools have no `execute`: the SDK hands their calls back
   * and stops, and the assistant's loop runs them, so no framework ever runs an action itself.
   */
  async function streamStep(
    task: AiTask,
    prepared: Prepared,
    input: AiStepInput,
    options: AiStepOptions,
  ): Promise<{ result: AiStepResult; settlement: AiSettlement | null }> {
    const { route, setting, fields } = prepared;
    const started = now();
    const timeout = AbortSignal.timeout(stepTimeoutMs);
    const trace = { maybeBilled: false };
    let streamError: unknown;
    // The input as Claude counted it when the answer started streaming.
    let counted: TokenUsage | undefined;
    try {
      const tools: Record<string, Tool> = {};
      for (const definition of input.tools)
        tools[definition.name] = tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema as JSONSchema7),
        });
      const result = streamText({
        model: languageModel(route, trace),
        instructions: {
          role: "system",
          content: input.instructions,
          providerOptions: CACHE_BREAKPOINT,
        },
        messages: withBreakpointOnLast(input.messages),
        tools,
        // Otherwise the SDK sorts them by name; the order is part of the cached prefix.
        toolOrder: input.tools.map((definition) => definition.name),
        // Claude 5.5 refuses forced tool use.
        toolChoice: "auto",
        maxOutputTokens: setting.maxOutputTokens,
        maxRetries: 1,
        abortSignal: options.abortSignal
          ? AbortSignal.any([options.abortSignal, timeout])
          : timeout,
        providerOptions: { anthropic: { effort: setting.effort } },
        // Guest data must never reach traces.
        telemetry: { recordInputs: false, recordOutputs: false, functionId: `ai.${task}` },
        // The SDK's default prints the error, and a provider error can quote the whole request.
        onError: ({ error }) => {
          streamError ??= error;
        },
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") options.onTextDelta?.(part.text);
        else if (part.type === "error") streamError ??= part.error;
        else if (part.type === "abort") streamError ??= new Error("The step was stopped");
        else if (part.type === "custom" && part.kind === "anthropic.message_start")
          counted = startUsage(part.providerMetadata);
      }
      if (streamError !== undefined) throw streamError;
      const [finishReason, totalUsage, responseMessages] = await Promise.all([
        result.finishReason,
        result.totalUsage,
        result.responseMessages,
      ]);
      const usage = tokenUsage(totalUsage);
      const record: AiCallRecord = {
        route: { ...route },
        usage,
        costMicroUsd: costMicroUsd(route, usage) ?? 0,
        priceTableVersion: PRICE_TABLE_VERSION,
        latencyMs: now() - started,
      };
      const settlement: AiSettlement = {
        status: "completed",
        costMicroUsd: record.costMicroUsd,
        usage,
      };
      if (finishReason === "content-filter")
        return { result: { ok: false, reason: "refused", ...record }, settlement };
      if (finishReason === "length")
        return { result: { ok: false, reason: "truncated", ...record }, settlement };
      const messages = keepableMessages(responseMessages);
      if ((finishReason !== "stop" && finishReason !== "tool-calls") || !messages.length) {
        config.log?.warn({ ...fields, finishReason }, "AI step was not usable");
        return { result: { ok: false, reason: "failed" }, settlement };
      }
      return { result: { ok: true, finishReason, messages, ...record }, settlement };
    } catch (error) {
      config.log?.warn({ ...fields, error: errorSummary(error) }, "AI provider step failed");
      // Stopped or broken after Claude counted the input: that, plus at most the output limit,
      // instead of the whole reservation (whose input bound counts every byte as a token).
      const atMost = counted
        ? costMicroUsd(route, { ...counted, outputTokens: setting.maxOutputTokens })
        : null;
      const settlement: AiSettlement | null = !trace.maybeBilled
        ? { status: "failed", costMicroUsd: 0 }
        : atMost === null
          ? null
          : { status: "failed", costMicroUsd: Math.min(atMost, prepared.reservedMicroUsd) };
      return { result: { ok: false, reason: "failed" }, settlement };
    }
  }
}

/** As `inputTokenBound`, for a whole conversation with its tool definitions. */
function stepInputTokenBound(input: AiStepInput): number {
  const bytes =
    Buffer.byteLength(input.instructions) +
    Buffer.byteLength(JSON.stringify(input.messages)) +
    Buffer.byteLength(JSON.stringify(input.tools));
  return bytes + FORMAT_TOKENS * (input.messages.length + input.tools.length + 1);
}

/** The input tokens Claude reports when a streamed answer starts (its message_start event). */
function startUsage(metadata: unknown): TokenUsage | undefined {
  const usage = (metadata as { anthropic?: { usage?: Record<string, unknown> } } | undefined)
    ?.anthropic?.usage;
  const count = (key: string) => (typeof usage?.[key] === "number" ? (usage[key] as number) : 0);
  if (typeof usage?.["input_tokens"] !== "number") return undefined;
  return {
    inputTokens: count("input_tokens"),
    cacheReadTokens: count("cache_read_input_tokens"),
    cacheWriteTokens: count("cache_creation_input_tokens"),
    outputTokens: 0,
  };
}

/**
 * Cache breakpoints on the messages, the stored messages unchanged: on the last one, and on the
 * last one of the previous request (the one before the latest answer), where that request's
 * cache entry ends. Claude looks back only about 20 blocks for an entry, and a step with many
 * tool calls adds more than that.
 */
function withBreakpointOnLast(messages: readonly AiMessage[]): ModelMessage[] {
  const lastAnswer = messages.map((message) => message.role).lastIndexOf("assistant");
  return messages.map((message, index) => {
    if (index !== messages.length - 1 && index !== lastAnswer - 1) return message;
    const options = (message.providerOptions ?? {}) as Record<string, Record<string, unknown>>;
    return {
      ...message,
      providerOptions: {
        ...options,
        anthropic: { ...options["anthropic"], ...CACHE_BREAKPOINT.anthropic },
      },
    };
  }) as ModelMessage[];
}

/**
 * The step's messages as plain JSON, as the assistant stores and replays them. Blank text parts
 * are dropped (Claude refuses them when they are sent back), and so is an answer left with
 * neither text nor a tool call.
 */
function keepableMessages(messages: readonly unknown[]): AiMessage[] {
  const plain = JSON.parse(JSON.stringify(messages)) as AiMessage[];
  return plain.flatMap((message) => {
    if (message.role !== "assistant") return [message];
    if (typeof message.content === "string") return message.content.trim() ? [message] : [];
    const parts = (Array.isArray(message.content) ? message.content : []).filter(
      (part: { type?: unknown; text?: unknown }) =>
        part.type !== "text" || (typeof part.text === "string" && part.text.trim() !== ""),
    ) as { type?: unknown }[];
    const says = parts.some((part) => part.type === "text" || part.type === "tool-call");
    return says ? [{ ...message, content: parts }] : [];
  });
}

/**
 * At most one token per UTF-8 byte (a token always covers at least one byte), plus the request
 * format. Far above the real count for most text, so the reservation is never too small.
 */
function inputTokenBound(input: AiRunInput): number {
  let bytes = Buffer.byteLength(input.instructions);
  for (const message of input.messages) bytes += Buffer.byteLength(message.content);
  return bytes + FORMAT_TOKENS * (input.messages.length + 1);
}

/** The AI SDK counts cached tokens inside `inputTokens`; we keep the three kinds apart. */
function tokenUsage(usage: LanguageModelUsage): TokenUsage {
  const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const inputTokens =
    usage.inputTokenDetails.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens);
  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens: usage.outputTokens ?? 0 };
}

/**
 * Error name and HTTP status only: provider messages can quote the prompt. After the retry is
 * used up the SDK throws a RetryError, whose last attempt holds the status (e.g. 429).
 */
function errorSummary(error: unknown): { name: string; statusCode?: number } {
  if (!(error instanceof Error)) return { name: typeof error };
  const last = (error as { lastError?: unknown }).lastError ?? error;
  const statusCode = (last as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? { name: error.name, statusCode } : { name: error.name };
}
