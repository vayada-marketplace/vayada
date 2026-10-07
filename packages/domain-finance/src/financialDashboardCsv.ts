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
export type FinanceDashboardExportSnapshot = Readonly<{
  formatVersion: typeof FINANCE_DASHBOARD_CSV_VERSION;
  propertyId: string;
  currency: string;
  timeZone: string;
  filters: FinanceDashboardQuery;
  snapshotAt: string;
  asOf: string;
  manifest: readonly [{ response: FinanceDashboardResponse }];
}>;

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

/** Pin only CSV-needed read fields so durable retries never query newer financial evidence. */
export function captureFinanceDashboardExport(input: {
  propertyId: string;
  response: FinanceDashboardResponse;
  query: FinanceDashboardQuery;
}): FinanceDashboardExportSnapshot {
  const artifact = buildFinanceDashboardCsvArtifact(input);
  return {
    formatVersion: FINANCE_DASHBOARD_CSV_VERSION,
    propertyId: artifact.propertyId,
    currency: artifact.currency,
    timeZone: input.response.timeZone,
    filters: { asOf: artifact.asOf },
    snapshotAt: artifact.generatedAt,
    asOf: artifact.asOf,
    manifest: [{ response: copyDashboardResponse(input.response) }],
  };
}

export function parseFinanceDashboardExportSnapshot(
  value: unknown,
): FinanceDashboardExportSnapshot | null {
  if (
    !record(value) ||
    !exact(value, [
      "formatVersion",
      "propertyId",
      "currency",
      "timeZone",
      "filters",
      "snapshotAt",
      "asOf",
      "manifest",
    ])
  )
    return null;
  const filters = parseFinanceDashboardQuery(value.filters);
  if (
    value.formatVersion !== FINANCE_DASHBOARD_CSV_VERSION ||
    !uuid(value.propertyId) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !filters ||
    filters.asOf !== value.asOf ||
    !utc(value.snapshotAt) ||
    !parseFinanceDashboardQuery({ asOf: value.asOf }) ||
    !Array.isArray(value.manifest) ||
    value.manifest.length !== 1
  )
    return null;
  const selection = value.manifest[0];
  if (!record(selection) || !exact(selection, ["response"])) return null;
  let artifact: FinanceDashboardCsvArtifact;
  try {
    artifact = buildFinanceDashboardCsvArtifact({
      propertyId: value.propertyId,
      response: selection.response as FinanceDashboardResponse,
      query: filters,
    });
  } catch {
    return null;
  }
  const response = selection.response as FinanceDashboardResponse;
  if (
    artifact.asOf !== value.asOf ||
    response.currency !== value.currency ||
    response.generatedAt !== value.snapshotAt ||
    response.timeZone !== value.timeZone
  )
    return null;
  return {
    formatVersion: FINANCE_DASHBOARD_CSV_VERSION,
    propertyId: value.propertyId,
    currency: value.currency,
    timeZone: value.timeZone,
    filters,
    snapshotAt: value.snapshotAt,
    asOf: artifact.asOf,
    manifest: [{ response: copyDashboardResponse(response) }],
  };
}

function copyDashboardResponse(response: FinanceDashboardResponse): FinanceDashboardResponse {
  const money = (value: FinanceReportingMoney) => ({
    amount: value.amount,
    currency: value.currency,
  });
  const metric = (value: FinanceReportingMoneyMetric) => ({
    value: money(value.value),
    absoluteChange: money(value.absoluteChange),
    percentChange: value.percentChange,
  });
  return {
    contractVersion: response.contractVersion,
    propertyId: response.propertyId,
    currency: response.currency,
    timeZone: response.timeZone,
    generatedAt: response.generatedAt,
    sourceFreshness: {},
    incompleteEvidence: [],
    cards: {
      revenueToday: metric(response.cards.revenueToday),
      revenueMtd: metric(response.cards.revenueMtd),
      expensesMtd: metric(response.cards.expensesMtd),
      profitMtd: metric(response.cards.profitMtd),
    },
    daily: response.daily.map((day) => ({
      date: day.date,
      revenue: money(day.revenue),
      expenses: money(day.expenses),
    })),
    upcoming: response.upcoming.map((item) => ({
      date: item.date,
      kind: item.kind,
      amount: money(item.amount),
      predicted: item.predicted,
    })),
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
  if (!utc(instant)) return null;
  const generated = new Date(instant);
  try {
    const zone = getTimezone(timeZone);
    if (zone?.name !== timeZone || zone.aliasOf !== null) return null;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(generated)
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
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const utc = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
