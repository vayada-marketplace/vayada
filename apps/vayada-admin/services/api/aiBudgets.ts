import { apiClient } from "./client";

/**
 * VAY-2504: vayada staff see each hotel account's AI spend this month and set its monthly AI
 * budget (GET/PUT /api/platform/admin/ai-budgets). Amounts are whole micro-dollars (1 USD =
 * 1,000,000). A budget of 0 means no AI for that hotel.
 */
export type AiAccountBudget = {
  organizationId: string;
  name: string;
  /** identity.organizations status: active, suspended or archived. */
  status: string;
  monthlyLimitMicroUsd: number;
  /** False while the default budget applies. */
  custom: boolean;
  usedMicroUsd: number;
  calls: number;
  /** When staff last set this account's own budget; null on the default. */
  updatedAt: string | null;
};

export type AiBudgetOverview = {
  /** First day of the UTC month, YYYY-MM-DD. */
  month: string;
  defaultMonthlyLimitMicroUsd: number;
  /** Everything vayada spent on AI this month (every account, vayada's own model tests too). */
  totalUsedMicroUsd: number;
  /** Every hotel account, the biggest spender first. */
  accounts: AiAccountBudget[];
};

const BASE = "/api/platform/admin/ai-budgets";

export const aiBudgetsService = {
  overview: () => apiClient.get<AiBudgetOverview>(BASE),
  /** monthlyLimitUsd as typed dollars ("25", "12.50"), or null to put the account on the default.
   * The server records the change and the reason in the audit log. */
  setBudget: (organizationId: string, input: { monthlyLimitUsd: string | null; reason: string }) =>
    apiClient.put<AiAccountBudget>(`${BASE}/${encodeURIComponent(organizationId)}`, input),
};

/** The server's limit for a monthly budget. */
export const MAX_MONTHLY_BUDGET_USD = 100_000;
const MICRO_PER_CENT = 10_000;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "$1,234.50"; a spend above zero but under a cent reads "under $0.01", never "$0.00". */
export function formatUsd(microUsd: number): string {
  if (microUsd > 0 && microUsd < MICRO_PER_CENT / 2) return "under $0.01";
  return usd.format(Math.round(microUsd / MICRO_PER_CENT) / 100);
}

/** The dollars typed for a budget, as the server takes them ("25", "12.50"), or null when they
 * are not whole dollars and cents from 0 to $100,000. A leading "$" and thousands commas are fine. */
export function budgetInput(value: string): string | null {
  const text = value
    .trim()
    .replace(/^\$\s*/, "")
    .replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) return null;
  return Number(text) <= MAX_MONTHLY_BUDGET_USD ? text : null;
}

/** An account's own budget as the dialog shows it to start with ("25.00"); empty on the default. */
export function budgetField(account: AiAccountBudget): string {
  return account.custom ? (account.monthlyLimitMicroUsd / 1_000_000).toFixed(2) : "";
}

/** How much of its budget an account has used, for the bar (0 to 1), and whether AI is stopped:
 * a used-up budget pauses AI until the 1st, a $0 budget keeps it off (next month too). */
export function budgetUse(account: AiAccountBudget): {
  share: number;
  usedUp: boolean;
  off: boolean;
} {
  const { usedMicroUsd: used, monthlyLimitMicroUsd: limit } = account;
  return {
    share: limit > 0 ? Math.min(1, used / limit) : used > 0 ? 1 : 0,
    usedUp: limit > 0 && used >= limit,
    off: limit === 0,
  };
}

/** The line under an account's spend when its AI is stopped this month, or null. */
export function stoppedNote(account: AiAccountBudget, month: string): string | null {
  const { usedUp, off } = budgetUse(account);
  if (off && account.usedMicroUsd > 0) return "AI off: the budget is $0";
  return usedUp ? `Used up · AI paused until ${nextMonthLabel(month)}` : null;
}

/** No spend and nothing to spend: the account has no AI at all this month. */
export const noAiUse = (account: AiAccountBudget) =>
  account.usedMicroUsd === 0 && account.monthlyLimitMicroUsd === 0;

const monthStart = (month: string) => new Date(`${month}T00:00:00Z`);

/** "November 2026" for the month that starts on 2026-11-01 (UTC). */
export function monthLabel(month: string): string {
  return monthStart(month).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const firstDay = (start: Date) =>
  start.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** "November 1": the day the given month's spend counts from. */
export function monthStartLabel(month: string): string {
  return firstDay(monthStart(month));
}

/** "December 1": when budgets start again after the given month. */
export function nextMonthLabel(month: string): string {
  const start = monthStart(month);
  return firstDay(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)));
}

/** "Nov 3", with the year when it isn't the year of the month shown. */
export function changedOn(updatedAt: string, month: string): string {
  const at = new Date(updatedAt);
  const sameYear = at.getUTCFullYear() === monthStart(month).getUTCFullYear();
  return at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** Status, code and message of a failed request (the API answers `{ code, detail }`). */
export function problemOf(error: unknown): { status?: number; code?: string; message: string } {
  const value = error as { status?: number; data?: unknown; message?: string };
  const data =
    value?.data && typeof value.data === "object" ? (value.data as Record<string, unknown>) : {};
  return {
    status: typeof value?.status === "number" ? value.status : undefined,
    code: typeof data.code === "string" ? data.code : undefined,
    message: value?.message || "Something went wrong. Try again.",
  };
}
