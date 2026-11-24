"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "@/lib/i18n";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { settingsService, type PropertySettings } from "@/services/settings";
import { BookingPageStatusCard } from "@/components/dashboard/BookingPageStatusCard";
import { ResumeSetupBanner } from "@/components/dashboard/ResumeSetupBanner";
import {
  DashboardSetupChecklistCard,
  useDashboardSetupChecklist,
} from "@/components/dashboard/DashboardSetupChecklist";
import { ChannelsCard } from "@/components/dashboard/ChannelsCard";
import { ConversionFunnelCard } from "@/components/dashboard/ConversionFunnelCard";
import { DayBookingsWindow } from "@/components/dashboard/DayBookingsWindow";
import { RevenueChart } from "@/components/dashboard/RevenueChart";
import { SummaryCard } from "@/components/dashboard/SummaryCard";
import { PageHeader, PageLayout } from "@/components/layout/PageLayout";
import { compareConversion, compareSummary, conversionRate } from "@/lib/utils/dashboardSummary";
import { setDashboardRange, useDashboardRange } from "@/lib/dashboardRange";
import {
  dashboardService,
  rangeQuery,
  TIME_RANGES,
  type ChannelMix,
  type DashboardStats,
  type ConversionFunnel,
  type RevenueDays,
  type Sparklines,
  type TimeRange,
  type PageViewsTimeline,
} from "@/services/dashboard";

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

export default function DashboardPage() {
  const { t, locale } = useTranslation();
  // Shared with the header strip, which follows it on every page (VAY-2594).
  const timeRange = useDashboardRange();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [channels, setChannels] = useState<ChannelMix | null>(null);
  const [channelsError, setChannelsError] = useState(false);
  const [funnelError, setFunnelError] = useState(false);
  const [funnel, setFunnel] = useState<ConversionFunnel | null>(null);
  const [sparklines, setSparklines] = useState<Sparklines | null>(null);
  const [revenueDays, setRevenueDays] = useState<RevenueDays | null>(null);
  const [revenueError, setRevenueError] = useState(false);
  // The revenue chart's day whose bookings are open (VAY-2594).
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [propertyTimeZone, setPropertyTimeZone] = useState<string | null>(null);
  const [hotelName, setHotelName] = useState("");
  // VAY-2247 wave 2: the setup checklist, where the server offers it.
  const setupChecklist = useDashboardSetupChecklist();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageViewsModalOpen, setPageViewsModalOpen] = useState(false);
  const fetchSequence = useRef(0);

  useEffect(() => {
    settingsService
      .getPropertySettings()
      .then((settings: PropertySettings) => {
        setPropertyTimeZone(settings.time_zone || null);
        setHotelName(settings.property_name || "");
      })
      .catch(() => setPropertyTimeZone(null))
      .finally(() => setSettingsLoaded(true));
  }, []);

  const fetchData = useCallback(async (range: TimeRange, timeZone: string) => {
    const sequence = ++fetchSequence.current;
    setLoading(true);
    setStats(null);
    setChannels(null);
    setFunnel(null);
    setFunnelError(false);
    setSparklines(null);
    setRevenueDays(null);
    setRevenueError(false);
    setChannelsError(false);
    const [statsData, channelsData, funnelData, sparklinesData, revenueData] =
      await Promise.allSettled([
        dashboardService.getStats(range, timeZone),
        dashboardService.getChannelMix(range, timeZone),
        dashboardService.getConversionFunnel(range, timeZone),
        dashboardService.getSparklines(range, timeZone),
        dashboardService.getRevenueDays(range, timeZone),
      ]);
    if (sequence !== fetchSequence.current) return;
    if (statsData.status === "fulfilled") setStats(statsData.value);
    if (channelsData.status === "fulfilled") setChannels(channelsData.value);
    else setChannelsError(true);
    if (funnelData.status === "fulfilled") setFunnel(funnelData.value);
    else setFunnelError(true);
    if (sparklinesData.status === "fulfilled") setSparklines(sparklinesData.value);
    if (revenueData.status === "fulfilled") setRevenueDays(revenueData.value);
    else setRevenueError(true);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (!propertyTimeZone) {
      fetchSequence.current += 1;
      setStats(null);
      setChannels(null);
      setFunnel(null);
      setSparklines(null);
      setRevenueDays(null);
      setLoading(false);
      return;
    }
    fetchData(timeRange, propertyTimeZone);
  }, [timeRange, propertyTimeZone, settingsLoaded, fetchData]);

  const selectTimeRange = (range: TimeRange) => {
    if (range === timeRange) return;
    fetchSequence.current += 1;
    setStats(null);
    setChannels(null);
    setFunnel(null);
    setFunnelError(false);
    setChannelsError(false);
    setSparklines(null);
    setRevenueDays(null);
    setOpenDay(null);
    setDashboardRange(range);
  };

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
  // Amounts are in the property's currency, the one guests pay in (VAY-2390), not Localization's.
  const currency = stats?.currency ?? "EUR";
  const otherCurrencyAmounts = Boolean(stats && stats.other_currency_bookings > 0);
  const money = (value: number) => formatCurrency(value, currency, locale);
  // Amounts display without decimals, so compare them that way: no "+€0" changes.
  const revenueComparison =
    stats && !incompleteAmounts
      ? compareSummary(Math.round(stats.revenue), Math.round(stats.revenue_previous))
      : null;
  // Booking page bookings ÷ page views, now and in the period before (VAY-2594).
  const conversion = stats
    ? conversionRate(stats.conversion_bookings, stats.conversion_page_views)
    : null;
  const conversionComparison = stats
    ? compareConversion(
        conversion,
        conversionRate(stats.conversion_bookings_previous, stats.conversion_page_views_previous),
      )
    : null;

  return (
    <PageLayout className="space-y-3 md:space-y-4">
      <PageHeader
        title={t("dashboard.title")}
        actions={
          <div
            role="group"
            aria-label={t("dashboard.timeRange.label")}
            className="flex gap-0.5 rounded-[10px] bg-[#ECEEF2] p-[3px]"
          >
            {TIME_RANGES.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={timeRange === key}
                onClick={() => selectTimeRange(key)}
                className={`rounded-[7px] px-3 py-1.5 text-[13px] transition-colors ${
                  timeRange === key
                    ? "bg-white font-semibold text-gray-900 shadow-[0_1px_2px_rgba(17,24,39,0.08)]"
                    : "font-medium text-gray-600 hover:text-gray-900"
                }`}
              >
                {t(label)}
              </button>
            ))}
          </div>
        }
      />

      {/* Only when the checklist can't say what's left; not while it loads, so it doesn't flash. */}
      <ResumeSetupBanner hidden={setupChecklist.state.kind !== "unavailable"} />

      {/* Shows only when the booking page needs attention; the header's pill says Live (VAY-2594). */}
      <BookingPageStatusCard />

      <DashboardSetupChecklistCard setup={setupChecklist} hotelName={hotelName} />

      {incompleteAmounts && (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {t("dashboard.stats.incompleteAmounts")}
        </p>
      )}
      {otherCurrencyAmounts && (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {t("dashboard.stats.otherCurrencies", { currency })}
        </p>
      )}
      {/* Revenue, bookings, page views and conversion, each against the period before (VAY-2594) */}
      <div
        className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-3.5 ${loading ? "opacity-60" : ""}`}
      >
        <SummaryCard
          label={t("dashboard.stats.revenue")}
          value={stats ? money(stats.revenue) : "--"}
          comparison={revenueComparison}
          locale={locale}
          t={t}
          sparkline={sparklines?.revenue ?? []}
        />
        <SummaryCard
          label={t("dashboard.stats.bookings")}
          value={stats ? formatNumber(stats.bookings, locale) : "--"}
          comparison={stats ? compareSummary(stats.bookings, stats.bookings_previous) : null}
          locale={locale}
          t={t}
          sparkline={sparklines?.bookings ?? []}
        />
        <SummaryCard
          label={t("dashboard.stats.pageViews")}
          value={stats ? formatNumber(stats.page_views, locale) : "--"}
          comparison={stats ? compareSummary(stats.page_views, stats.page_views_previous) : null}
          locale={locale}
          t={t}
          sparkline={sparklines?.page_views ?? []}
          onClick={() => setPageViewsModalOpen(true)}
          ariaLabel={t("dashboard.pageViewsModal.openLabel")}
        />
        <SummaryCard
          label={t("dashboard.stats.conversionRate")}
          value={
            conversion !== null
              ? `${formatNumber(conversion, locale, { maximumFractionDigits: conversion < 10 ? 2 : 1 })}%`
              : "--"
          }
          comparison={conversionComparison}
          locale={locale}
          t={t}
          sparkline={[]}
        />
      </div>

      <RevenueChart
        data={revenueDays}
        loading={loading}
        error={revenueError}
        locale={locale}
        t={t}
        onOpenDay={setOpenDay}
      />
      {openDay && revenueDays && (
        <DayBookingsWindow
          date={openDay}
          days={revenueDays.days}
          locale={locale}
          t={t}
          onNavigate={setOpenDay}
          onClose={() => setOpenDay(null)}
        />
      )}

      {pageViewsModalOpen && (
        <PageViewsDetailModal
          locale={locale}
          t={t}
          timeZone={propertyTimeZone}
          onClose={() => setPageViewsModalOpen(false)}
        />
      )}

      {/* Bookings by channel + Conversion Funnel */}
      <div className="grid grid-cols-1 gap-3 md:gap-4 lg:grid-cols-2">
        <ChannelsCard
          data={channels}
          loading={loading}
          error={channelsError}
          locale={locale}
          t={t}
        />

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
    </PageLayout>
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
  // means the parent's date range doesn't accidentally reset
  // the user's drill-down position when the modal opens.
  const [weekOffset, setWeekOffset] = useState(0);
  const [data, setData] = useState<PageViewsTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  // The window renders at the end of <body>, so focus moves into it and goes back on close.
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

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

  // On <body>, not inside the page's space-y stack: its margin-top would push the backdrop down
  // and leave a white strip above the header (VAY-2590).
  return createPortal(
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
            ref={closeRef}
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
    </div>,
    document.body,
  );
}
