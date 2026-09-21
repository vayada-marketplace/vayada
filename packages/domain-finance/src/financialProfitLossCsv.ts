import {
  assertFinanceProfitLossResponse,
  parseFinanceProfitLossQuery,
  type FinanceProfitLossExpenseCategoryRow,
  type FinanceProfitLossQuery,
  type FinanceProfitLossResponse,
} from "./financialReporting.js";
import { financeCsvRow } from "./financialCsv.js";

export const FINANCE_PROFIT_LOSS_CSV_VERSION = "pms-financials-profit-loss.v1" as const;
export const FINANCE_PROFIT_LOSS_CSV_CONTENT_TYPE = "text/csv; charset=utf-8" as const;
export const FINANCE_PROFIT_LOSS_CSV_COLUMNS = [
  "property_id",
  "year",
  "as_of",
  "row_type",
  "period",
  "metric",
  "category",
  "value",
  "currency",
  "absolute_change",
  "percent_change",
] as const;

type Row = readonly string[];
export type FinanceProfitLossCsvArtifact = {
  formatVersion: typeof FINANCE_PROFIT_LOSS_CSV_VERSION;
  contentType: typeof FINANCE_PROFIT_LOSS_CSV_CONTENT_TYPE;
  propertyId: string;
  currency: string;
  asOf: string;
  generatedAt: string;
  filename: string;
  rowCount: number;
  body: string;
};
export type FinanceProfitLossExportSnapshot = Readonly<{
  formatVersion: typeof FINANCE_PROFIT_LOSS_CSV_VERSION;
  propertyId: string;
  currency: string;
  timeZone: string;
  filters: FinanceProfitLossQuery;
  snapshotAt: string;
  asOf: string;
  manifest: readonly [
    {
      response: FinanceProfitLossResponse;
      categoryRows: readonly FinanceProfitLossExpenseCategoryRow[];
    },
  ];
}>;

/** Materialize only the already-reconciled read contract, never raw ledger or guest evidence. */
export function buildFinanceProfitLossCsvArtifact(input: {
  propertyId: string;
  response: FinanceProfitLossResponse;
  query: FinanceProfitLossQuery;
  asOf: string;
  categoryRows: readonly FinanceProfitLossExpenseCategoryRow[];
}): FinanceProfitLossCsvArtifact {
  const { response, query, asOf, categoryRows } = input;
  if (
    !parseFinanceProfitLossQuery(query) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      response.propertyId,
    ) ||
    response.propertyId !== input.propertyId ||
    response.contractVersion !== "pms-financials.v1" ||
    !Number.isFinite(Date.parse(response.generatedAt)) ||
    !response.generatedAt.endsWith("Z") ||
    localDate(response.generatedAt, response.timeZone) !== asOf
  )
    throw new TypeError("Profit and loss CSV scope is invalid");
  assertFinanceProfitLossResponse(response, query, asOf, categoryRows);

  const rows: Row[] = [];
  const add = (
    type: string,
    period: string,
    metric: string,
    category: string,
    value: string,
    change = "",
    percent = "",
  ) =>
    rows.push([
      response.propertyId,
      String(query.year),
      asOf,
      type,
      period,
      metric,
      category,
      value,
      response.currency,
      change,
      percent,
    ]);
  for (const key of ["revenueYtd", "expensesYtd", "netProfitYtd"] as const) {
    const metric = response.summary[key];
    add(
      "summary",
      String(query.year),
      key,
      "",
      metric.value.amount,
      metric.absoluteChange.amount,
      metric.percentChange ?? "",
    );
  }
  for (const month of response.months) {
    for (const key of ["roomRevenue", "upsellRevenue", "revenue", "expenses", "netProfit"] as const)
      add("month", month.month, key, "", month[key].amount);
    for (const category of Object.keys(month.expenseCategories).sort())
      add(
        "expense_category",
        month.month,
        "expenses",
        category,
        month.expenseCategories[category as FinanceProfitLossExpenseCategoryRow]!.amount,
      );
  }
  return {
    formatVersion: FINANCE_PROFIT_LOSS_CSV_VERSION,
    contentType: FINANCE_PROFIT_LOSS_CSV_CONTENT_TYPE,
    propertyId: response.propertyId,
    currency: response.currency,
    asOf,
    generatedAt: response.generatedAt,
    filename: `pms-financials-profit-loss-${response.propertyId}-${query.year}-${asOf}.csv`,
    rowCount: rows.length,
    body: [FINANCE_PROFIT_LOSS_CSV_COLUMNS, ...rows].map(financeCsvRow).join("\r\n") + "\r\n",
  };
}

/** Pin whitelisted, reconciled read evidence for deterministic durable retry. */
export function captureFinanceProfitLossExport(input: {
  propertyId: string;
  response: FinanceProfitLossResponse;
  query: FinanceProfitLossQuery;
  asOf: string;
  categoryRows: readonly FinanceProfitLossExpenseCategoryRow[];
}): FinanceProfitLossExportSnapshot {
  const artifact = buildFinanceProfitLossCsvArtifact(input);
  return {
    formatVersion: FINANCE_PROFIT_LOSS_CSV_VERSION,
    propertyId: artifact.propertyId,
    currency: artifact.currency,
    timeZone: input.response.timeZone,
    filters: { year: input.query.year },
    snapshotAt: artifact.generatedAt,
    asOf: artifact.asOf,
    manifest: [{ response: copyResponse(input.response), categoryRows: [...input.categoryRows] }],
  };
}

export function parseFinanceProfitLossExportSnapshot(
  value: unknown,
): FinanceProfitLossExportSnapshot | null {
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
  const filters = parseFinanceProfitLossQuery(value.filters);
  if (
    value.formatVersion !== FINANCE_PROFIT_LOSS_CSV_VERSION ||
    !uuid(value.propertyId) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !filters ||
    !canonicalInstant(value.snapshotAt) ||
    typeof value.asOf !== "string" ||
    typeof value.timeZone !== "string" ||
    localDate(value.snapshotAt, value.timeZone) !== value.asOf ||
    !Array.isArray(value.manifest) ||
    value.manifest.length !== 1
  )
    return null;
  const selection = value.manifest[0];
  if (
    !record(selection) ||
    !exact(selection, ["response", "categoryRows"]) ||
    !validSnapshotResponse(selection.response) ||
    !Array.isArray(selection.categoryRows)
  )
    return null;
  try {
    buildFinanceProfitLossCsvArtifact({
      propertyId: value.propertyId,
      response: selection.response,
      query: filters,
      asOf: value.asOf,
      categoryRows: selection.categoryRows,
    });
  } catch {
    return null;
  }
  if (
    selection.response.currency !== value.currency ||
    selection.response.generatedAt !== value.snapshotAt ||
    selection.response.timeZone !== value.timeZone
  )
    return null;
  return {
    formatVersion: FINANCE_PROFIT_LOSS_CSV_VERSION,
    propertyId: value.propertyId,
    currency: value.currency,
    timeZone: value.timeZone,
    filters,
    snapshotAt: value.snapshotAt,
    asOf: value.asOf,
    manifest: [
      { response: copyResponse(selection.response), categoryRows: [...selection.categoryRows] },
    ],
  };
}

function localDate(instant: string, timeZone: string): string | null {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(instant))
        .map((part) => [part.type, part.value]),
    );
    return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
  } catch {
    return null;
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const canonicalInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function copyResponse(response: FinanceProfitLossResponse): FinanceProfitLossResponse {
  const money = (value: { amount: string; currency: string }) => ({
    amount: value.amount,
    currency: value.currency,
  });
  const metric = (value: FinanceProfitLossResponse["summary"]["revenueYtd"]) => ({
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
    summary: {
      revenueYtd: metric(response.summary.revenueYtd),
      expensesYtd: metric(response.summary.expensesYtd),
      netProfitYtd: metric(response.summary.netProfitYtd),
    },
    months: response.months.map((month) => ({
      month: month.month,
      roomRevenue: money(month.roomRevenue),
      upsellRevenue: money(month.upsellRevenue),
      revenue: money(month.revenue),
      expenses: money(month.expenses),
      netProfit: money(month.netProfit),
      expenseCategories: Object.fromEntries(
        Object.entries(month.expenseCategories)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [key, money(value)]),
      ) as FinanceProfitLossResponse["months"][number]["expenseCategories"],
    })),
  };
}

function validSnapshotResponse(value: unknown): value is FinanceProfitLossResponse {
  const money = (item: unknown) => record(item) && exact(item, ["amount", "currency"]);
  const metric = (item: unknown) =>
    record(item) &&
    exact(item, ["value", "absoluteChange", "percentChange"]) &&
    money(item.value) &&
    money(item.absoluteChange);
  const month = (item: unknown) =>
    record(item) &&
    exact(item, [
      "month",
      "roomRevenue",
      "upsellRevenue",
      "revenue",
      "expenses",
      "netProfit",
      "expenseCategories",
    ]) &&
    ["roomRevenue", "upsellRevenue", "revenue", "expenses", "netProfit"].every((key) =>
      money(item[key]),
    ) &&
    record(item.expenseCategories) &&
    Object.values(item.expenseCategories).every(money);
  return (
    record(value) &&
    exact(value, [
      "contractVersion",
      "propertyId",
      "currency",
      "timeZone",
      "generatedAt",
      "sourceFreshness",
      "incompleteEvidence",
      "summary",
      "months",
    ]) &&
    record(value.sourceFreshness) &&
    Object.keys(value.sourceFreshness).length === 0 &&
    Array.isArray(value.incompleteEvidence) &&
    value.incompleteEvidence.length === 0 &&
    record(value.summary) &&
    exact(value.summary, ["revenueYtd", "expensesYtd", "netProfitYtd"]) &&
    Object.values(value.summary).every(metric) &&
    Array.isArray(value.months) &&
    value.months.every(month)
  );
}
