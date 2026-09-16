import { PMS_FINANCIALS_CONTRACT_VERSION } from "./financialExpenses.js";

export const FINANCE_DASHBOARD_WINDOW_DAYS = 14;

export type FinanceDashboardQuery = { asOf?: string };
export type FinanceRevenueQuery = { from: string; to: string };
export type FinanceReportingRange = { from: string; to: string };
export type FinanceReportingComparison = {
  current: FinanceReportingRange;
  comparison: FinanceReportingRange;
};
export type FinanceReportingMoney = { amount: string; currency: string };
export type FinanceReportingMoneyMetric = {
  value: FinanceReportingMoney;
  absoluteChange: FinanceReportingMoney;
  percentChange: string | null;
};
export type FinanceReportingCountMetric = {
  value: number;
  absoluteChange: number;
  percentChange: string | null;
};
export type FinanceReportingRatioMetric = {
  value: string;
  absoluteChange: string;
  percentChange: string | null;
};
export type FinanceReportingIncompleteEvidence = { code: string; count: number } & (
  { amount?: FinanceReportingMoney; currency?: never } | { amount?: never; currency: string }
);
export type FinanceReportingEnvelope = {
  contractVersion: typeof PMS_FINANCIALS_CONTRACT_VERSION;
  propertyId: string;
  currency: string;
  timeZone: string;
  generatedAt: string;
  sourceFreshness: Record<string, string>;
  incompleteEvidence: FinanceReportingIncompleteEvidence[];
};
export type FinanceDashboardResponse = FinanceReportingEnvelope & {
  cards: {
    revenueToday: FinanceReportingMoneyMetric;
    revenueMtd: FinanceReportingMoneyMetric;
    expensesMtd: FinanceReportingMoneyMetric;
    profitMtd: FinanceReportingMoneyMetric;
  };
  daily: Array<{ date: string; revenue: FinanceReportingMoney; expenses: FinanceReportingMoney }>;
  upcoming: Array<{
    date: string;
    kind: string;
    amount: FinanceReportingMoney;
    predicted: boolean;
  }>;
};
export type FinanceRevenueResponse = FinanceReportingEnvelope & {
  summary: {
    grossRoom: FinanceReportingMoneyMetric;
    otaCommission: FinanceReportingMoneyMetric;
    netRoom: FinanceReportingMoneyMetric;
    upsell: FinanceReportingMoneyMetric;
    nights: FinanceReportingCountMetric;
    adr: FinanceReportingMoneyMetric;
    attachRate: FinanceReportingRatioMetric;
  };
  channels: Array<{
    channel: string;
    gross: FinanceReportingMoney;
    commission: FinanceReportingMoney;
    net: FinanceReportingMoney;
    share: string;
  }>;
  directSources: Array<{
    source: string;
    revenue: FinanceReportingMoney;
    share: string;
  }>;
  upsells: Array<{ ownership: "property" | "partner"; revenue: FinanceReportingMoney }>;
  roomTypes: Array<{
    roomTypeId: string;
    nights: number;
    revenue: FinanceReportingMoney;
    adr: FinanceReportingMoney;
  }>;
};

export function parseFinanceDashboardQuery(value: unknown): FinanceDashboardQuery | null {
  if (!record(value)) return null;
  if (Object.keys(value).length === 0) return {};
  if (!exactKeys(value, ["asOf"])) return null;
  return localDate(value.asOf) ? { asOf: value.asOf } : null;
}

export function parseFinanceRevenueQuery(value: unknown): FinanceRevenueQuery | null {
  if (!record(value) || !exactKeys(value, ["from", "to"])) return null;
  return localDate(value.from) && localDate(value.to) && value.from <= value.to
    ? { from: value.from, to: value.to }
    : null;
}

export function financeDashboardPeriods(asOf: string): {
  today: FinanceReportingComparison;
  monthToDate: FinanceReportingComparison;
  daily: FinanceReportingRange;
} {
  assertLocalDate(asOf);
  const current = dateValue(asOf);
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  const day = current.getUTCDate();
  const todayComparison = shiftDate(current, -7);
  const priorMonth = new Date(Date.UTC(year, month - 1, 1));
  const priorMonthEnd = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const priorTo = new Date(
    Date.UTC(priorMonth.getUTCFullYear(), priorMonth.getUTCMonth(), Math.min(day, priorMonthEnd)),
  );
  return {
    today: {
      current: { from: asOf, to: asOf },
      comparison: { from: todayComparison, to: todayComparison },
    },
    monthToDate: {
      current: { from: formatDate(new Date(Date.UTC(year, month, 1))), to: asOf },
      comparison: { from: formatDate(priorMonth), to: formatDate(priorTo) },
    },
    daily: { from: shiftDate(current, 1 - FINANCE_DASHBOARD_WINDOW_DAYS), to: asOf },
  };
}

export function financeRevenuePeriod(query: FinanceRevenueQuery): FinanceReportingComparison {
  const parsed = parseFinanceRevenueQuery(query);
  if (!parsed) throw new TypeError("Finance revenue range is malformed");
  const currentFrom = dateValue(query.from);
  const currentTo = dateValue(query.to);
  const days = Math.round((currentTo.getTime() - currentFrom.getTime()) / 86_400_000) + 1;
  const comparisonTo = new Date(currentFrom.getTime() - 86_400_000);
  return {
    current: parsed,
    comparison: {
      from: shiftDate(comparisonTo, 1 - days),
      to: formatDate(comparisonTo),
    },
  };
}

export function normalizeFinanceReportingDecimal(value: string): string {
  return decimal(decimalUnits(value));
}

export function divideFinanceReportingDecimal(value: string, divisor: number): string {
  if (!Number.isSafeInteger(divisor) || divisor < 0)
    throw new TypeError("Finance reporting divisor is invalid");
  const units = decimalUnits(value);
  return decimal(divisor === 0 ? 0n : roundDivide(units, BigInt(divisor)));
}

export function financeReportingMoneyMetric(
  value: string,
  comparison: string,
  currency: string,
): FinanceReportingMoneyMetric {
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError("Finance reporting currency is invalid");
  const current = decimalUnits(value);
  const prior = decimalUnits(comparison);
  return {
    value: money(current, currency),
    absoluteChange: money(current - prior, currency),
    percentChange: change(current, prior),
  };
}

export function financeReportingCountMetric(
  value: number,
  comparison: number,
): FinanceReportingCountMetric {
  assertCount(value);
  assertCount(comparison);
  return {
    value,
    absoluteChange: value - comparison,
    percentChange: change(BigInt(value), BigInt(comparison)),
  };
}

export function financeReportingRatioMetric(
  value: { numerator: number; denominator: number },
  comparison: { numerator: number; denominator: number },
): FinanceReportingRatioMetric {
  const current = ratio(value);
  const prior = ratio(comparison);
  const differenceNumerator =
    current.numerator * prior.denominator - prior.numerator * current.denominator;
  return {
    value: fraction(current.numerator, current.denominator),
    absoluteChange: fraction(differenceNumerator, current.denominator * prior.denominator),
    percentChange:
      prior.numerator === 0n
        ? null
        : fraction(differenceNumerator, current.denominator * prior.numerator),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function localDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertLocalDate(value: string): void {
  if (!localDate(value)) throw new TypeError("Finance reporting date is malformed");
}
function dateValue(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}
function shiftDate(value: Date, days: number): string {
  return formatDate(new Date(value.getTime() + days * 86_400_000));
}
function formatDate(value: Date): string {
  const formatted = value.toISOString().slice(0, 10);
  assertLocalDate(formatted);
  return formatted;
}
function decimalUnits(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value))
    throw new TypeError("Finance reporting decimal is invalid");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const units = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  return negative ? -units : units;
}
function decimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 10_000n}.${String(absolute % 10_000n).padStart(4, "0")}`;
}
function money(amount: bigint, currency: string): FinanceReportingMoney {
  return { amount: decimal(amount), currency };
}
function change(value: bigint, comparison: bigint): string | null {
  return comparison === 0n
    ? null
    : decimal(roundDivide((value - comparison) * 10_000n, comparison));
}
function roundDivide(value: bigint, divisor: bigint): bigint {
  const sign = value < 0n !== divisor < 0n ? -1n : 1n;
  const absoluteValue = value < 0n ? -value : value;
  const absoluteDivisor = divisor < 0n ? -divisor : divisor;
  return sign * ((absoluteValue + absoluteDivisor / 2n) / absoluteDivisor);
}
function fraction(numerator: bigint, denominator: bigint): string {
  return decimal(roundDivide(numerator * 10_000n, denominator));
}
function assertCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError("Finance reporting count is invalid");
}
function ratio(value: { numerator: number; denominator: number }): {
  numerator: bigint;
  denominator: bigint;
} {
  assertCount(value.numerator);
  assertCount(value.denominator);
  if (value.numerator > value.denominator)
    throw new TypeError("Finance reporting ratio is invalid");
  return value.denominator === 0
    ? { numerator: 0n, denominator: 1n }
    : { numerator: BigInt(value.numerator), denominator: BigInt(value.denominator) };
}
