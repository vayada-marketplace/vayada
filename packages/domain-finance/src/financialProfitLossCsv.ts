import {
  assertFinanceProfitLossResponse,
  parseFinanceProfitLossQuery,
  type FinanceProfitLossExpenseCategoryRow,
  type FinanceProfitLossQuery,
  type FinanceProfitLossResponse,
} from "./financialReporting.js";

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

/** Materialize only the already-reconciled read contract, never raw ledger or guest evidence. */
export function buildFinanceProfitLossCsvArtifact(input: {
  propertyId: string;
  response: FinanceProfitLossResponse;
  query: FinanceProfitLossQuery;
  asOf: string;
  categoryRows: readonly FinanceProfitLossExpenseCategoryRow[];
}) {
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
    body: [FINANCE_PROFIT_LOSS_CSV_COLUMNS, ...rows].map(csvRow).join("\r\n") + "\r\n",
  };
}

// Guard every cell, including future fields, before CSV quoting.
const csvRow = (values: Row) =>
  values
    .map((value) => {
      const safe =
        /^[=+\-@\t\r\n]/.test(value) && !/^-?(?:0|[1-9]\d*)\.\d{4}$/.test(value)
          ? `'${value}`
          : value;
      return `"${safe.replaceAll('"', '""')}"`;
    })
    .join(",");

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
