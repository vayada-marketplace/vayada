/**
 * Tool-loop budgets from the VAY-736 runtime decision. Defaults are the MVP
 * values; hard limits are ceilings that configuration must never exceed.
 */
export type AskLoopBudgets = {
  maxModelTurns: number;
  maxEvidenceToolCalls: number;
  maxCallsPerTool: number;
  maxProviderRetries: number;
  maxToolRetries: number;
  runTimeoutMs: number;
  maxConcurrentToolCalls: number;
  maxConversationTurns: number;
};

export const DEFAULT_ASK_LOOP_BUDGETS: AskLoopBudgets = {
  maxModelTurns: 3,
  maxEvidenceToolCalls: 6,
  maxCallsPerTool: 2,
  maxProviderRetries: 1,
  maxToolRetries: 0,
  runTimeoutMs: 20_000,
  maxConcurrentToolCalls: 3,
  maxConversationTurns: 5,
};

export const ASK_LOOP_HARD_LIMITS: AskLoopBudgets = {
  maxModelTurns: 4,
  maxEvidenceToolCalls: 8,
  maxCallsPerTool: 2,
  maxProviderRetries: 2,
  maxToolRetries: 1,
  runTimeoutMs: 30_000,
  maxConcurrentToolCalls: 4,
  maxConversationTurns: 8,
};

/**
 * Clamp configured budgets into [1, hard limit] (retries into [0, hard
 * limit]); non-finite values fall back to the MVP defaults.
 */
export function clampAskLoopBudgets(budgets: Partial<AskLoopBudgets> = {}): AskLoopBudgets {
  const clamped = {} as AskLoopBudgets;
  for (const key of Object.keys(DEFAULT_ASK_LOOP_BUDGETS) as (keyof AskLoopBudgets)[]) {
    const minimum = key === "maxProviderRetries" || key === "maxToolRetries" ? 0 : 1;
    const requested = budgets[key];
    const value =
      typeof requested === "number" && Number.isFinite(requested)
        ? Math.trunc(requested)
        : DEFAULT_ASK_LOOP_BUDGETS[key];
    clamped[key] = Math.min(Math.max(value, minimum), ASK_LOOP_HARD_LIMITS[key]);
  }
  return clamped;
}
