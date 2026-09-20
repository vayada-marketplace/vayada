"use client";

import type {
  FinanceProfitLossResponse,
  FinanceReportingMoney,
  FinanceReportingMoneyMetric,
} from "@vayada/domain-finance";
import { useEffect, useMemo, useState } from "react";

import { ApiErrorResponse } from "@/services/api/client";
import { getExpenseCategories } from "@/services/finance/financialExpenses";
import { getFinanceProfitLoss } from "@/services/finance/financialReports";

type Month = FinanceProfitLossResponse["months"][number];
type Row = {
  key: string;
  label: string;
  get: (month: Month) => FinanceReportingMoney;
  total?: boolean;
};
type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      data: FinanceProfitLossResponse;
      names: Map<string, string>;
      namesUnavailable: boolean;
    }
  | { kind: "permission" | "unavailable" | "error" };

const systemCategories = [
  ["ota_commission", "OTA commission"],
  ["staff", "Staff"],
  ["utilities", "Utilities"],
  ["maintenance_supplies", "Maintenance & supplies"],
  ["marketing_platform", "Marketing & platform fees"],
] as const;

export function ProfitLossTab({
  propertyId,
  locale,
  generatedAt,
  timeZone,
}: {
  propertyId: string;
  locale: string;
  generatedAt: string;
  timeZone: string;
}) {
  const currentYear = useMemo(
    () =>
      Number(
        new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(new Date(generatedAt)),
      ),
    [generatedAt, timeZone],
  );
  const [draftYear, setDraftYear] = useState(String(currentYear));
  const [year, setYear] = useState(currentYear);
  const [yearError, setYearError] = useState("");
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void Promise.all([
      getFinanceProfitLoss(propertyId, { year, signal: controller.signal }),
      getExpenseCategories(propertyId, controller.signal).catch(() => null),
    ])
      .then(([data, categories]) => {
        if (!controller.signal.aborted)
          setState({
            kind: "ready",
            data,
            names: new Map(categories?.item.map((item) => [item.id, item.name]) ?? []),
            namesUnavailable: categories === null,
          });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiErrorResponse) {
          if (error.status === 401 || error.status === 403) return setState({ kind: "permission" });
          if (error.status === 404 || error.status === 422)
            return setState({ kind: "unavailable" });
        }
        setState({ kind: "error" });
      });
    return () => controller.abort();
  }, [propertyId, year, reload]);

  const rows = state.kind === "ready" ? profitLossRows(state.data, state.names) : [];
  const periodLabel = year === currentYear ? "YTD" : "full year";
  const exportCsv = () => {
    if (state.kind !== "ready") return;
    const csv = buildProfitLossCsv(state.data, state.names);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `pms-profit-loss-${propertyId}-${year}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="space-y-5 pt-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Profit & loss</h2>
          <p className="mt-1 text-sm text-gray-600">
            Year-to-date performance by month and expense category.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <form
            aria-label="Profit and loss year"
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const selected = Number(draftYear);
              if (!Number.isInteger(selected) || selected < 1001 || selected > currentYear) {
                setYearError(`Choose a year from 1001 through ${currentYear}.`);
                return;
              }
              setYearError("");
              setYear(selected);
            }}
          >
            <label className="grid gap-1 text-xs font-medium text-gray-600">
              Year
              <input
                className="h-10 w-24 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900"
                type="number"
                min="1001"
                max={currentYear}
                required
                value={draftYear}
                onChange={(event) => {
                  setDraftYear(event.target.value);
                  setYearError("");
                }}
              />
            </label>
            <button
              className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700"
              type="submit"
            >
              Apply
            </button>
          </form>
          <button
            className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 disabled:opacity-50"
            type="button"
            disabled={state.kind !== "ready" || draftYear !== String(year)}
            title={
              draftYear !== String(year) ? "Apply the selected year before exporting." : undefined
            }
            onClick={exportCsv}
          >
            Export CSV
          </button>
        </div>
      </div>
      {yearError && (
        <p className="text-sm text-red-700" role="alert">
          {yearError}
        </p>
      )}
      {state.kind === "loading" && (
        <div
          className="h-64 animate-pulse rounded-xl bg-gray-100"
          aria-label="Loading profit and loss"
        />
      )}
      {state.kind === "ready" && (
        <>
          {state.data.incompleteEvidence.length > 0 && (
            <p
              className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
              role="status"
            >
              Some financial evidence is incomplete. Figures may exclude source activity.
            </p>
          )}
          {state.namesUnavailable && (
            <p
              className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
              role="status"
            >
              Custom category names could not be loaded; their IDs are shown instead.
            </p>
          )}
          <section
            className="grid gap-3 sm:grid-cols-3"
            aria-label={`${year === currentYear ? "Year-to-date" : "Full-year"} summary for ${year}`}
          >
            <SummaryCard
              label={`Revenue ${periodLabel}`}
              metric={state.data.summary.revenueYtd}
              locale={locale}
            />
            <SummaryCard
              label={`Expenses ${periodLabel}`}
              metric={state.data.summary.expensesYtd}
              locale={locale}
            />
            <SummaryCard
              label={`Net profit ${periodLabel}`}
              metric={state.data.summary.netProfitYtd}
              locale={locale}
            />
          </section>
          <section
            className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm"
            tabIndex={0}
            aria-label="Monthly profit and loss table"
          >
            <table className="w-full min-w-max border-collapse text-sm">
              <caption className="sr-only">
                Monthly profit and loss for {year} in {state.data.currency}
              </caption>
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-gray-600">
                  <th
                    className="sticky left-0 bg-gray-50 px-4 py-3 text-left font-medium"
                    scope="col"
                  >
                    Line item
                  </th>
                  {state.data.months.map((month) => (
                    <th key={month.month} className="px-4 py-3 text-right font-medium" scope="col">
                      {formatMonth(month.month, locale)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.key}
                    className={`border-b border-gray-100 ${row.total ? "bg-gray-50 font-semibold text-gray-900" : "text-gray-700"}`}
                  >
                    <th
                      className={`sticky left-0 whitespace-nowrap px-4 py-3 text-left ${row.total ? "bg-gray-50" : "bg-white"}`}
                      scope="row"
                    >
                      {row.label}
                    </th>
                    {state.data.months.map((month) => (
                      <td
                        key={month.month}
                        className="whitespace-nowrap px-4 py-3 text-right tabular-nums"
                      >
                        {formatMoney(row.get(month), locale)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
      {state.kind !== "loading" && state.kind !== "ready" && (
        <div
          className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-700"
          role="alert"
        >
          <p>
            {state.kind === "permission"
              ? "You do not have access to profit and loss."
              : state.kind === "unavailable"
                ? "Profit and loss is not available for this property or year."
                : "Profit and loss could not be loaded."}
          </p>
          {state.kind === "error" && (
            <button
              className="mt-4 rounded-lg bg-blue-700 px-4 py-2 font-medium text-white"
              type="button"
              onClick={() => setReload((value) => value + 1)}
            >
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function profitLossRows(data: FinanceProfitLossResponse, names: Map<string, string>): Row[] {
  const categoryKeys = Object.keys(data.months[0]?.expenseCategories ?? {});
  const categories: Row[] = [
    ...systemCategories
      .filter(([key]) => categoryKeys.includes(key))
      .map(([key, label]) => ({
        key,
        label,
        get: (month: Month) => month.expenseCategories[key]!,
      })),
    ...categoryKeys
      .filter((key) => key.startsWith("custom:"))
      .map((key) => ({
        key,
        label: names.get(key.slice(7)) ?? `Custom ${key.slice(7)}`,
        get: (month: Month) => month.expenseCategories[key as `custom:${string}`]!,
      })),
  ];
  return [
    { key: "room_revenue", label: "Room revenue", get: (month) => month.roomRevenue },
    { key: "upsell_revenue", label: "Upsell revenue", get: (month) => month.upsellRevenue },
    { key: "total_revenue", label: "Total revenue", get: (month) => month.revenue, total: true },
    ...categories,
    { key: "total_expenses", label: "Total expenses", get: (month) => month.expenses, total: true },
    { key: "net_profit", label: "Net profit", get: (month) => month.netProfit, total: true },
  ];
}

function SummaryCard({
  label,
  metric,
  locale,
}: {
  label: string;
  metric: FinanceReportingMoneyMetric;
  locale: string;
}) {
  return (
    <article className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-gray-600">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">
        {formatMoney(metric.value, locale)}
      </p>
      <p className="mt-1 text-xs text-gray-500">
        {formatMoney(metric.absoluteChange, locale)} vs prior year
        {metric.percentChange === null ? "" : ` · ${metric.percentChange}%`}
      </p>
    </article>
  );
}

export function buildProfitLossCsv(
  data: FinanceProfitLossResponse,
  names: Map<string, string>,
): string {
  const rows = profitLossRows(data, names);
  const lines = [
    ["Line item", ...data.months.map((month) => `${month.month} (${data.currency})`)],
    ...rows.map((row) => [row.label, ...data.months.map((month) => row.get(month).amount)]),
  ];
  return (
    lines
      .map((line) => line.map((value, index) => csvCell(value, index === 0)).join(","))
      .join("\r\n") + "\r\n"
  );
}

function csvCell(value: string, label: boolean) {
  const safe = label && /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
function formatMoney(value: FinanceReportingMoney, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
    maximumFractionDigits: 4,
  }).format(Number(value.amount));
}
function formatMonth(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}-01T00:00:00Z`));
}
