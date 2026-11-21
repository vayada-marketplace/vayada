/**
 * The one way vayada calls an AI model (VAY-2504, plan 3.11, design note §8.3). Every AI feature
 * (Inbox buttons, the in-app assistant, Concierge, the model test) goes through `run`, so the
 * model per job, the EU-only rule, prices, the budget and the limits live in one place.
 * Only this folder imports the AI SDK (see importBoundary.test.ts); Mastra joins with the
 * in-app assistant (VAY-2518).
 */
import { createAmazonBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";

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
  /** No answer: cost 0 when the provider turned the request down, else the reserved amount. */
  | { status: "failed"; costMicroUsd: number };

export type AiBudget = {
  reserve(request: AiReservationRequest): Promise<AiReservation>;
  settle(reservationId: string, settlement: AiSettlement): Promise<void>;
};

export type AiProvider = {
  run(task: AiTask, input: AiRunInput, options: AiRunOptions): Promise<AiRunResult>;
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
  now?: () => number;
};

/** With the wait for a free place, below the load balancer's 60 s idle timeout (research 09 §10). */
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_CONCURRENT_CALLS = 8;
const DEFAULT_CALL_WAIT_MS = 5_000;
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
  const callLimit = createCallLimit(
    config.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS,
    config.callWaitMs ?? DEFAULT_CALL_WAIT_MS,
  );
  const credentials = config.awsCredentials ?? defaultProvider();
  const bedrockByRegion = new Map<string, ReturnType<typeof createAmazonBedrockAnthropic>>();

  function languageModel(route: ModelRoute): LanguageModel {
    let bedrock = bedrockByRegion.get(route.region);
    if (!bedrock) {
      bedrock = createAmazonBedrockAnthropic({
        region: route.region,
        // An explicit address and an empty API key make the SDK ignore AWS_ENDPOINT_URL* and
        // AWS_BEARER_TOKEN_BEDROCK, which would otherwise move calls out of the EU or off the
        // task role's signed requests (research 09c a).
        baseURL: `https://bedrock-runtime.${route.region}.amazonaws.com`,
        apiKey: "",
        credentialProvider: credentials,
        ...(config.fetch ? { fetch: config.fetch } : {}),
      });
      bedrockByRegion.set(route.region, bedrock);
    }
    return bedrock(route.model);
  }

  return {
    async run(task, input, options) {
      const setting = tasks[task] as TaskSetting | undefined;
      const route = options.route ?? setting?.routes.find((each) => enabled.has(each.provider));
      const fields = {
        task,
        surface: options.context.surface,
        requestId: options.context.requestId,
        route: route ? routeKey(route) : null,
      };
      if (!setting || !route || !enabled.has(route.provider))
        return { ok: false, reason: "unavailable" };
      if ((options.data ?? "customer") === "customer" && !allowed.has(routeKey(route))) {
        config.log?.warn(fields, "AI route is not cleared for customer data");
        return { ok: false, reason: "unavailable" };
      }
      const reservedMicroUsd = maxCostMicroUsd(
        route,
        inputTokenBound(input),
        setting.maxOutputTokens,
      );
      if (reservedMicroUsd === null) {
        config.log?.warn(fields, "AI route has no price");
        return { ok: false, reason: "unavailable" };
      }

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
            holdMs: timeoutMs + HOLD_MARGIN_MS,
          });
        } catch (error) {
          config.log?.warn({ ...fields, error: errorSummary(error) }, "AI budget check failed");
          return { ok: false, reason: "unavailable" };
        }
        if (!reservation.ok) return { ok: false, reason: reservation.reason };

        const { result, settlement } = await call(task, route, setting, input, options, fields);
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
    },
  };

  /**
   * One model call. The settlement is null when it is unknown whether the provider ran (and
   * billed) the request, e.g. a timeout: the reservation is then kept at its full amount.
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
    try {
      const result = await generateText({
        model: languageModel(route),
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
      const summary = errorSummary(error);
      config.log?.warn({ ...fields, error: summary }, "AI provider call failed");
      // An error status means the provider turned the request down and bills nothing.
      const declined = summary.statusCode !== undefined && summary.statusCode >= 400;
      return {
        result: { ok: false, reason: "failed" },
        settlement: declined ? { status: "failed", costMicroUsd: 0 } : null,
      };
    }
  }
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
