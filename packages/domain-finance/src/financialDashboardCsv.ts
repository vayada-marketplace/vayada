import { getTimezone } from "countries-and-timezones";

import { financeCsvRow } from "./financialCsv.js";
import {
  FINANCE_DASHBOARD_WINDOW_DAYS,
  financeDashboardPeriods,
  parseFinanceDashboardQuery,
  type FinanceDashboardQuery,
  type FinanceDashboardResponse,
  type FinanceReportingMoney,
  type FinanceReportingMoneyMetric,
} from "./financialReporting.js";

export const FINANCE_DASHBOARD_CSV_VERSION = "pms-financials-dashboard.v1" as const;
export const FINANCE_DASHBOARD_CSV_CONTENT_TYPE = "text/csv; charset=utf-8" as const;
export const FINANCE_DASHBOARD_CSV_COLUMNS = [
  "property_id",
  "as_of",
  "row_type",
  "date",
  "metric",
  "kind",
  "value",
  "currency",
  "absolute_change",
  "percent_change",
  "predicted",
] as const;

export type FinanceDashboardCsvArtifact = {
  formatVersion: typeof FINANCE_DASHBOARD_CSV_VERSION;
  contentType: typeof FINANCE_DASHBOARD_CSV_CONTENT_TYPE;
  propertyId: string;
  currency: string;
  asOf: string;
  generatedAt: string;
  filename: string;
  rowCount: number;
  body: string;
};

/** Copy only the public Dashboard read contract into labeled CSV rows. */
export function buildFinanceDashboardCsvArtifact(input: {
  propertyId: string;
  response: FinanceDashboardResponse;
  query: FinanceDashboardQuery;
}): FinanceDashboardCsvArtifact {
  const { response } = input;
  const query = parseFinanceDashboardQuery(input.query);
  const asOf = query && localDate(response.generatedAt, response.timeZone, query.asOf);
  if (
    !asOf ||
    !uuid(response.propertyId) ||
    response.propertyId !== input.propertyId ||
    response.contractVersion !== "pms-financials.v1" ||
    !/^[A-Z]{3}$/.test(response.currency) ||
    !validDashboard(response, asOf)
  )
    throw new TypeError("Dashboard CSV read contract is invalid");

  const rows: string[][] = [];
  const add = (
    type: string,
    date: string,
    metric: string,
    kind: string,
    value: string,
    change = "",
    percent = "",
    predicted = "",
  ) =>
    rows.push([
      response.propertyId,
      asOf,
      type,
      date,
      metric,
      kind,
      value,
      response.currency,
      change,
      percent,
      predicted,
    ]);
  for (const key of ["revenueToday", "revenueMtd", "expensesMtd", "profitMtd"] as const) {
    const metric = response.cards[key];
    add(
      "card",
      asOf,
      key,
      "",
      metric.value.amount,
      metric.absoluteChange.amount,
      metric.percentChange ?? "",
    );
  }
  for (const day of response.daily) {
    add("daily", day.date, "revenue", "", day.revenue.amount);
    add("daily", day.date, "expenses", "", day.expenses.amount);
  }
  for (const item of response.upcoming)
    add(
      "upcoming",
      item.date,
      "amount",
      item.kind,
      item.amount.amount,
      "",
      "",
      String(item.predicted),
    );

  return {
    formatVersion: FINANCE_DASHBOARD_CSV_VERSION,
    contentType: FINANCE_DASHBOARD_CSV_CONTENT_TYPE,
    propertyId: response.propertyId,
    currency: response.currency,
    asOf,
    generatedAt: response.generatedAt,
    filename: `pms-financials-dashboard-${response.propertyId}-${asOf}.csv`,
    rowCount: rows.length,
    body: [FINANCE_DASHBOARD_CSV_COLUMNS, ...rows].map(financeCsvRow).join("\r\n") + "\r\n",
  };
}

function validDashboard(response: FinanceDashboardResponse, asOf: string): boolean {
  const code = response.currency;
  const money = (value: FinanceReportingMoney) => value?.currency === code && decimal(value.amount);
  const metric = (value: FinanceReportingMoneyMetric) =>
    value &&
    money(value.value) &&
    money(value.absoluteChange) &&
    (value.percentChange === null || decimal(value.percentChange));
  const days = financeDashboardPeriods(asOf).daily;
  const start = Date.parse(`${days.from}T00:00:00Z`);
  return (
    [
      response.cards?.revenueToday,
      response.cards?.revenueMtd,
      response.cards?.expensesMtd,
      response.cards?.profitMtd,
    ].every(metric) &&
    Array.isArray(response.daily) &&
    response.daily.length === FINANCE_DASHBOARD_WINDOW_DAYS &&
    response.daily.every(
      (day, index) =>
        day.date === new Date(start + index * 86_400_000).toISOString().slice(0, 10) &&
        money(day.revenue) &&
        money(day.expenses),
    ) &&
    Array.isArray(response.upcoming) &&
    response.upcoming.every(
      (item, index) =>
        !!parseFinanceDashboardQuery({ asOf: item.date }) &&
        item.date >= asOf &&
        (index === 0 || item.date >= response.upcoming[index - 1]!.date) &&
        label(item.kind) &&
        money(item.amount) &&
        typeof item.predicted === "boolean",
    )
  );
}

function localDate(instant: string, timeZone: string, requested?: string): string | null {
  if (!Number.isFinite(Date.parse(instant)) || new Date(instant).toISOString() !== instant)
    return null;
  try {
    const zone = getTimezone(timeZone);
    if (zone?.name !== timeZone || zone.aliasOf !== null) return null;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(instant))
        .map((part) => [part.type, part.value]),
    );
    const asOf = requested ?? `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
    return parseFinanceDashboardQuery({ asOf }) ? asOf : null;
  } catch {
    return null;
  }
}
const decimal = (value: string) =>
  typeof value === "string" && /^-?(?:0|[1-9]\d*)\.\d{4}$/.test(value);
const label = (value: string) =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200;
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
