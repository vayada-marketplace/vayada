import { apiClient, isNextApiTarget } from "../api/client";
import { getScopedBookingHotelIds, isAuthKitLoginEnabled } from "../auth/sessionStore";

export interface DashboardStats {
  revenue: number;
  revenue_previous: number;
  bookings: number;
  bookings_previous: number;
  avg_nightly_rate: number;
  avg_nightly_rate_previous: number;
  page_views: number;
  page_views_previous: number;
  next_arrival: string | null;
  live_since: string | null;
}

export interface SourceBreakdown {
  source: string;
  revenue: number;
  percentage: number;
  count: number;
}

export interface BookingsBySource {
  total_revenue: number;
  sources: SourceBreakdown[];
}

export interface FunnelStep {
  label: string;
  value: number;
  percentage: number;
}

export interface ConversionFunnel {
  steps: FunnelStep[];
}

export interface Sparklines {
  revenue: number[];
  bookings: number[];
  avg_rate: number[];
  page_views: number[];
}

export interface PageViewBucket {
  date: string;
  count: number;
}

export interface PageViewsTimeline {
  window_start: string;
  window_end: string;
  previous_window_start: string;
  previous_window_end: string;
  buckets: PageViewBucket[];
  previous_buckets: PageViewBucket[];
  total: number;
  previous_total: number;
  has_previous_data: boolean;
}

export type TimeRange = "today" | "week" | "month";

type Money = {
  amountDecimal: string;
  currency: string;
};

type TargetDashboardStatsResponse = {
  metrics: {
    current: {
      totalRevenue: Money;
      bookingCount: number;
      avgNightlyRate: Money;
    };
    previous: {
      totalRevenue: Money;
      bookingCount: number;
      avgNightlyRate: Money;
    };
    nextArrivalDate: string | null;
    liveSinceDate: string | null;
  };
};

type TargetSourceMixResponse = {
  sourceMix: {
    totalRevenue: Money;
    items: {
      source: string;
      revenue: Money;
      bookingCount: number;
      revenueSharePercent: number;
    }[];
  };
};

type TargetSparklinesResponse = {
  sparklines: {
    points: {
      revenue: Money;
      bookingCount: number;
      avgNightlyRate: Money;
    }[];
  };
};

function currentHotelId(): string | null {
  const selectedHotelId =
    typeof window !== "undefined" ? window.localStorage.getItem("selectedHotelId") : null;
  if (!isAuthKitLoginEnabled() || !isNextApiTarget()) return selectedHotelId;

  const scopedHotelIds = getScopedBookingHotelIds();
  if (selectedHotelId && scopedHotelIds.includes(selectedHotelId)) return selectedHotelId;

  const fallbackHotelId = scopedHotelIds[0] ?? null;
  if (typeof window !== "undefined") {
    if (fallbackHotelId) {
      window.localStorage.setItem("selectedHotelId", fallbackHotelId);
    } else {
      window.localStorage.removeItem("selectedHotelId");
    }
  }
  return fallbackHotelId;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rangeQuery(range: TimeRange): {
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
} {
  const end = new Date();
  const days = range === "today" ? 1 : range === "week" ? 7 : 30;
  const currentStart = addDays(end, -(days - 1));
  const previousEnd = addDays(currentStart, -1);
  const previousStart = addDays(previousEnd, -(days - 1));
  return {
    currentStart: isoDate(currentStart),
    currentEnd: isoDate(end),
    previousStart: isoDate(previousStart),
    previousEnd: isoDate(previousEnd),
  };
}

function amount(value: Money): number {
  return Number(value.amountDecimal) || 0;
}

function emptyStats(): DashboardStats {
  return {
    revenue: 0,
    revenue_previous: 0,
    bookings: 0,
    bookings_previous: 0,
    avg_nightly_rate: 0,
    avg_nightly_rate_previous: 0,
    page_views: 0,
    page_views_previous: 0,
    next_arrival: null,
    live_since: null,
  };
}

function dashboardBasePath(): string | null {
  const hotelId = currentHotelId();
  return hotelId ? `/api/booking/properties/${encodeURIComponent(hotelId)}/dashboard` : null;
}

export const dashboardService = {
  getStats: async (range: TimeRange = "today"): Promise<DashboardStats> => {
    if (!isNextApiTarget()) {
      return apiClient.get<DashboardStats>(`/admin/dashboard/stats?range=${range}`);
    }
    const basePath = dashboardBasePath();
    if (!basePath) return emptyStats();
    const query = rangeQuery(range);
    const response = await apiClient.get<TargetDashboardStatsResponse>(
      `${basePath}/stats?periodStart=${query.currentStart}&periodEnd=${query.currentEnd}&previousPeriodStart=${query.previousStart}&previousPeriodEnd=${query.previousEnd}`,
    );
    return {
      revenue: amount(response.metrics.current.totalRevenue),
      revenue_previous: amount(response.metrics.previous.totalRevenue),
      bookings: response.metrics.current.bookingCount,
      bookings_previous: response.metrics.previous.bookingCount,
      avg_nightly_rate: amount(response.metrics.current.avgNightlyRate),
      avg_nightly_rate_previous: amount(response.metrics.previous.avgNightlyRate),
      page_views: 0,
      page_views_previous: 0,
      next_arrival: response.metrics.nextArrivalDate,
      live_since: response.metrics.liveSinceDate,
    };
  },

  getBookingsBySource: async (range: TimeRange = "month"): Promise<BookingsBySource> => {
    if (!isNextApiTarget()) {
      return apiClient.get<BookingsBySource>(`/admin/dashboard/bookings-by-source?range=${range}`);
    }
    const basePath = dashboardBasePath();
    if (!basePath) return { total_revenue: 0, sources: [] };
    const query = rangeQuery(range);
    const response = await apiClient.get<TargetSourceMixResponse>(
      `${basePath}/bookings-by-source?periodStart=${query.currentStart}&periodEnd=${query.currentEnd}`,
    );
    return {
      total_revenue: amount(response.sourceMix.totalRevenue),
      sources: response.sourceMix.items.map((item) => ({
        source: item.source,
        revenue: amount(item.revenue),
        percentage: item.revenueSharePercent,
        count: item.bookingCount,
      })),
    };
  },

  getConversionFunnel: async (range: TimeRange = "month"): Promise<ConversionFunnel> => {
    if (!isNextApiTarget()) {
      return apiClient.get<ConversionFunnel>(`/admin/dashboard/conversion-funnel?range=${range}`);
    }
    void range;
    return { steps: [] };
  },

  getSparklines: async (range: TimeRange = "today"): Promise<Sparklines> => {
    if (!isNextApiTarget()) {
      return apiClient.get<Sparklines>(`/admin/dashboard/sparklines?range=${range}`);
    }
    const basePath = dashboardBasePath();
    if (!basePath) return { revenue: [], bookings: [], avg_rate: [], page_views: [] };
    const query = rangeQuery(range);
    const response = await apiClient.get<TargetSparklinesResponse>(
      `${basePath}/sparklines?windowStart=${query.currentStart}&windowEnd=${query.currentEnd}`,
    );
    return {
      revenue: response.sparklines.points.map((point) => amount(point.revenue)),
      bookings: response.sparklines.points.map((point) => point.bookingCount),
      avg_rate: response.sparklines.points.map((point) => amount(point.avgNightlyRate)),
      page_views: response.sparklines.points.map(() => 0),
    };
  },

  getPageViewsTimeline: async (weekOffset = 0): Promise<PageViewsTimeline> => {
    if (!isNextApiTarget()) {
      return apiClient.get<PageViewsTimeline>(
        `/admin/dashboard/page-views?week_offset=${weekOffset}`,
      );
    }
    const windowEnd = addDays(new Date(), weekOffset * 7);
    const windowStart = addDays(windowEnd, -6);
    const previousWindowEnd = addDays(windowStart, -1);
    const previousWindowStart = addDays(previousWindowEnd, -6);
    return {
      window_start: isoDate(windowStart),
      window_end: isoDate(windowEnd),
      previous_window_start: isoDate(previousWindowStart),
      previous_window_end: isoDate(previousWindowEnd),
      buckets: [],
      previous_buckets: [],
      total: 0,
      previous_total: 0,
      has_previous_data: false,
    };
  },
};
