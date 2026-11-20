/**
 * The one way vayada calls an AI model (VAY-2504, plan 3.11, design note §8.3). Every AI feature
 * (Inbox buttons, the in-app assistant, Concierge, the model test) goes through `run`, so the
 * model per job, the EU-only rule, prices, and later the budget and limits live in one place.
 * Only this folder imports the AI SDK (see importBoundary.test.ts); Mastra joins with the
 * in-app assistant (VAY-2518).
 */
import { createAmazonBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";

import {
  AI_PROVIDERS,
  CUSTOMER_DATA_ROUTES,
  PRICE_TABLE_VERSION,
  TASK_SETTINGS,
  costMicroUsd,
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

export type AiRunResult =
  | {
      ok: true;
      text: string;
      finishReason: string;
      route: ModelRoute;
      usage: TokenUsage;
      costMicroUsd: number;
      priceTableVersion: string;
      latencyMs: number;
    }
  | { ok: false; reason: "unavailable" | "failed" };

export type AiProvider = {
  run(task: AiTask, input: AiRunInput, options: AiRunOptions): Promise<AiRunResult>;
};

type Log = { warn(fields: object, message: string): void };
type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export type AiProviderConfig = {
  /** Providers switched on. Empty means no model is ever called. */
  enabledProviders: readonly AiProviderName[];
  log?: Log;
  /** Tests replace the network, the AWS credentials and the job settings. */
  fetch?: typeof globalThis.fetch;
  awsCredentials?: () => Promise<AwsCredentials>;
  tasks?: Record<AiTask, TaskSetting>;
  timeoutMs?: number;
  now?: () => number;
};

/** Below the load balancer's 60 s idle timeout (research 09 §10). */
const DEFAULT_TIMEOUT_MS = 45_000;

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
      const setting = tasks[task];
      const route = options.route ?? setting.routes.find((each) => enabled.has(each.provider));
      const fields = {
        task,
        surface: options.context.surface,
        requestId: options.context.requestId,
        route: route ? routeKey(route) : null,
      };
      if (!route || !enabled.has(route.provider)) return { ok: false, reason: "unavailable" };
      if ((options.data ?? "customer") === "customer" && !allowed.has(routeKey(route))) {
        config.log?.warn(fields, "AI route is not cleared for customer data");
        return { ok: false, reason: "unavailable" };
      }
      if (costMicroUsd(route, emptyUsage()) === null) {
        config.log?.warn(fields, "AI route has no price");
        return { ok: false, reason: "unavailable" };
      }

      const started = now();
      const timeout = AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
        return {
          ok: true,
          text: result.text,
          finishReason: result.finishReason,
          route,
          usage,
          costMicroUsd: costMicroUsd(route, usage) ?? 0,
          priceTableVersion: PRICE_TABLE_VERSION,
          latencyMs: now() - started,
        };
      } catch (error) {
        config.log?.warn({ ...fields, error: errorSummary(error) }, "AI provider call failed");
        return { ok: false, reason: "failed" };
      }
    },
  };
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

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
}

/** Error name and HTTP status only: provider messages can quote the prompt. */
function errorSummary(error: unknown): { name: string; statusCode?: number } {
  if (!(error instanceof Error)) return { name: typeof error };
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? { name: error.name, statusCode } : { name: error.name };
}
