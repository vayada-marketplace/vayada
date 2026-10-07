"use client";

import { ReportExportButton } from "./ReportExportButton";

import type {
  FinanceReportingMoney,
  FinanceReportingMoneyMetric,
  FinanceRevenueResponse,
} from "@vayada/domain-finance";
import { useEffect, useMemo, useState } from "react";

import { ApiErrorResponse } from "@/services/api/client";
import { getFinanceRevenue, getRoomTypeNames } from "@/services/finance/financialReports";

type RevenueState =
  | { kind: "loading" }
  | { kind: "ready"; data: FinanceRevenueResponse; roomTypeNames: Map<string, string> }
  | { kind: "permission" }
  | { kind: "unavailable" }
  | { kind: "error" };

const SUMMARY_CARDS = [
  ["Gross revenue", "grossRoom"],
  ["OTA commissions", "otaCommission"],
  ["Net room revenue", "netRoom"],
  ["Upsell revenue", "upsell"],
] as const;

export function RevenueTab({
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
  const initialRange = useMemo(
    () => currentMonthRange(generatedAt, timeZone),
    [generatedAt, timeZone],
  );
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<RevenueState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    if (!from || !to || from > to) {
      setState({ kind: "error" });
      return () => controller.abort();
    }
    setState({ kind: "loading" });
    void (async () => {
      try {
        const data = await getFinanceRevenue(propertyId, { from, to, signal: controller.signal });
        if (controller.signal.aborted) return;
        setState({ kind: "ready", data, roomTypeNames: new Map() });
        void getRoomTypeNames(propertyId, controller.signal)
          .then((roomTypes) => {
            if (controller.signal.aborted) return;
            setState((current) =>
              current.kind === "ready"
                ? {
                    ...current,
                    roomTypeNames: new Map(
                      roomTypes.items.map((roomType) => [roomType.roomTypeId, roomType.name]),
                    ),
                  }
                : current,
            );
          })
          .catch(() => undefined);
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
  }, [from, propertyId, reload, to]);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Revenue by channel</h2>
          <p className="mt-1 text-sm text-gray-600">Gross, commission, and net room revenue.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="grid gap-1 text-sm font-medium text-gray-700">
            From
            <input
              className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-gray-900 shadow-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-gray-700">
            To
            <input
              className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-gray-900 shadow-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <ReportExportButton
            propertyId={propertyId}
            input={{ tab: "revenue", filters: { from, to } }}
            disabled={state.kind !== "ready" || !from || !to || from > to}
          />
        </div>
      </section>
      {state.kind === "loading" && <RevenueSkeleton />}
      {state.kind === "ready" && (
        <Revenue data={state.data} locale={locale} roomTypeNames={state.roomTypeNames} />
      )}
      {state.kind !== "loading" && state.kind !== "ready" && (
        <RevenueStatus kind={state.kind} onRetry={() => setReload((current) => current + 1)} />
      )}
    </div>
  );
}

function Revenue({
  data,
  locale,
  roomTypeNames,
}: {
  data: FinanceRevenueResponse;
  locale: string;
  roomTypeNames: Map<string, string>;
}) {
  return (
    <>
      {data.incompleteEvidence.length > 0 && (
        <p
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
          role="status"
        >
          Some revenue evidence is incomplete. Figures may not include the latest activity.
        </p>
      )}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Revenue summary">
        {SUMMARY_CARDS.map(([label, key]) => (
          <RevenueCard
            key={key}
            label={label}
            metric={data.summary[key]}
            locale={locale}
            negative={key === "otaCommission"}
          />
        ))}
      </section>
      <section className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="min-w-[46rem] w-full text-left text-sm">
          <caption className="sr-only">Revenue by channel</caption>
          <thead className="border-b border-gray-200 bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3" scope="col">
                Channel
              </th>
              <th className="px-4 py-3 text-right" scope="col">
                Gross
              </th>
              <th className="px-4 py-3 text-right" scope="col">
                Commission
              </th>
              <th className="px-4 py-3 text-right" scope="col">
                Net
              </th>
              <th className="px-4 py-3 text-right" scope="col">
                Share
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.channels.length ? (
              data.channels.map((channel) => (
                <tr key={channel.channel}>
                  <th className="px-4 py-3 font-medium text-gray-900" scope="row">
                    {channelLabel(channel.channel)}
                  </th>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {formatMoney(channel.gross, locale)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {formatCommission(channel.commission, locale)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {formatMoney(channel.net, locale)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {formatPercent(channel.share, locale)}
                  </td>
                </tr>
              ))
            ) : (
              <EmptyRow columns={5} label="No revenue channels for this period." />
            )}
          </tbody>
          {data.channels.length > 0 && (
            <tfoot className="border-t border-gray-200 bg-gray-50 font-semibold text-gray-900">
              <tr>
                <th className="px-4 py-3" scope="row">
                  Total
                </th>
                <td className="px-4 py-3 text-right">
                  {formatMoney(data.summary.grossRoom.value, locale)}
                </td>
                <td className="px-4 py-3 text-right">
                  {formatCommission(data.summary.otaCommission.value, locale)}
                </td>
                <td className="px-4 py-3 text-right">
                  {formatMoney(data.summary.netRoom.value, locale)}
                </td>
                <td className="px-4 py-3 text-right">100%</td>
              </tr>
            </tfoot>
          )}
        </table>
      </section>
      <section className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="p-4">
          <h2 className="text-base font-semibold text-gray-900">Direct sources</h2>
          <p className="mt-1 text-sm text-gray-600">Revenue from direct booking sources.</p>
        </div>
        <table className="min-w-[30rem] w-full text-left text-sm">
          <caption className="sr-only">Direct booking sources</caption>
          <thead className="border-y border-gray-200 bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3" scope="col">
                Source
              </th>
              <th className="px-4 py-3 text-right" scope="col">
                Revenue
              </th>
              <th className="px-4 py-3 text-right" scope="col">
                Share
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.directSources.length ? (
              data.directSources.map((source) => (
                <tr key={source.source}>
                  <th className="px-4 py-3 font-medium text-gray-900" scope="row">
                    {channelLabel(source.source)}
                  </th>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {formatMoney(source.revenue, locale)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {formatPercent(source.share, locale)}
                  </td>
                </tr>
              ))
            ) : (
              <EmptyRow columns={3} label="No direct booking sources for this period." />
            )}
          </tbody>
        </table>
      </section>
      <section className="grid gap-6 xl:grid-cols-2">
        <BreakdownList
          title="Upsell revenue"
          description="Revenue split by ownership."
          emptyLabel="No upsell revenue for this period."
          rows={data.upsells.map((upsell) => ({
            label: upsell.ownership === "property" ? "Property-owned" : "Partner-owned",
            value: formatMoney(upsell.revenue, locale),
          }))}
        />
        <section className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="p-4">
            <h2 className="text-base font-semibold text-gray-900">Revenue by room type</h2>
            <p className="mt-1 text-sm text-gray-600">Nights, revenue, and average daily rate.</p>
          </div>
          <table className="min-w-[34rem] w-full text-left text-sm">
            <caption className="sr-only">Revenue by room type</caption>
            <thead className="border-y border-gray-200 bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3" scope="col">
                  Room type
                </th>
                <th className="px-4 py-3 text-right" scope="col">
                  Nights
                </th>
                <th className="px-4 py-3 text-right" scope="col">
                  Revenue
                </th>
                <th className="px-4 py-3 text-right" scope="col">
                  ADR
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.roomTypes.length ? (
                data.roomTypes.map((roomType) => (
                  <tr key={roomType.roomTypeId}>
                    <th className="px-4 py-3 font-medium text-gray-900" scope="row">
                      {roomTypeNames.get(roomType.roomTypeId) ?? roomType.roomTypeId}
                    </th>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {formatCount(roomType.nights, locale)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {formatMoney(roomType.revenue, locale)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {formatMoney(roomType.adr, locale)}
                    </td>
                  </tr>
                ))
              ) : (
                <EmptyRow columns={4} label="No room-type revenue for this period." />
              )}
            </tbody>
          </table>
        </section>
      </section>
    </>
  );
}

function BreakdownList({
  title,
  description,
  emptyLabel,
  rows,
}: {
  title: string;
  description: string;
  emptyLabel: string;
  rows: Array<{ label: string; value: string }>;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      <p className="mt-1 text-sm text-gray-600">{description}</p>
      {rows.length ? (
        <dl className="mt-4 divide-y divide-gray-100">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-4 py-3 text-sm">
              <dt className="font-medium text-gray-900">{row.label}</dt>
              <dd className="text-right text-gray-700">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-4 text-sm text-gray-600">{emptyLabel}</p>
      )}
    </section>
  );
}

function RevenueCard({
  label,
  metric,
  locale,
  negative,
}: {
  label: string;
  metric: FinanceReportingMoneyMetric;
  locale: string;
  negative: boolean;
}) {
  return (
    <article className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-gray-600">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">
        {negative ? formatCommission(metric.value, locale) : formatMoney(metric.value, locale)}
      </p>
      <p className="mt-2 text-sm text-gray-600">
        {metric.percentChange === null
          ? "No prior comparison"
          : formatSignedPercent(metric.percentChange, locale)}{" "}
        <span className="text-gray-500">vs prior period</span>
      </p>
    </article>
  );
}

function EmptyRow({ columns, label }: { columns: number; label: string }) {
  return (
    <tr>
      <td className="px-4 py-6 text-center text-gray-600" colSpan={columns}>
        {label}
      </td>
    </tr>
  );
}
function RevenueSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading Revenue" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-32 animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-gray-100" />
    </div>
  );
}
function RevenueStatus({
  kind,
  onRetry,
}: {
  kind: Exclude<RevenueState["kind"], "loading" | "ready">;
  onRetry: () => void;
}) {
  const copy =
    kind === "permission"
      ? ["Revenue access required", "Your role or this property does not have access to Revenue."]
      : kind === "unavailable"
        ? ["Revenue is unavailable", "This property’s Revenue reporting is not available yet."]
        : ["Revenue could not load", "Choose a valid date range and try again."];
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-8 text-center">
      <h2 className="text-base font-semibold text-gray-900">{copy[0]}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-gray-600">{copy[1]}</p>
      {kind === "error" && (
        <button
          className="mt-4 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          type="button"
          onClick={onRetry}
        >
          Try again
        </button>
      )}
    </section>
  );
}
function currentMonthRange(generatedAt: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(generatedAt))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const to = `${parts.year}-${parts.month}-${parts.day}`;
  return { from: `${parts.year}-${parts.month}-01`, to };
}
function channelLabel(value: string) {
  return value.replaceAll(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function numeric(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function formatMoney(value: FinanceReportingMoney, locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: value.currency }).format(
    numeric(value.amount),
  );
}
function formatCommission(value: FinanceReportingMoney, locale: string) {
  return formatMoney(
    { ...value, amount: numeric(value.amount) > 0 ? `-${value.amount}` : value.amount },
    locale,
  );
}
function formatPercent(value: string, locale: string) {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
    numeric(value),
  );
}
function formatCount(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value);
}
function formatSignedPercent(value: string, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "always",
  }).format(numeric(value));
}
