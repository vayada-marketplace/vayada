/**
 * Which model does which AI job, which models may see customer data, and what each costs
 * (VAY-2504, plan 3.11, design note §8.3). Changing a job's model is a code change that names
 * the model test run (VAY-2520) that picked it.
 */

export const AI_TASKS = [
  "inbox_translate",
  "inbox_summarise",
  "inbox_draft",
  "assistant_chat",
  "concierge_understand",
  "concierge_reply",
] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const AI_PROVIDERS = ["bedrock"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export type ModelRoute = { provider: AiProviderName; region: string; model: string };

/** Claude on Bedrock through the `eu.` inference profile, called from Ireland (plan 3.11). */
const bedrockEu = (model: string): ModelRoute => ({
  provider: "bedrock",
  region: "eu-west-1",
  model: `eu.anthropic.${model}`,
});
const SONNET = bedrockEu("claude-sonnet-5-5");
const HAIKU = bedrockEu("claude-haiku-5-5");
const OPUS = bedrockEu("claude-opus-5-5");

/**
 * Routes validated for customer data: provider, source region and model (the account is the
 * next-api task role's). Add one only together with its DPA row and privacy page text
 * (VAY-2502). Anything else may run only on made-up test data.
 */
export const CUSTOMER_DATA_ROUTES: readonly ModelRoute[] = [SONNET, HAIKU, OPUS];

export type TaskSetting = {
  /** The first route whose provider is switched on is used; the rest are the fallback order. */
  routes: readonly ModelRoute[];
  maxOutputTokens: number;
  /** Claude's thinking and answer effort; thinking can not be switched off on the 5.5 models. */
  effort: "low" | "medium" | "high";
  /** The model test run that chose these routes. */
  pickedBy: string;
};

const BEFORE_MODEL_TEST = "placeholder until the VAY-2520 model test";

export const TASK_SETTINGS: Record<AiTask, TaskSetting> = {
  inbox_translate: {
    routes: [HAIKU],
    maxOutputTokens: 4_096,
    effort: "low",
    pickedBy: BEFORE_MODEL_TEST,
  },
  inbox_summarise: {
    routes: [HAIKU],
    maxOutputTokens: 2_048,
    effort: "low",
    pickedBy: BEFORE_MODEL_TEST,
  },
  inbox_draft: {
    routes: [SONNET],
    maxOutputTokens: 4_096,
    effort: "low",
    pickedBy: BEFORE_MODEL_TEST,
  },
  assistant_chat: {
    routes: [SONNET],
    maxOutputTokens: 16_000,
    effort: "medium",
    pickedBy: BEFORE_MODEL_TEST,
  },
  concierge_understand: {
    routes: [HAIKU],
    maxOutputTokens: 2_048,
    effort: "low",
    pickedBy: BEFORE_MODEL_TEST,
  },
  concierge_reply: {
    routes: [SONNET],
    maxOutputTokens: 4_096,
    effort: "low",
    pickedBy: BEFORE_MODEL_TEST,
  },
};

/** Nano-dollars per token: $2.20 per million tokens is 2,200. Integers keep costs exact. */
type Rates = { input: number; cacheRead: number; cacheWrite1h: number; output: number };
type ModelPrice = Rates & {
  /** Above this many input tokens in one request, every token of it is billed at `long`. */
  longContext?: { aboveInputTokens: number; rates: Rates };
};

export const PRICE_TABLE_VERSION = "2026-11-20";

/**
 * AWS Price List API, service AmazonBedrockFoundationModels, region eu-west-1, the non-global
 * ("Standard") usage types, read 2026-11-20. The `eu.` profile costs 10% more than `global.`.
 * Cache writes are billed at the 1-hour rate, the higher one, because our breakpoints are 1h.
 */
export const PRICES: Record<string, ModelPrice> = {
  [routeKey(SONNET)]: { input: 2_200, cacheRead: 110, cacheWrite1h: 4_400, output: 11_000 },
  [routeKey(HAIKU)]: {
    input: 110,
    cacheRead: 11,
    cacheWrite1h: 220,
    output: 550,
    longContext: {
      aboveInputTokens: 100_000,
      rates: { input: 550, cacheRead: 55, cacheWrite1h: 1_100, output: 2_750 },
    },
  },
  [routeKey(OPUS)]: { input: 4_400, cacheRead: 220, cacheWrite1h: 8_800, output: 22_000 },
};

export function routeKey(route: ModelRoute): string {
  return `${route.provider}:${route.region}:${route.model}`;
}

export type TokenUsage = {
  /** Input tokens that were neither read from nor written to the prompt cache. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

/** Cost in whole micro-dollars, rounded up; null when the route has no price. */
export function costMicroUsd(route: ModelRoute, usage: TokenUsage): number | null {
  const price = PRICES[routeKey(route)];
  if (!price) return null;
  const allInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const rates =
    price.longContext && allInput > price.longContext.aboveInputTokens
      ? price.longContext.rates
      : price;
  const nanoUsd =
    usage.inputTokens * rates.input +
    usage.cacheReadTokens * rates.cacheRead +
    usage.cacheWriteTokens * rates.cacheWrite1h +
    usage.outputTokens * rates.output;
  return Math.ceil(nanoUsd / 1_000);
}
