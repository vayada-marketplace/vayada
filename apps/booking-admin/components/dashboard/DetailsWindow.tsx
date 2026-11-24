"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowTopRightOnSquareIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { notificationLinkHref } from "@/lib/notificationLinks";
import { openInPms } from "@/lib/openBookingInPms";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { channelRows, roundedShares, type ChannelChange } from "@/lib/utils/channelMix";
import {
  compareConversion,
  compareSummary,
  conversionRate,
  type SummaryComparison,
} from "@/lib/utils/dashboardSummary";
import { tooltipAlign } from "@/lib/utils/revenueChart";
import {
  dashboardService,
  TIME_RANGE_NAMES,
  type DashboardBooking,
  type DashboardDetails,
  type DashboardStats,
  type PageViewBucket,
  type RevenueDays,
  type TimeRange,
} from "@/services/dashboard";

export type DetailsMetric = "revenue" | "bookings" | "views" | "conversion";

const METRICS: [DetailsMetric, string][] = [
  ["revenue", "dashboard.details.tab.revenue"],
  ["bookings", "dashboard.details.tab.bookings"],
  ["views", "dashboard.details.tab.views"],
  ["conversion", "dashboard.details.tab.conversion"],
];

const LEAD_TIMES = ["0-7", "8-30", "31-90", "90+"] as const;

type Translate = (key: string, params?: Record<string, string | number>) => string;

type Props = {
  metric: DetailsMetric;
  onMetric: (metric: DetailsMetric) => void;
  range: TimeRange;
  timeZone: string;
  stats: DashboardStats | null;
  revenueDays: RevenueDays | null;
  /** The revenue days couldn't be read: their charts say so instead of loading. */
  revenueFailed: boolean;
  /** The revenue card's comparison, left out when amounts can't be compared. */
  revenueComparison: SummaryComparison | null;
  locale: string;
  t: Translate;
  onClose: () => void;
};

function localDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function shortDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(localDate(iso));
}

function stayDates(checkIn: string, checkOut: string, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
  const range = format as Intl.DateTimeFormat & {
    formatRange?: (start: Date, end: Date) => string;
  };
  const start = localDate(checkIn);
  const end = localDate(checkOut);
  return range.formatRange
    ? range.formatRange(start, end)
    : `${format.format(start)} – ${format.format(end)}`;
}

/** "↑ 18% vs previous period", green up and red down; null when there is nothing to compare. */
function headlineChange(comparison: SummaryComparison | null, t: Translate) {
  if (!comparison || comparison.kind === "noData") return null;
  const vs = t("dashboard.details.vsPrevious");
  if (comparison.kind === "unchanged") return { text: `± 0% ${vs}`, color: "text-gray-500" };
  if (comparison.percent === null)
    return { text: `↑ ${t("dashboard.stats.upFromZero")}`, color: "text-[#0F7A3D]" };
  const percent = Math.round(comparison.percent);
  return {
    text: `${comparison.up ? "↑" : "↓"} ${percent === 0 ? "<1" : percent}% ${vs}`,
    color: comparison.up ? "text-[#0F7A3D]" : "text-[#B42318]",
  };
}

function rowChange(change: ChannelChange, t: Translate) {
  if (change.kind === "new") return { text: t("dashboard.channels.new"), color: "text-[#0F7A3D]" };
  if (change.kind === "unchanged") return { text: "± 0%", color: "text-gray-500" };
  return {
    text: `${change.kind === "up" ? "↑" : "↓"} ${change.percent}%`,
    color: change.kind === "up" ? "text-[#0F7A3D]" : "text-[#B42318]",
  };
}

/** A bar: its label under the chart, its tooltip's title (the dates) and its exact value. */
type Bar = { label: string; tooltip?: string; value: number | null; text: string };

/**
 * Bars with a tooltip on hover or focus (dates and exact value). Weekly charts show the value above
 * every bar and each bar's own label below; daily charts spread five dates under the chart.
 */
function DetailsChart({ bars, weekly }: { bars: Bar[]; weekly: boolean }) {
  const [active, setActive] = useState<number | null>(null);
  const few = weekly;
  // Up to a month the bars take keyboard focus; 90 of them would be a long way to Tab through.
  const focusable = bars.length <= 31;
  const max = Math.max(0, ...bars.map((bar) => bar.value ?? 0));
  const height = few ? 120 : 140;
  const spread =
    bars.length <= 5
      ? bars.map((_, index) => index)
      : [0, 1, 2, 3, 4].map((k) => Math.round((k * (bars.length - 1)) / 4));
  return (
    <div className="flex flex-col gap-2">
      <div
        className={`flex h-[150px] items-end border-b border-gray-200 ${bars.length > 31 ? "gap-px" : "gap-[3px]"}`}
        onMouseLeave={() => setActive(null)}
      >
        {bars.map((bar, index) => {
          const value = bar.value ?? 0;
          const h = value > 0 && max > 0 ? Math.max(3, Math.round((value / max) * height)) : 2;
          const on = active === index;
          const dim = active !== null && !on;
          const align = tooltipAlign(index, bars.length);
          return (
            <div
              key={`${bar.label}-${index}`}
              tabIndex={focusable ? 0 : undefined}
              role={focusable ? "img" : undefined}
              aria-label={focusable ? `${bar.tooltip ?? bar.label}: ${bar.text}` : undefined}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              className="relative flex h-full min-w-0 flex-1 flex-col justify-end focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            >
              {on && (
                <span
                  role="tooltip"
                  className={`pointer-events-none absolute z-10 whitespace-nowrap rounded-md bg-[#111827] px-2.5 py-1.5 text-left text-white shadow-[0_4px_12px_rgba(17,24,39,0.2)] ${
                    align === "left"
                      ? "left-0"
                      : align === "right"
                        ? "right-0"
                        : "left-1/2 -translate-x-1/2"
                  }`}
                  style={{ bottom: h + (few ? 26 : 8) }}
                >
                  <span className="block text-[11px] text-[#C9CED8]">
                    {bar.tooltip ?? bar.label}
                  </span>
                  <span className="block text-[13px] font-semibold">{bar.text}</span>
                </span>
              )}
              {few && (
                <span className="mb-1 truncate whitespace-nowrap text-center text-[11px] font-semibold text-gray-700">
                  {bar.value === null ? "–" : bar.text}
                </span>
              )}
              <span
                className={`block rounded-t-[3px] transition-colors ${
                  value <= 0
                    ? "bg-[#E5E7EB]"
                    : on
                      ? "bg-[#1E3AD8]"
                      : dim
                        ? "bg-[#9AABF9]"
                        : "bg-[#2B4BF2]"
                }`}
                style={{ height: h }}
              />
            </div>
          );
        })}
      </div>
      {few ? (
        <div className="flex gap-[3px] text-[11px] text-gray-500" aria-hidden="true">
          {bars.map((bar, index) => (
            <span key={`${bar.label}-${index}`} className="min-w-0 flex-1 truncate text-center">
              {bar.label}
            </span>
          ))}
        </div>
      ) : (
        <div className="flex justify-between text-[11px] text-gray-500" aria-hidden="true">
          {spread.map((index) => (
            <span key={index}>{bars[index].label}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The Details window (VAY-2594): one metric at a time, with its value and change, a chart, a
 * breakdown and, where there is one, a list of bookings. Opens from any card, the revenue chart and
 * the funnel; the tabs switch metric without closing it.
 */
export function DetailsWindow({
  metric,
  onMetric,
  range,
  timeZone,
  stats,
  revenueDays,
  revenueFailed,
  revenueComparison,
  locale,
  t,
  onClose,
}: Props) {
  const [details, setDetails] = useState<DashboardDetails | null>(null);
  const [detailsError, setDetailsError] = useState(false);
  const [views, setViews] = useState<PageViewBucket[] | null>(null);
  const [viewsFailed, setViewsFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // The window renders at the end of <body>, so focus moves into it and goes back on close.
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      // Tab stays in the window.
      const focusable = Array.prototype.filter.call(
        dialogRef.current.querySelectorAll(
          "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
        ),
        (element: HTMLElement) => element.offsetParent !== null,
      ) as HTMLElement[];
      if (focusable.length === 0) return;
      // Focus outside the window (a click on its text moves it to the page): back to the start.
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        focusable[0].focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    dashboardService
      .getDetails(range, timeZone)
      .then((value) => !cancelled && setDetails(value))
      .catch(() => !cancelled && setDetailsError(true));
    dashboardService
      .getPageViewsForRange(range, timeZone)
      .then((value) => !cancelled && setViews(value))
      .catch(() => !cancelled && setViewsFailed(true));
    return () => {
      cancelled = true;
    };
  }, [range, timeZone]);

  const currency = stats?.currency ?? details?.currency ?? "EUR";
  const money = (value: number) => formatCurrency(value, currency, locale);
  const days = revenueDays?.days ?? [];
  const dayLabel = (iso: string) => shortDate(iso, locale);

  const bookingRow = (booking: DashboardBooking, sub: string, tag?: "confirmed" | "canceled") => {
    const reservations = notificationLinkHref(
      { path: "/reservations", param: "search" },
      booking.reference,
    );
    return (
      <li
        key={booking.id}
        className="flex items-center gap-2.5 border-b border-[#F0F2F5] py-2.5 last:border-b-0"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium text-gray-900">
            {booking.reference}
          </span>
          <span className="text-xs text-gray-500">{sub}</span>
        </div>
        {tag && (
          <span
            className={`whitespace-nowrap rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${
              tag === "canceled" ? "bg-[#FEF3F2] text-[#912018]" : "bg-[#ECF8F1] text-[#0B4F28]"
            }`}
          >
            {t(
              tag === "canceled"
                ? "dashboard.details.status.canceled"
                : "dashboard.details.status.confirmed",
            )}
          </span>
        )}
        <span className="whitespace-nowrap text-[13px] font-semibold text-gray-900">
          {formatCurrency(booking.total, booking.currency, locale)}
        </span>
        <a
          href={reservations}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("dashboard.dayWindow.openBookingLabel", { reference: booking.reference })}
          onClick={(event) => {
            if (!details?.can_open_in_pms) return;
            event.preventDefault();
            void openInPms(booking, reservations);
          }}
          className="flex h-[30px] shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-gray-200 px-2.5 text-xs font-semibold text-gray-900 hover:bg-gray-50"
        >
          {t("dashboard.dayWindow.openBooking")}
          <ArrowTopRightOnSquareIcon aria-hidden="true" className="h-3 w-3" />
        </a>
      </li>
    );
  };
  const nights = (booking: DashboardBooking) =>
    t(booking.nights === 1 ? "dashboard.dayWindow.night" : "dashboard.dayWindow.nights", {
      count: booking.nights,
    });
  const rooms = (booking: DashboardBooking) => booking.room_names.join(", ");

  // ── The selected metric ────────────────────────────────────────────────────────────────
  let title = "";
  let value = "--";
  let change: { text: string; color: string } | null = null;
  let sub = "";
  let chartTitle = "";
  let bars: Bar[] = [];
  let breakdown: {
    title: string;
    rows: { label: string; value: string; change: ChannelChange; width: number }[];
  } | null = null;
  let list: { title: string; items: ReactNode[] } | null = null;

  if (metric === "revenue") {
    title = t("dashboard.stats.revenue");
    value = stats ? money(stats.revenue) : "--";
    change = headlineChange(revenueComparison, t);
    sub = t("dashboard.details.revenueSub");
    chartTitle = t("dashboard.details.revenuePerDay");
    bars = days.map((day) => ({
      label: dayLabel(day.date),
      value: day.revenue,
      text: day.bookings > 0 ? money(day.revenue) : t("dashboard.revenueChart.noBookings"),
    }));
    if (details) {
      const rows = channelRows(
        details.room_types.map((row) => ({
          key: row.name ?? "",
          bookings: row.revenue,
          previous: row.previous,
        })),
      );
      const shares = roundedShares(rows.map((row) => row.share));
      breakdown = {
        title: t("dashboard.details.byRoomType"),
        rows: rows.map((row, index) => ({
          label: row.key || t("dashboard.details.roomTypeUnknown"),
          value: `${money(row.bookings)} · ${shares[index]}%`,
          change: row.change,
          width: row.width,
        })),
      };
      list = {
        title: t("dashboard.details.topBookings"),
        items: details.top_bookings.map((booking) =>
          bookingRow(
            booking,
            [
              stayDates(booking.check_in, booking.check_out, locale),
              nights(booking),
              rooms(booking),
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ),
      };
    }
  } else if (metric === "bookings") {
    title = t("dashboard.stats.bookings");
    value = stats ? formatNumber(stats.bookings, locale) : "--";
    change = stats
      ? headlineChange(compareSummary(stats.bookings, stats.bookings_previous), t)
      : null;
    if (details && stats) {
      const all = stats.bookings + details.canceled_bookings;
      sub =
        details.canceled_bookings === 0
          ? t("dashboard.details.noCancellations")
          : t(
              details.canceled_bookings === 1
                ? "dashboard.details.cancellation"
                : "dashboard.details.cancellations",
              {
                count: formatNumber(details.canceled_bookings, locale),
                percent: Math.round((details.canceled_bookings / all) * 100),
              },
            );
    }
    chartTitle = t("dashboard.details.bookingsPerDay");
    bars = days.map((day) => ({
      label: dayLabel(day.date),
      value: day.bookings,
      text: t(day.bookings === 1 ? "dashboard.channels.booking" : "dashboard.channels.bookings", {
        count: formatNumber(day.bookings, locale),
      }),
    }));
    if (details) {
      const byBucket = new Map(details.lead_times.map((row) => [row.bucket, row]));
      const rows = channelRows(
        LEAD_TIMES.map((bucket) => ({
          key: bucket,
          bookings: byBucket.get(bucket)?.bookings ?? 0,
          previous: byBucket.get(bucket)?.previous ?? 0,
        })),
        { keepOrder: true, keepEmpty: true },
      );
      const shares = roundedShares(rows.map((row) => row.share));
      breakdown = {
        title: t("dashboard.details.leadTime"),
        rows: rows.map((row, index) => ({
          label: t(`dashboard.details.lead.${row.key}`),
          value: `${formatNumber(row.bookings, locale)} · ${shares[index] ?? 0}%`,
          change: row.change,
          width: row.width,
        })),
      };
      list = {
        title: t("dashboard.details.recentBookings"),
        items: details.recent_bookings.map((booking) =>
          bookingRow(
            booking,
            [
              t("dashboard.details.booked", { date: dayLabel(booking.booked_on) }),
              nights(booking),
              rooms(booking),
            ]
              .filter(Boolean)
              .join(" · "),
            booking.status,
          ),
        ),
      };
    }
  } else if (metric === "views") {
    title = t("dashboard.stats.pageViews");
    value = stats ? formatNumber(stats.page_views, locale) : "--";
    change = stats
      ? headlineChange(compareSummary(stats.page_views, stats.page_views_previous), t)
      : null;
    sub = t("dashboard.details.viewsSub");
    chartTitle = t("dashboard.details.viewsPerDay");
    bars = (views ?? []).map((bucket) => ({
      label: dayLabel(bucket.date),
      value: bucket.count,
      text: formatNumber(bucket.count, locale),
    }));
  } else {
    title = t("dashboard.stats.conversionRate");
    const rate = stats
      ? conversionRate(stats.conversion_bookings, stats.conversion_page_views)
      : null;
    const percent = (share: number) =>
      `${formatNumber(share, locale, { maximumFractionDigits: share < 10 ? 2 : 1 })}%`;
    value = rate === null ? "--" : percent(rate);
    change = stats
      ? headlineChange(
          compareConversion(
            rate,
            conversionRate(
              stats.conversion_bookings_previous,
              stats.conversion_page_views_previous,
            ),
          ),
          t,
        )
      : null;
    sub =
      stats && rate !== null
        ? t("dashboard.details.conversionSub", {
            bookings: formatNumber(stats.conversion_bookings ?? 0, locale),
            views: formatNumber(stats.conversion_page_views ?? 0, locale),
          })
        : t("dashboard.details.conversionNotYet");
    chartTitle = t("dashboard.details.conversionPerWeek");
    // Weeks end on the range's last day; only days since every page view is counted.
    const countedFrom = details?.page_views_counted_from ?? null;
    const viewsByDay = new Map((views ?? []).map((bucket) => [bucket.date, bucket.count]));
    const weeks: { start: string; end: string; bookings: number; views: number }[] = [];
    for (let end = days.length - 1; end >= 0; end -= 7) {
      const start = Math.max(0, end - 6);
      const week = { start: days[start].date, end: days[end].date, bookings: 0, views: 0 };
      for (let index = start; index <= end; index += 1) {
        const day = days[index];
        if (!countedFrom || day.date < countedFrom) continue;
        week.bookings += day.booking_page_bookings;
        week.views += viewsByDay.get(day.date) ?? 0;
      }
      weeks.unshift(week);
    }
    bars = weeks.map((week, index) => {
      const weekRate = week.views > 0 ? (week.bookings / week.views) * 100 : null;
      return {
        label: t("dashboard.details.week", { number: index + 1 }),
        tooltip: `${dayLabel(week.start)} – ${dayLabel(week.end)}`,
        value: weekRate,
        text: weekRate === null ? "–" : percent(weekRate),
      };
    });
  }

  const chartFailed =
    metric === "views"
      ? viewsFailed
      : revenueFailed || (metric === "conversion" && (viewsFailed || detailsError));

  return createPortal(
    <>
      <button
        type="button"
        aria-label={t("dashboard.details.close")}
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-[rgba(17,24,39,0.32)]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("dashboard.details.label", { metric: title })}
        className="fixed left-1/2 top-1/2 z-40 flex max-h-[calc(100%-48px)] w-[calc(100%-32px)] max-w-[760px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-2xl bg-white shadow-[0_24px_64px_rgba(17,24,39,0.22)]"
      >
        <div className="flex flex-col gap-3.5 px-[22px] pt-[18px]">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {t("dashboard.details.versus", { range: t(TIME_RANGE_NAMES[range]) })}
            </span>
            <button
              ref={closeRef}
              type="button"
              aria-label={t("dashboard.details.close")}
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#F6F7F9] text-gray-700 hover:bg-gray-100"
            >
              <XMarkIcon aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
          <div
            role="tablist"
            aria-label={t("dashboard.details.metrics")}
            className="flex gap-1.5 overflow-x-auto pb-0.5"
          >
            {METRICS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={metric === key}
                onClick={() => onMetric(key)}
                className={`h-8 shrink-0 rounded-2xl border px-3 text-[13px] ${
                  metric === key
                    ? "border-[#2B4BF2] bg-[#EEF1FE] font-semibold text-[#1E3AD8]"
                    : "border-gray-200 bg-white font-medium text-gray-700 hover:bg-gray-50"
                }`}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-[22px] px-[22px] pb-7 pt-[18px]">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold text-gray-500">{title}</h2>
            <span className="text-[30px] font-bold tracking-[-0.02em] text-gray-900">{value}</span>
            {change && (
              <span className={`text-[13px] font-medium ${change.color}`}>{change.text}</span>
            )}
            {sub && <span className="text-xs text-gray-500">{sub}</span>}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-[13px] font-semibold text-gray-900">{chartTitle}</h3>
            {chartFailed ? (
              <p className="py-6 text-center text-sm text-gray-500">
                {t("dashboard.details.error")}
              </p>
            ) : bars.length > 0 ? (
              <DetailsChart bars={bars} weekly={metric === "conversion"} />
            ) : (
              <p className="py-6 text-center text-sm text-gray-500">{t("common.loading")}</p>
            )}
          </div>

          {detailsError && metric !== "views" && !chartFailed && (
            <p className="text-sm text-gray-500">{t("dashboard.details.error")}</p>
          )}

          {breakdown && breakdown.rows.length > 0 && (
            <div className="flex flex-col gap-2.5">
              <h3 className="text-[13px] font-semibold text-gray-900">{breakdown.title}</h3>
              {breakdown.rows.map((row) => {
                const delta = rowChange(row.change, t);
                return (
                  <div key={row.label} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2.5 text-[13px]">
                      <span className="min-w-0 flex-1 truncate text-gray-900">{row.label}</span>
                      <span className="whitespace-nowrap font-semibold text-gray-900">
                        {row.value}
                      </span>
                      <span
                        className={`min-w-[52px] whitespace-nowrap text-right text-xs font-semibold ${delta.color}`}
                      >
                        {delta.text}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-[3px] bg-[#F0F2F5]">
                      <div
                        className="h-full rounded-[3px] bg-[#2B4BF2]"
                        style={{ width: `${row.width}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {list && (
            <div className="flex flex-col gap-1">
              <h3 className="mb-1.5 text-[13px] font-semibold text-gray-900">{list.title}</h3>
              {details?.bookings_hidden ? (
                <p className="text-sm text-gray-500">{t("dashboard.dayWindow.hidden")}</p>
              ) : list.items.length === 0 ? (
                <p className="text-sm text-gray-500">{t("dashboard.channels.empty")}</p>
              ) : (
                <ul className="flex flex-col">{list.items}</ul>
              )}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
