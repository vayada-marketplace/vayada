import { PMS_FINANCIALS_CONTRACT_VERSION } from "./financialExpenses.js";

export const FINANCE_DASHBOARD_WINDOW_DAYS = 14;

export type FinanceDashboardQuery = { asOf?: string };
export type FinanceRevenueQuery = { from: string; to: string };
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
export type FinanceReportingEnvelope = {
  contractVersion: typeof PMS_FINANCIALS_CONTRACT_VERSION;
  propertyId: string;
  currency: string;
  timeZone: string;
  generatedAt: string;
  sourceFreshness: Record<string, string>;
  incompleteEvidence: Array<{
    code: string;
    count: number;
    amount?: FinanceReportingMoney;
  }>;
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
