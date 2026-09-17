import { getTimezone } from "countries-and-timezones";

import {
  assertFinanceProfitLossResponse,
  FINANCE_PROFIT_LOSS_SYSTEM_CATEGORY_ROWS,
  financeProfitLossPeriods,
  financeReportingMoneyMetric,
  normalizeFinanceReportingDecimal,
  PMS_FINANCIALS_CONTRACT_VERSION,
  type FinanceProfitLossExpenseCategoryRow,
  type FinanceProfitLossQuery,
  type FinanceProfitLossResponse,
  type FinanceReportingIncompleteEvidence,
  type FinanceReportingMoney,
} from "@vayada/domain-finance";

type Period = "current" | "comparison";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RevenueFact = { period: Period; recognizedOn: string; amount: string };
type ExpenseFact = {
  period: Period;
  incurredOn: string;
  categoryRow: FinanceProfitLossExpenseCategoryRow;
  amount: string;
};

export type FinanceProfitLossResponseInput = {
  propertyId: string;
  currency: string;
  timeZone: string;
  generatedAt: string;
  asOf: string;
  query: FinanceProfitLossQuery;
  sourceFreshness?: Record<string, string>;
  incompleteEvidence?: FinanceReportingIncompleteEvidence[];
  categoryRows: FinanceProfitLossExpenseCategoryRow[];
  roomRevenue: RevenueFact[];
  upsellRevenue: RevenueFact[];
  expenses: ExpenseFact[];
};

export function composeFinanceProfitLossResponse(
  input: FinanceProfitLossResponseInput,
): FinanceProfitLossResponse {
  if (
    !UUID.test(input.propertyId) ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    !canonicalTimeZone(input.timeZone) ||
    !utc(input.generatedAt)
  )
    throw new TypeError("Finance profit and loss response scope is invalid");
  const categoryRows = [
    ...new Set([...Object.values(FINANCE_PROFIT_LOSS_SYSTEM_CATEGORY_ROWS), ...input.categoryRows]),
  ].sort() as FinanceProfitLossExpenseCategoryRow[];
  const periods = financeProfitLossPeriods(input.query, input.asOf);
  assertFacts(input, categoryRows, periods);
  const monthCount = Number(periods.current.to.slice(5, 7));
  const months = Array.from({ length: monthCount }, (_, index) => {
    const month = `${input.query.year}-${String(index + 1).padStart(2, "0")}`;
    const room = sum(input.roomRevenue, "current", month);
    const upsell = sum(input.upsellRevenue, "current", month);
    const categories = Object.fromEntries(
      categoryRows.map((row) => [
        row,
        money(
          input.expenses
            .filter(
              (fact) =>
                fact.period === "current" &&
                fact.incurredOn.startsWith(month) &&
                fact.categoryRow === row,
            )
            .reduce((total, fact) => total + units(fact.amount), 0n),
          input.currency,
        ),
      ]),
    ) as Record<FinanceProfitLossExpenseCategoryRow, FinanceReportingMoney>;
    const expenses = Object.values(categories).reduce(
      (total, value) => total + units(value.amount),
      0n,
    );
    return {
      month,
      roomRevenue: money(room, input.currency),
      upsellRevenue: money(upsell, input.currency),
      revenue: money(room + upsell, input.currency),
      expenses: money(expenses, input.currency),
      netProfit: money(room + upsell - expenses, input.currency),
      expenseCategories: categories,
    };
  });
  const currentRevenue = revenue(input, "current");
  const priorRevenue = revenue(input, "comparison");
  const currentExpenses = expenseTotal(input.expenses, "current");
  const priorExpenses = expenseTotal(input.expenses, "comparison");
  const response: FinanceProfitLossResponse = {
    contractVersion: PMS_FINANCIALS_CONTRACT_VERSION,
    propertyId: input.propertyId.toLowerCase(),
    currency: input.currency,
    timeZone: input.timeZone,
    generatedAt: new Date(input.generatedAt).toISOString(),
    sourceFreshness: input.sourceFreshness ?? {},
    incompleteEvidence: input.incompleteEvidence ?? [],
    summary: {
      revenueYtd: financeReportingMoneyMetric(
        decimal(currentRevenue),
        decimal(priorRevenue),
        input.currency,
      ),
      expensesYtd: financeReportingMoneyMetric(
        decimal(currentExpenses),
        decimal(priorExpenses),
        input.currency,
      ),
      netProfitYtd: financeReportingMoneyMetric(
        decimal(currentRevenue - currentExpenses),
        decimal(priorRevenue - priorExpenses),
        input.currency,
      ),
    },
    months,
  };
  assertFinanceProfitLossResponse(response, input.query, input.asOf, categoryRows);
  return response;
}

function assertFacts(
  input: FinanceProfitLossResponseInput,
  categoryRows: FinanceProfitLossExpenseCategoryRow[],
  periods: ReturnType<typeof financeProfitLossPeriods>,
): void {
  const rows = new Set(categoryRows);
  for (const fact of [...input.roomRevenue, ...input.upsellRevenue])
    assertFactDate(fact.recognizedOn, fact.period, periods);
  for (const fact of input.expenses) {
    assertFactDate(fact.incurredOn, fact.period, periods);
    if (!rows.has(fact.categoryRow))
      throw new TypeError("Finance profit and loss expense category is undeclared");
  }
}
function assertFactDate(
  date: string,
  period: Period,
  periods: ReturnType<typeof financeProfitLossPeriods>,
): void {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date ||
    date < periods[period].from ||
    date > periods[period].to
  )
    throw new TypeError("Finance profit and loss fact date is outside its period");
}

function revenue(input: FinanceProfitLossResponseInput, period: Period): bigint {
  return sum(input.roomRevenue, period) + sum(input.upsellRevenue, period);
}
function sum(rows: RevenueFact[], period: Period, month?: string): bigint {
  return rows
    .filter((fact) => fact.period === period && (!month || fact.recognizedOn.startsWith(month)))
    .reduce((total, fact) => total + units(fact.amount), 0n);
}
function expenseTotal(rows: ExpenseFact[], period: Period): bigint {
  return rows
    .filter((fact) => fact.period === period)
    .reduce((total, fact) => total + units(fact.amount), 0n);
}
function units(value: string): bigint {
  const normalized = normalizeFinanceReportingDecimal(value);
  const negative = normalized.startsWith("-");
  const [whole, fraction] = normalized.replace("-", "").split(".");
  const result = BigInt(whole!) * 10_000n + BigInt(fraction!);
  return negative ? -result : result;
}
function decimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 10_000n}.${String(absolute % 10_000n).padStart(4, "0")}`;
}
function money(amount: bigint, currency: string): FinanceReportingMoney {
  return { amount: decimal(amount), currency };
}
function canonicalTimeZone(value: string): boolean {
  try {
    const zone = getTimezone(value);
    return zone?.name === value && zone.aliasOf === null;
  } catch {
    return false;
  }
}
function utc(value: string): boolean {
  if (!/^((?!0000)\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
