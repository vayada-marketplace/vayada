import {
  PMS_FINANCIALS_CONTRACT_VERSION,
  financeDashboardPeriods,
  financeReportingMoneyMetric,
  normalizeFinanceReportingDecimal,
  type FinanceDashboardResponse,
  type FinanceReportingComparison,
  type FinanceReportingIncompleteEvidence,
  type FinanceReportingMoney,
  type FinanceReportingRange,
} from "@vayada/domain-finance";

import type {
  FinanceDashboardExpenseFacts,
  FinanceDashboardExpenseGap,
} from "./financeDashboardExpenseFacts.js";
import type {
  FinanceRevenueAddonFacts,
  FinanceRevenueAddonGap,
} from "./financeRevenueAddonFacts.js";
import type { FinanceRevenueRoomFacts, FinanceRevenueRoomGap } from "./financeRevenueRoomFacts.js";

type Gap = FinanceRevenueRoomGap | FinanceRevenueAddonGap | FinanceDashboardExpenseGap;
export type FinanceDashboardResponseInput = {
  propertyId: string;
  currency: string;
  timeZone: string;
  generatedAt: string;
  sourceFreshness?: Record<string, string>;
  periods: {
    today: FinanceReportingComparison;
    monthToDate: FinanceReportingComparison;
    daily: FinanceReportingRange;
  };
  rooms: FinanceRevenueRoomFacts;
  addOns: FinanceRevenueAddonFacts;
  expenses: FinanceDashboardExpenseFacts;
};

export function composeFinanceDashboardResponse(
  input: FinanceDashboardResponseInput,
): FinanceDashboardResponse {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.propertyId,
    ) ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    !input.timeZone.trim() ||
    !Number.isFinite(new Date(input.generatedAt).getTime())
  )
    throw new TypeError("Finance Dashboard response scope is invalid");
  if (!validPeriods(input.periods))
    throw new TypeError("Finance Dashboard response periods are invalid");
  const today = comparisonRevenue(input, input.periods.today);
  const monthToDate = comparisonRevenue(input, input.periods.monthToDate);
  const expenses = {
    current: normalizeFinanceReportingDecimal(input.expenses.totals.current),
    comparison: normalizeFinanceReportingDecimal(input.expenses.totals.comparison),
  };
  const expectedDays = dates(input.periods.daily);
  if (
    input.expenses.daily.length !== expectedDays.length ||
    input.expenses.daily.some((row, index) => row.date !== expectedDays[index])
  )
    throw new Error("Finance Dashboard daily expense facts are incomplete");
  return {
    contractVersion: PMS_FINANCIALS_CONTRACT_VERSION,
    propertyId: input.propertyId.toLowerCase(),
    currency: input.currency,
    timeZone: input.timeZone,
    generatedAt: new Date(input.generatedAt).toISOString(),
    sourceFreshness: freshness(input),
    incompleteEvidence: [
      ...input.rooms.incompleteEvidence,
      ...input.addOns.incompleteEvidence,
      ...input.expenses.incompleteEvidence,
    ].map(incomplete),
    cards: {
      revenueToday: financeReportingMoneyMetric(today.current, today.comparison, input.currency),
      revenueMtd: financeReportingMoneyMetric(
        monthToDate.current,
        monthToDate.comparison,
        input.currency,
      ),
      expensesMtd: financeReportingMoneyMetric(
        expenses.current,
        expenses.comparison,
        input.currency,
      ),
      profitMtd: financeReportingMoneyMetric(
        subtract(monthToDate.current, expenses.current),
        subtract(monthToDate.comparison, expenses.comparison),
        input.currency,
      ),
    },
    daily: input.expenses.daily.map((row) => ({
      date: row.date,
      revenue: money(revenue(input, { from: row.date, to: row.date }), input.currency),
      expenses: money(row.amount, input.currency),
    })),
    upcoming: input.expenses.upcoming.map((row) => ({
      date: row.date,
      kind: row.kind,
      amount: money(row.amount, input.currency),
      predicted: row.predicted,
    })),
  };
}

function validPeriods(input: FinanceDashboardResponseInput["periods"]): boolean {
  try {
    const expected = financeDashboardPeriods(input.today.current.to);
    const same = (left: FinanceReportingRange, right: FinanceReportingRange) =>
      left.from === right.from && left.to === right.to;
    return (
      same(input.today.current, expected.today.current) &&
      same(input.today.comparison, expected.today.comparison) &&
      same(input.monthToDate.current, expected.monthToDate.current) &&
      same(input.monthToDate.comparison, expected.monthToDate.comparison) &&
      same(input.daily, expected.daily)
    );
  } catch {
    return false;
  }
}

function comparisonRevenue(
  input: FinanceDashboardResponseInput,
  period: FinanceReportingComparison,
) {
  return {
    current: revenue(input, period.current),
    comparison: revenue(input, period.comparison),
  };
}
function revenue(input: FinanceDashboardResponseInput, range: FinanceReportingRange): string {
  const room = input.rooms.rows
    .filter((row) => row.recognizedOn >= range.from && row.recognizedOn <= range.to)
    .reduce((total, row) => total + units(row.grossRoomAmount), 0n);
  const addOn = input.addOns.rows
    .filter((row) => row.recognizedOn >= range.from && row.recognizedOn <= range.to)
    .reduce((total, row) => total + units(row.revenueAmount), 0n);
  return decimal(room + addOn);
}
function freshness(input: FinanceDashboardResponseInput): Record<string, string> {
  const values: Record<string, string | null> = {
    ...input.sourceFreshness,
    ...input.rooms.sourceFreshness,
    ...input.addOns.sourceFreshness,
    ...input.expenses.sourceFreshness,
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}
function incomplete(value: Gap): FinanceReportingIncompleteEvidence {
  if ("amount" in value && value.amount)
    return { code: value.code, count: value.count, amount: value.amount };
  return "currency" in value
    ? { code: value.code, count: value.count, currency: value.currency }
    : { code: value.code, count: value.count };
}
function dates(range: FinanceReportingRange): string[] {
  const values = [];
  for (
    let day = Date.parse(`${range.from}T00:00:00Z`), end = Date.parse(`${range.to}T00:00:00Z`);
    day <= end;
    day += 86_400_000
  )
    values.push(new Date(day).toISOString().slice(0, 10));
  return values;
}
function money(value: string, currency: string): FinanceReportingMoney {
  return { amount: normalizeFinanceReportingDecimal(value), currency };
}
function subtract(left: string, right: string): string {
  return decimal(units(left) - units(right));
}
function units(value: string): bigint {
  const normalized = normalizeFinanceReportingDecimal(value);
  const negative = normalized.startsWith("-");
  const [whole, fraction] = normalized.replace("-", "").split(".");
  const valueUnits = BigInt(whole!) * 10_000n + BigInt(fraction!);
  return negative ? -valueUnits : valueUnits;
}
function decimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 10_000n}.${String(absolute % 10_000n).padStart(4, "0")}`;
}
