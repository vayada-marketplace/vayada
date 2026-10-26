import { formatCurrency, formatNumber } from "@/lib/utils";

export interface TodayStats {
  revenue: number;
  bookings: number;
  pageViews: number;
  currency: string;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Revenue, bookings, page views: the order the strip drops them from the end. */
export function todayStatsMetrics(stats: TodayStats, t: Translate, locale: string): string[] {
  // Large amounts read "IDR 1.2M" rather than "IDR 1,200,000".
  const amount = formatCurrency(
    stats.revenue,
    stats.currency,
    locale,
    stats.revenue >= 10_000 ? { notation: "compact", maximumFractionDigits: 1 } : {},
  );
  return [
    t("layout.header.todayRevenue", { amount }),
    t(stats.bookings === 1 ? "layout.header.todayBooking" : "layout.header.todayBookings", {
      count: formatNumber(stats.bookings, locale),
    }),
    t(stats.pageViews === 1 ? "layout.header.todayPageView" : "layout.header.todayPageViews", {
      count: formatNumber(stats.pageViews, locale),
    }),
  ];
}
