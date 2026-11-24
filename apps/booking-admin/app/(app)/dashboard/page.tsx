"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { GuestInsights } from "@/components/dashboard/GuestInsights";
import { ConversionFunnelCard } from "@/components/dashboard/ConversionFunnelCard";
import { DayBookingsWindow } from "@/components/dashboard/DayBookingsWindow";
import { DetailsWindow, type DetailsMetric } from "@/components/dashboard/DetailsWindow";
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
  type GuestInsights as GuestInsightsData,
  type DashboardStats,
  type ConversionFunnel,
  type RevenueDays,
  type Sparklines,
  type TimeRange,
} from "@/services/dashboard";

export default function DashboardPage() {
  const { t, locale } = useTranslation();
  // Shared with the header strip, which follows it on every page (VAY-2594).
  const timeRange = useDashboardRange();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [channels, setChannels] = useState<ChannelMix | null>(null);
  const [channelsError, setChannelsError] = useState(false);
  const [guests, setGuests] = useState<GuestInsightsData | null>(null);
  const [guestsError, setGuestsError] = useState(false);
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
  // The Details window's metric while it is open (VAY-2594).
  const [detailsMetric, setDetailsMetric] = useState<DetailsMetric | null>(null);
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
    setGuests(null);
    setGuestsError(false);
    const [statsData, channelsData, funnelData, sparklinesData, revenueData, guestsData] =
      await Promise.allSettled([
        dashboardService.getStats(range, timeZone),
        dashboardService.getChannelMix(range, timeZone),
        dashboardService.getConversionFunnel(range, timeZone),
        dashboardService.getSparklines(range, timeZone),
        dashboardService.getRevenueDays(range, timeZone),
        dashboardService.getGuestInsights(range, timeZone),
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
    if (guestsData.status === "fulfilled") setGuests(guestsData.value);
    else setGuestsError(true);
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
    setGuests(null);
    setGuestsError(false);
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

  // The Details window reads by the property's time zone: without one, the cards don't offer it.
  const openDetails = (metric: DetailsMetric) =>
    propertyTimeZone ? () => setDetailsMetric(metric) : undefined;

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
          onClick={openDetails("revenue")}
          ariaLabel={t("dashboard.details.open.revenue")}
        />
        <SummaryCard
          label={t("dashboard.stats.bookings")}
          value={stats ? formatNumber(stats.bookings, locale) : "--"}
          comparison={stats ? compareSummary(stats.bookings, stats.bookings_previous) : null}
          locale={locale}
          t={t}
          sparkline={sparklines?.bookings ?? []}
          onClick={openDetails("bookings")}
          ariaLabel={t("dashboard.details.open.bookings")}
        />
        <SummaryCard
          label={t("dashboard.stats.pageViews")}
          value={stats ? formatNumber(stats.page_views, locale) : "--"}
          comparison={stats ? compareSummary(stats.page_views, stats.page_views_previous) : null}
          locale={locale}
          t={t}
          sparkline={sparklines?.page_views ?? []}
          onClick={openDetails("views")}
          ariaLabel={t("dashboard.details.open.views")}
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
          onClick={openDetails("conversion")}
          ariaLabel={t("dashboard.details.open.conversion")}
        />
      </div>

      <RevenueChart
        data={revenueDays}
        loading={loading}
        error={revenueError}
        locale={locale}
        t={t}
        onOpenDay={setOpenDay}
        onDetails={openDetails("revenue")}
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

      {detailsMetric && propertyTimeZone && (
        <DetailsWindow
          metric={detailsMetric}
          onMetric={setDetailsMetric}
          range={timeRange}
          timeZone={propertyTimeZone}
          stats={stats}
          revenueDays={revenueDays}
          revenueFailed={revenueError}
          revenueComparison={revenueComparison}
          locale={locale}
          t={t}
          onClose={() => setDetailsMetric(null)}
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
          onDetails={openDetails("conversion")}
        />
      </div>

      <GuestInsights
        data={guests}
        loading={loading}
        error={guestsError}
        range={timeRange}
        locale={locale}
        t={t}
      />
    </PageLayout>
  );
}
