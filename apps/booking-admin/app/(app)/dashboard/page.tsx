"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { settingsService, type PropertySettings } from "@/services/settings";
import { ConversionFunnelCard } from "@/components/dashboard/ConversionFunnelCard";
import { SummaryCard } from "@/components/dashboard/SummaryCard";
import { compareRate, compareSummary, type SummaryChange } from "@/lib/utils/dashboardSummary";
import {
  dashboardService,
  rangeQuery,
  type DashboardStats,
  type BookingsBySource,
  type ConversionFunnel,
  type Sparklines,
  type TimeRange,
  type PageViewsTimeline,
} from "@/services/dashboard";

const SOURCE_COLORS: Record<string, string> = {
  direct: "#2F52F5",
  "booking.com": "#003580",
  airbnb: "#FF5A5F",
  expedia: "#f59e0b",
  google: "#10b981",
};

const SOURCE_LABELS: Record<string, string> = {
  direct: "Direct (vayada)",
  "booking.com": "Booking.com",
  airbnb: "Airbnb",
  expedia: "Expedia",
  google: "Google Hotels",
};

// ISO date strings come from the backend already aligned to the property
// timezone; `parseIsoDate` builds a Date at local midnight so Intl
// formatting doesn't shift the day backwards on negative-UTC clients.
function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function formatShortDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
    parseIsoDate(iso),
  );
}

function statIcon(...paths: string[]) {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} strokeLinecap="round" strokeLinejoin="round" d={d} />
      ))}
    </svg>
  );
}

export default function DashboardPage() {
  const { t, locale } = useTranslation();
  const [timeRange, setTimeRange] = useState<TimeRange>("today");
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [sources, setSources] = useState<BookingsBySource | null>(null);
  const [funnelError, setFunnelError] = useState(false);
  const [funnel, setFunnel] = useState<ConversionFunnel | null>(null);
  const [sparklines, setSparklines] = useState<Sparklines | null>(null);
  const [currency, setCurrency] = useState("EUR");
  const [propertyTimeZone, setPropertyTimeZone] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageViewsModalOpen, setPageViewsModalOpen] = useState(false);
  const fetchSequence = useRef(0);

  useEffect(() => {
    settingsService
      .getPropertySettings()
      .then((settings: PropertySettings) => {
        if (settings.default_currency) setCurrency(settings.default_currency);
        setPropertyTimeZone(settings.time_zone || null);
      })
      .catch(() => setPropertyTimeZone(null))
      .finally(() => setSettingsLoaded(true));
  }, []);

  const fetchData = useCallback(async (range: TimeRange, timeZone: string) => {
    const sequence = ++fetchSequence.current;
    setLoading(true);
    setStats(null);
    setSources(null);
    setFunnel(null);
    setFunnelError(false);
    setSparklines(null);
    const [statsData, sourcesData, funnelData, sparklinesData] = await Promise.allSettled([
      dashboardService.getStats(range, timeZone),
      dashboardService.getBookingsBySource(range, timeZone),
      dashboardService.getConversionFunnel(range, timeZone),
      dashboardService.getSparklines(range, timeZone),
    ]);
    if (sequence !== fetchSequence.current) return;
    if (statsData.status === "fulfilled") setStats(statsData.value);
    if (sourcesData.status === "fulfilled") setSources(sourcesData.value);
    if (funnelData.status === "fulfilled") setFunnel(funnelData.value);
    else setFunnelError(true);
    if (sparklinesData.status === "fulfilled") setSparklines(sparklinesData.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (!propertyTimeZone) {
      fetchSequence.current += 1;
      setStats(null);
      setSources(null);
      setFunnel(null);
      setSparklines(null);
      setLoading(false);
      return;
    }
    fetchData(timeRange, propertyTimeZone);
  }, [timeRange, propertyTimeZone, settingsLoaded, fetchData]);

  const selectTimeRange = (range: TimeRange) => {
    if (range === timeRange) return;
    fetchSequence.current += 1;
    setStats(null);
    setSources(null);
    setFunnel(null);
    setFunnelError(false);
    setSparklines(null);
    setTimeRange(range);
  };

  // Build donut chart gradient
  const donutGradient =
    sources && sources.sources.length > 0
      ? (() => {
          let cumulative = 0;
          const stops = sources.sources.map((s) => {
            const color = SOURCE_COLORS[s.source] || "#d1d5db";
            const start = cumulative;
            cumulative += s.percentage;
            return `${color} ${start}% ${cumulative}%`;
          });
          return `conic-gradient(${stops.join(", ")})`;
        })()
      : "conic-gradient(#e5e7eb 0% 100%)";

  // Tiers retuned for the smaller inner circle introduced when the dashboard
  // was tightened — long strings like "IDR 1,234,567,890" (17 chars) must
  // still fit inside the inner circle without overlapping the colored ring.
  const donutValueFontSize = (text: string): string => {
    if (text.length <= 6) return "text-xl md:text-2xl";
    if (text.length <= 9) return "text-base md:text-lg";
    if (text.length <= 12) return "text-sm md:text-base";
    if (text.length <= 14) return "text-[11px] md:text-xs";
    return "text-[9px] md:text-[10px]";
  };

  // Spell out the comparison window; Today compares with the same weekday last week.
  const vsLabel =
    timeRange === "today"
      ? t("dashboard.stats.vsSameDayLastWeek")
      : timeRange === "week"
        ? t("dashboard.stats.vsLastWeek")
        : t("dashboard.stats.vsLast30Days");

  // Named after the property-local window the funnel shows; an unusable zone falls back to a plain name.
  const funnelExportFileName = (() => {
    try {
      const { currentStart, currentEnd } = rangeQuery(timeRange, propertyTimeZone ?? "");
      return `conversion-funnel-${currentStart}-to-${currentEnd}.csv`;
    } catch {
      return "conversion-funnel.csv";
    }
  })();

  const incompleteAmounts = Boolean(
    stats && (stats.unverified_bookings > 0 || stats.unverified_bookings_previous > 0),
  );
  const money = (value: number) => formatCurrency(value, currency, locale);
  const count = ({ amount }: SummaryChange) => formatNumber(amount, locale);
  // Revenue reads as a percentage; after an empty previous period, or when the percentage
  // would round to 0, the amount is shown instead.
  const revenueChange = ({ amount, percent }: SummaryChange) =>
    percent === null || percent < 0.05
      ? money(amount)
      : `${formatNumber(percent, locale, { maximumFractionDigits: percent < 10 ? 1 : 0 })}%`;
  // Amounts display without decimals, so compare them that way: no "+€0" changes.
  const revenueComparison =
    stats && !incompleteAmounts
      ? compareSummary(Math.round(stats.revenue), Math.round(stats.revenue_previous))
      : null;
  const rateComparison =
    stats && !incompleteAmounts
      ? compareRate(
          { rate: stats.avg_nightly_rate, bookings: stats.bookings },
          { rate: stats.avg_nightly_rate_previous, bookings: stats.bookings_previous },
        )
      : null;
  // Days without bookings have no rate; leave them out of the trend instead of dipping to 0.
  const rateTrend = sparklines
    ? sparklines.avg_rate.filter((_, index) => (sparklines.bookings[index] ?? 0) > 0)
    : [];

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-3 md:space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t("dashboard.title")}</h1>
      </div>

      {/* Time Range Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-full sm:w-fit">
        {[
          { key: "today" as TimeRange, label: t("dashboard.timeRange.today") },
          { key: "week" as TimeRange, label: t("dashboard.timeRange.week") },
          { key: "month" as TimeRange, label: t("dashboard.timeRange.month") },
        ].map(({ key, label }) => (
          <button
            key={key}
            aria-pressed={timeRange === key}
            onClick={() => selectTimeRange(key)}
            className={`flex-1 sm:flex-initial px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
              timeRange === key
                ? "bg-white text-gray-900 border border-gray-200 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {incompleteAmounts && (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {t("dashboard.stats.incompleteAmounts")}
        </p>
      )}
      {/* Stats Cards */}
      <div
        className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 ${loading ? "opacity-60" : ""}`}
      >
        <SummaryCard
          icon={statIcon(
            "M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
          )}
          label={t("dashboard.stats.revenue")}
          value={stats ? money(stats.revenue) : "--"}
          comparison={revenueComparison}
          formatChange={revenueChange}
          vsLabel={vsLabel}
          t={t}
          sparkline={sparklines?.revenue ?? []}
        />
        <SummaryCard
          icon={statIcon(
            "M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5",
          )}
          label={t("dashboard.stats.bookings")}
          value={stats ? formatNumber(stats.bookings, locale) : "--"}
          comparison={stats ? compareSummary(stats.bookings, stats.bookings_previous) : null}
          formatChange={count}
          vsLabel={vsLabel}
          t={t}
          sparkline={sparklines?.bookings ?? []}
        />
        <SummaryCard
          icon={statIcon(
            "M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z",
            "M6 6h.008v.008H6V6Z",
          )}
          label={t("dashboard.stats.avgNightlyRate")}
          value={stats ? money(stats.avg_nightly_rate) : "--"}
          comparison={rateComparison}
          formatChange={({ amount }) => money(amount)}
          vsLabel={vsLabel}
          t={t}
          sparkline={rateTrend}
        />
        <SummaryCard
          icon={statIcon(
            "M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z",
            "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
          )}
          label={t("dashboard.stats.pageViews")}
          value={stats ? formatNumber(stats.page_views, locale) : "--"}
          comparison={stats ? compareSummary(stats.page_views, stats.page_views_previous) : null}
          formatChange={count}
          vsLabel={vsLabel}
          t={t}
          sparkline={sparklines?.page_views ?? []}
          onClick={() => setPageViewsModalOpen(true)}
          ariaLabel={t("dashboard.pageViewsModal.openLabel")}
        />
      </div>

      {pageViewsModalOpen && (
        <PageViewsDetailModal
          locale={locale}
          t={t}
          timeZone={propertyTimeZone}
          onClose={() => setPageViewsModalOpen(false)}
        />
      )}

      {/* Bookings by Source + Conversion Funnel */}
      <div
        className={`grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4 ${loading ? "opacity-60" : ""}`}
      >
        {/* Bookings by Source */}
        <div className="bg-white border border-gray-200 rounded-xl p-3 md:p-4">
          <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-3">
            {t("dashboard.bookingsBySource.title")}
          </h3>

          {/* Donut Chart */}
          <div className="flex justify-center mb-3">
            <div className="relative w-28 h-28 md:w-32 md:h-32">
              <div className="w-full h-full rounded-full" style={{ background: donutGradient }} />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-24 h-24 md:w-28 md:h-28 rounded-full bg-white flex flex-col items-center justify-center px-1 overflow-hidden">
                  {(() => {
                    const valueText = sources
                      ? formatCurrency(sources.total_revenue, currency, locale)
                      : "--";
                    return (
                      <span
                        className={`${donutValueFontSize(valueText)} font-bold text-gray-900 text-center whitespace-nowrap`}
                      >
                        {valueText}
                      </span>
                    );
                  })()}
                  <span className="text-[11px] text-gray-500 text-center whitespace-nowrap">
                    {t("dashboard.bookingsBySource.totalRevenue")}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="space-y-1.5">
            {sources && sources.sources.length > 0 ? (
              sources.sources.map((s) => (
                <div key={s.source} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full inline-block"
                      style={{ backgroundColor: SOURCE_COLORS[s.source] || "#d1d5db" }}
                    />
                    <span className="text-[13px] text-gray-700">
                      {s.source === "direct"
                        ? t("dashboard.bookingsBySource.direct")
                        : SOURCE_LABELS[s.source] || s.source}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[13px] font-medium text-gray-900">
                      {formatNumber(s.percentage, locale)}%
                    </span>
                    <span className="text-[13px] text-gray-500">
                      {formatCurrency(s.revenue, currency, locale)}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-[13px] text-gray-500 text-center py-4">
                {t("dashboard.bookingsBySource.noData")}
              </p>
            )}
          </div>

          {/* Info Banner */}
          {sources &&
            sources.sources.length > 0 &&
            sources.sources[0]?.source === "direct" &&
            sources.sources[0]?.percentage > 50 && (
              <div className="mt-3 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                <p className="text-[13px] text-blue-700">
                  {formatNumber(sources.sources[0].percentage, locale)}%{" "}
                  {t("dashboard.bookingsBySource.directBookingShare")}
                </p>
              </div>
            )}
        </div>

        <ConversionFunnelCard
          funnel={funnel}
          loading={loading}
          error={funnelError}
          locale={locale}
          t={t}
          exportFileName={funnelExportFileName}
          timeRange={timeRange}
          onTimeRangeChange={selectTimeRange}
        />
      </div>
    </div>
  );
}

interface PageViewsDetailModalProps {
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  timeZone: string | null;
  onClose: () => void;
}

function PageViewsDetailModal({ locale, t, timeZone, onClose }: PageViewsDetailModalProps) {
  // Self-fetching: the modal owns its own week_offset state and reloads
  // when the user navigates. Keeping this out of the parent dashboard
  // means the parent's today/week/month tabs don't accidentally reset
  // the user's drill-down position when the modal opens.
  const [weekOffset, setWeekOffset] = useState(0);
  const [data, setData] = useState<PageViewsTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setData(null);
    if (!timeZone) {
      setError(true);
      setLoading(false);
      return;
    }
    dashboardService
      .getPageViewsTimeline(weekOffset, timeZone)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [weekOffset, reloadKey, timeZone]);

  const max = data ? Math.max(...data.buckets.map((b) => b.count), 1) : 1;
  const diff = data ? data.total - data.previous_total : 0;
  const pctChange =
    data && data.previous_total > 0 ? Math.round((diff / data.previous_total) * 100) : null;

  const rangeLabel = data
    ? t("dashboard.pageViewsModal.subtitleRange", {
        start: formatShortDate(data.window_start, locale),
        end: formatShortDate(data.window_end, locale),
      })
    : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-2xl w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-lg font-semibold text-gray-900">
            {t("dashboard.pageViewsModal.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 -mr-2 -mt-1 p-2"
            aria-label={t("dashboard.pageViewsModal.close")}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex items-center justify-between mb-5">
          <button
            type="button"
            onClick={() => setWeekOffset((o) => o + 1)}
            className="p-1 -ml-1 text-gray-500 hover:text-gray-900 disabled:opacity-30"
            aria-label={t("dashboard.pageViewsModal.previousWeek")}
            disabled={loading}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </button>
          <p className="text-[13px] text-gray-500 text-center flex-1">{rangeLabel || " "}</p>
          <button
            type="button"
            onClick={() => setWeekOffset((o) => Math.max(0, o - 1))}
            className="p-1 -mr-1 text-gray-500 hover:text-gray-900 disabled:opacity-30"
            aria-label={t("dashboard.pageViewsModal.nextWeek")}
            disabled={weekOffset === 0 || loading}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        </div>

        {error ? (
          <div className="h-48 mb-5 flex flex-col items-center justify-center text-center">
            <p className="text-[13px] text-red-600">{t("dashboard.pageViewsModal.error")}</p>
            <button
              type="button"
              onClick={() => setReloadKey((key) => key + 1)}
              className="mt-3 text-[13px] font-medium text-primary-600 hover:text-primary-700"
            >
              {t("dashboard.pageViewsModal.retry")}
            </button>
          </div>
        ) : (
          <>
            <div
              className={`flex items-end gap-2 h-40 mb-2 transition-opacity ${loading ? "opacity-50" : ""}`}
              aria-busy={loading}
              aria-label={loading ? t("common.loading") : undefined}
            >
              {(data?.buckets ?? Array.from({ length: 7 }, () => ({ date: "", count: 0 }))).map(
                (b, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center justify-end h-full">
                    <span className="text-[11px] font-medium text-gray-700 mb-1">
                      {loading ? "" : formatNumber(b.count, locale)}
                    </span>
                    <div
                      className={`w-full rounded-t ${loading ? "bg-gray-200 animate-pulse" : "bg-primary-500"}`}
                      style={{
                        height: `${loading ? 20 + i * 8 : Math.max((b.count / max) * 100, 2)}%`,
                      }}
                    />
                  </div>
                ),
              )}
            </div>
            <div className="flex gap-2 mb-5">
              {(data?.buckets ?? []).map((b) => (
                <span
                  key={b.date}
                  className="flex-1 text-center text-[11px] text-gray-500 truncate"
                  title={formatShortDate(b.date, locale)}
                >
                  {formatShortDate(b.date, locale)}
                </span>
              ))}
            </div>
          </>
        )}

        <div className="border-t border-gray-100 pt-4 grid grid-cols-2 gap-4 text-[13px]">
          <div>
            <div className="text-gray-500">{t("dashboard.pageViewsModal.totalInWindow")}</div>
            <div className="text-xl font-semibold text-gray-900">
              {loading || error ? "--" : formatNumber(data?.total ?? 0, locale)}
            </div>
          </div>
          <div>
            <div className="text-gray-500">{t("dashboard.pageViewsModal.vsPrevious7Days")}</div>
            {loading || error ? (
              <div className="text-xl font-semibold text-gray-400">--</div>
            ) : data && data.has_previous_data ? (
              <div
                className={`text-xl font-semibold ${diff > 0 ? "text-green-600" : diff < 0 ? "text-red-500" : "text-gray-900"}`}
              >
                {diff > 0 ? "+" : ""}
                {formatNumber(diff, locale)}
                {pctChange !== null && (
                  <span className="text-[13px] font-normal ml-2">
                    ({diff > 0 ? "+" : ""}
                    {formatNumber(pctChange, locale)}%)
                  </span>
                )}
              </div>
            ) : (
              <div className="text-[13px] text-gray-500 mt-1">
                {t("dashboard.pageViewsModal.noPrevious")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
