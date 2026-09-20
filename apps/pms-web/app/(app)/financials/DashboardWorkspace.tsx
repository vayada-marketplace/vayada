"use client";

import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ChartBarIcon,
  ExclamationTriangleIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import type { FinanceDashboardResponse, FinanceReportingMoneyMetric } from "@vayada/domain-finance";
import { useEffect, useState } from "react";

import { ApiErrorResponse } from "@/services/api/client";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { getFinanceDashboard } from "@/services/finance/financialReports";

import { RevenueTab } from "./RevenueTab";
import { ExpensesTab } from "./ExpensesTab";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: FinanceDashboardResponse; locale: string; propertyId: string }
  | { kind: "permission" }
  | { kind: "unavailable" }
  | { kind: "error" };

const CARD_LABELS = {
  revenueToday: "Revenue today",
  revenueMtd: "Revenue this month",
  expensesMtd: "Expenses this month",
  profitMtd: "Profit this month",
} as const;

export function DashboardWorkspace() {
  const [asOf, setAsOf] = useState("");
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState<"dashboard" | "revenue" | "expenses">("dashboard");
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void (async () => {
      try {
        const propertyId = await resolveSelectedPmsPropertyId("loading Financials");
        const [data, profile] = await Promise.all([
          getFinanceDashboard(propertyId, { asOf: asOf || undefined, signal: controller.signal }),
          sharedHotelSetupApi.getPublicPropertyProfile(propertyId, { signal: controller.signal }),
        ]);
        if (!controller.signal.aborted)
          setState({ kind: "ready", data, locale: profile.publicProfile.locale, propertyId });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiErrorResponse) {
          if (error.status === 401 || error.status === 403) return setState({ kind: "permission" });
          if (error.status === 404 || error.status === 422)
            return setState({ kind: "unavailable" });
        }
        setState({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [asOf, reload]);

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <div className="flex flex-col gap-4 border-b border-gray-200 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-blue-700">Financials</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-gray-900">
            {tab === "dashboard" ? "Dashboard" : tab === "revenue" ? "Revenue" : "Expenses"}
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            {tab === "dashboard"
              ? "Revenue, costs, and upcoming property transactions."
              : tab === "revenue"
                ? "Where money comes from."
                : "Where property spend goes."}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {tab === "dashboard" && (
            <label className="grid gap-1 text-sm font-medium text-gray-700">
              As of date
              <input
                className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-gray-900 shadow-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100"
                type="date"
                value={asOf}
                onChange={(event) => setAsOf(event.target.value)}
              />
            </label>
          )}
          {tab !== "expenses" && (
            <button
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-500"
              type="button"
              disabled
              title="Exports will be added through the Financials export flow."
            >
              <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" /> Export
            </button>
          )}
          <button
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-700 px-3 text-sm font-medium text-white disabled:opacity-60"
            type="button"
            disabled
            aria-describedby="ai-insights-status"
          >
            <SparklesIcon className="h-4 w-4" aria-hidden="true" /> AI Insights
          </button>
        </div>
      </div>
      <p id="ai-insights-status" className="mt-2 text-xs text-gray-500">
        AI Insights is planned for v2.
      </p>
      <div
        className="mt-5 flex gap-1 border-b border-gray-200"
        role="tablist"
        aria-label="Financial insights"
      >
        {(["dashboard", "revenue", "expenses"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium ${tab === item ? "bg-blue-50 text-blue-800" : "text-gray-600 hover:bg-gray-50"}`}
            onClick={() => setTab(item)}
          >
            {item === "dashboard" ? "Dashboard" : item === "revenue" ? "Revenue" : "Expenses"}
          </button>
        ))}
      </div>
      {state.kind === "loading" && <DashboardSkeleton />}
      {state.kind === "ready" && tab === "dashboard" && (
        <Dashboard data={state.data} locale={state.locale} />
      )}
      {state.kind === "ready" && tab === "revenue" && (
        <RevenueTab
          propertyId={state.propertyId}
          locale={state.locale}
          generatedAt={state.data.generatedAt}
          timeZone={state.data.timeZone}
        />
      )}
      {state.kind === "ready" && tab === "expenses" && (
        <ExpensesTab
          propertyId={state.propertyId}
          locale={state.locale}
          generatedAt={state.data.generatedAt}
          timeZone={state.data.timeZone}
        />
      )}
      {state.kind !== "loading" && state.kind !== "ready" && (
        <StatusPanel kind={state.kind} onRetry={() => setReload((current) => current + 1)} />
      )}
    </div>
  );
}

function Dashboard({ data, locale }: { data: FinanceDashboardResponse; locale: string }) {
  const stale = data.incompleteEvidence.length > 0;
  const isZero =
    Object.values(data.cards).every((metric) => numeric(metric.value.amount) === 0) &&
    data.daily.every(
      (day) => numeric(day.revenue.amount) === 0 && numeric(day.expenses.amount) === 0,
    ) &&
    data.upcoming.length === 0;
  return (
    <div className="space-y-6 pt-6">
      {stale && (
        <div
          className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
          role="status"
        >
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
          Some source data is incomplete. Figures may not include the latest activity.
        </div>
      )}
      {isZero ? (
        <section className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
          <ChartBarIcon className="mx-auto h-8 w-8 text-gray-400" aria-hidden="true" />
          <h2 className="mt-3 text-base font-semibold text-gray-900">
            No financial activity for this period
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Transactions will appear here once this property has recorded activity.
          </p>
        </section>
      ) : (
        <>
          <section
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            aria-label="Financial summary"
          >
            {(Object.keys(CARD_LABELS) as Array<keyof typeof CARD_LABELS>).map((key) => (
              <MetricCard
                key={key}
                label={CARD_LABELS[key]}
                metric={data.cards[key]}
                locale={locale}
              />
            ))}
          </section>
          <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <DailyChart daily={data.daily} locale={locale} />
            <UpcomingTransactions data={data} locale={locale} />
          </section>
        </>
      )}
    </div>
  );
}

function MetricCard({
  label,
  metric,
  locale,
}: {
  label: string;
  metric: FinanceReportingMoneyMetric;
  locale: string;
}) {
  const change =
    metric.percentChange === null
      ? "No prior comparison"
      : formatPercent(metric.percentChange, locale);
  return (
    <article className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-gray-600">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">
        {formatMoney(metric.value, locale)}
      </p>
      <p className="mt-2 text-sm text-gray-600">
        {change} <span className="text-gray-500">vs prior period</span>
      </p>
    </article>
  );
}

function DailyChart({
  daily,
  locale,
}: Pick<FinanceDashboardResponse, "daily"> & { locale: string }) {
  const maximum = Math.max(
    1,
    ...daily.flatMap((day) => [
      Math.abs(numeric(day.revenue.amount)),
      Math.abs(numeric(day.expenses.amount)),
    ]),
  );
  return (
    <section className="overflow-x-auto rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Last 14 days</h2>
        <p className="mt-1 text-sm text-gray-600">Revenue and expenses in property currency.</p>
      </div>
      <div
        className="mt-5 flex h-48 min-w-[36rem] items-end gap-1"
        role="list"
        aria-label="Fourteen-day revenue and expense chart"
      >
        {daily.map((day) => (
          <div
            key={day.date}
            className="flex min-w-9 flex-1 flex-col justify-end gap-1"
            role="listitem"
            aria-label={`${formatDate(day.date, locale)}: ${formatMoney(day.revenue, locale)} revenue, ${formatMoney(day.expenses, locale)} expenses`}
          >
            <div
              className="rounded-t bg-blue-600"
              style={{
                height: `${Math.max(2, (Math.abs(numeric(day.revenue.amount)) / maximum) * 100)}%`,
              }}
            />
            <div
              className="rounded-t bg-gray-300"
              style={{
                height: `${Math.max(2, (Math.abs(numeric(day.expenses.amount)) / maximum) * 100)}%`,
              }}
            />
            <span className="mt-1 text-center text-xs text-gray-500">
              {formatDate(day.date, locale)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function UpcomingTransactions({
  data,
  locale,
}: {
  data: FinanceDashboardResponse;
  locale: string;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-semibold text-gray-900">Upcoming transactions</h2>
      <div className="mt-4 max-h-[30rem] space-y-3 overflow-y-auto pr-1">
        {data.upcoming.length ? (
          data.upcoming.map((entry) => (
            <div
              key={`${entry.date}-${entry.kind}`}
              className="flex items-start justify-between gap-3"
            >
              <div>
                <p className="text-sm font-medium text-gray-900">{entry.kind}</p>
                <p className="text-xs text-gray-500">
                  {formatDate(entry.date, locale)}
                  {entry.predicted ? " - predicted" : ""}
                </p>
              </div>
              <p
                className={
                  numeric(entry.amount.amount) >= 0
                    ? "text-sm font-medium text-emerald-700"
                    : "text-sm font-medium text-rose-700"
                }
              >
                {formatMoney(entry.amount, locale)}
              </p>
            </div>
          ))
        ) : (
          <p className="text-sm text-gray-600">No upcoming transactions.</p>
        )}
      </div>
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6 pt-6" aria-label="Loading Financials" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-32 animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-gray-100" />
    </div>
  );
}
function StatusPanel({
  kind,
  onRetry,
}: {
  kind: Exclude<LoadState["kind"], "loading" | "ready">;
  onRetry: () => void;
}) {
  const copy =
    kind === "permission"
      ? [
          "Financials access required",
          "Your role or this property does not have access to Financials.",
        ]
      : kind === "unavailable"
        ? [
            "Financials is unavailable",
            "This property’s Financials reporting is not available yet.",
          ]
        : [
            "Financials could not load",
            "Try again. If the problem continues, check the property connection.",
          ];
  return (
    <section className="mt-6 rounded-xl border border-gray-200 bg-white p-8 text-center">
      <ExclamationTriangleIcon className="mx-auto h-8 w-8 text-gray-400" aria-hidden="true" />
      <h2 className="mt-3 text-base font-semibold text-gray-900">{copy[0]}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-gray-600">{copy[1]}</p>
      {kind === "error" && (
        <button
          type="button"
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-700 px-3 py-2 text-sm font-medium text-white active:translate-y-px"
          onClick={onRetry}
        >
          <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
          Try again
        </button>
      )}
    </section>
  );
}
function numeric(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function formatMoney(value: { amount: string; currency: string }, locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: value.currency }).format(
    numeric(value.amount),
  );
}
function formatPercent(value: string, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "always",
  }).format(numeric(value));
}
function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "numeric",
    day: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}
