import { getSelectedBookingHotelId } from "../api/bookingHotelScope";
import { apiClient } from "../api/client";

export interface DashboardStats {
  /** The property's currency, which revenue and rates are in (VAY-2390). */
  currency: string;
  revenue: number;
  revenue_previous: number;
  unverified_bookings: number;
  unverified_bookings_previous: number;
  /** Bookings in another currency than the property's: counted, but not in revenue or rates. */
  other_currency_bookings: number;
  other_currency_bookings_previous: number;
  /** Direct bookings made in the range (booking page and the hotel's own), by booking date. */
  bookings: number;
  bookings_previous: number;
  /**
   * The conversion rate's sides (VAY-2594): booking page bookings and page views, both only since
   * the page counts every view. Null when the API doesn't send them.
   */
  conversion_bookings: number | null;
  conversion_bookings_previous: number | null;
  conversion_page_views: number | null;
  conversion_page_views_previous: number | null;
  page_views: number;
  page_views_previous: number;
  next_arrival: string | null;
  live_since: string | null;
}

/** One channel or direct source: bookings made in the range and in the period before. */
export interface ChannelCount {
  key: string;
  bookings: number;
  previous: number;
}

/** Bookings by channel (VAY-2594): every channel, and the direct ones by source. */
export interface ChannelMix {
  channels: ChannelCount[];
  sources: ChannelCount[];
}

export interface ConversionFunnel {
  steps: {
    stage: string;
    count: number;
    percentOfVisits: number | null;
    conversionPercent: number | null;
    previousCount: number;
  }[];
  paymentMethods: { method: string; count: number }[];
  biggestDrop: string | null;
}

export interface Sparklines {
  revenue: number[];
  bookings: number[];
  page_views: number[];
}

export interface PageViewBucket {
  date: string;
  count: number;
}

export interface PageViewsTimeline {
  time_zone: string;
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

/** One bar of the revenue chart: direct bookings made that day (VAY-2594). */
export interface RevenueDay {
  date: string;
  revenue: number;
  bookings: number;
}

export interface RevenueDays {
  currency: string;
  days: RevenueDay[];
}

export interface DayBooking {
  /** The booking's id, which PMS opens it by. */
  id: string;
  reference: string;
  check_in: string;
  check_out: string;
  nights: number;
  room_names: string[];
  /** The booking's total in its own currency. */
  total: number;
  currency: string;
  /** False for a booking in another currency, which the day's revenue leaves out. */
  counted_in_revenue: boolean;
}

/** The day window: the direct bookings made on one day (VAY-2594). */
export interface DayBookings {
  date: string;
  currency: string;
  revenue: number;
  bookings: number;
  room_nights: number;
  list: DayBooking[];
  /** The day's bookings are for people who may read reservations; others see the totals. */
  bookings_hidden: boolean;
  /** Open booking goes to PMS; otherwise to Reservations here. */
  can_open_in_pms: boolean;
}

/** Today, the last 7, 30 or 90 days, each ending today in the property's time zone. */
export type TimeRange = "today" | "week" | "month" | "quarter";

/** The Dashboard opens on the last 30 days (VAY-2594). */
export const DEFAULT_TIME_RANGE: TimeRange = "month";

/** Ranges in display order with their label keys; the page tabs and the funnel menu share them. */
export const TIME_RANGES: [TimeRange, string][] = [
  ["today", "dashboard.timeRange.today"],
  ["week", "dashboard.timeRange.week"],
  ["month", "dashboard.timeRange.month"],
  ["quarter", "dashboard.timeRange.quarter"],
];

/** The range spelled out, as the header strip names it ("Last 30 days"). */
export const TIME_RANGE_NAMES: Record<TimeRange, string> = {
  today: "dashboard.rangeLabel.today",
  week: "dashboard.rangeLabel.week",
  month: "dashboard.rangeLabel.month",
  quarter: "dashboard.rangeLabel.quarter",
};

const RANGE_DAYS: Record<TimeRange, number> = { today: 1, week: 7, month: 30, quarter: 90 };

type Money = {
  amountDecimal: string;
  currency: string;
};

type TargetDashboardStatsResponse = {
  metrics: {
    current: {
      totalRevenue: Money;
      bookingCount: number;
      conversionBookingCount?: number;
      conversionPageViewCount?: number;
      unverifiedBookingCount?: number;
      otherCurrencyBookingCount?: number;
      avgNightlyRate: Money;
      pageViewCount: number;
    };
    previous: {
      totalRevenue: Money;
      bookingCount: number;
      conversionBookingCount?: number;
      conversionPageViewCount?: number;
      unverifiedBookingCount?: number;
      otherCurrencyBookingCount?: number;
      avgNightlyRate: Money;
      pageViewCount: number;
    };
    nextArrivalDate: string | null;
    liveSinceDate: string | null;
  };
};

type TargetChannelMixResponse = {
  channelMix: {
    channels: { key: string; bookingCount: number; previousBookingCount: number }[];
    directSources: { key: string; bookingCount: number; previousBookingCount: number }[];
  };
};

type TargetSparklinesResponse = {
  sparklines: {
    points: {
      revenue: Money;
      bookingCount: number;
      unverifiedBookingCount?: number;
      avgNightlyRate: Money;
      pageViewCount: number;
    }[];
  };
};

type TargetRevenueDaysResponse = {
  revenueDays: {
    days: { date: string; revenue: Money; bookingCount: number }[];
  };
};

type TargetDayBookingsResponse = {
  dayBookings: {
    date: string;
    revenue: Money;
    bookingCount: number;
    roomNights: number;
    bookings: {
      id: string;
      reference: string;
      checkIn: string;
      checkOut: string;
      nights: number;
      roomNames: string[];
      total: Money;
      countedInRevenue: boolean;
    }[];
  };
  bookingsHidden?: boolean;
  canOpenInPms: boolean;
};

type TargetPageViewsResponse = {
  pageViews: {
    timeZone: string;
    windowStart: string;
    windowEnd: string;
    previousWindowStart: string;
    previousWindowEnd: string;
    buckets: { date: string; count: number }[];
    previousBuckets: { date: string; count: number }[];
    total: number;
    previousTotal: number;
  };
};

function currentHotelId(): string | null {
  return getSelectedBookingHotelId();
}

function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = values.year;
  const month = values.month;
  const day = values.day;
  if (!year || !month || !day) throw new Error("Property timezone date is unavailable.");
  return `${year}-${month}-${day}`;
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function rangeQuery(
  range: TimeRange,
  timeZone: string,
): {
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
} {
  const currentEnd = dateInTimeZone(new Date(), timeZone);
  const days = RANGE_DAYS[range];
  const currentStart = shiftIsoDate(currentEnd, -(days - 1));
  // Compared with the period of the same length right before it; Today with yesterday (VAY-2594).
  const previousEnd = shiftIsoDate(currentStart, -1);
  const previousStart = shiftIsoDate(previousEnd, -(days - 1));
  return {
    currentStart,
    currentEnd,
    previousStart,
    previousEnd,
  };
}

function amount(value: Money): number {
  return Number(value.amountDecimal) || 0;
}

function dashboardBasePath(): string | null {
  const hotelId = currentHotelId();
  return hotelId ? `/api/booking/properties/${encodeURIComponent(hotelId)}/dashboard` : null;
}

function requireDashboardBasePath(): string {
  const basePath = dashboardBasePath();
  if (!basePath) throw new Error("Booking hotel scope is unavailable.");
  return basePath;
}

export const dashboardService = {
  getStats: async (range: TimeRange, timeZone: string): Promise<DashboardStats> => {
    const basePath = requireDashboardBasePath();
    const query = rangeQuery(range, timeZone);
    const response = await apiClient.get<TargetDashboardStatsResponse>(
      `${basePath}/stats?periodStart=${query.currentStart}&periodEnd=${query.currentEnd}&previousPeriodStart=${query.previousStart}&previousPeriodEnd=${query.previousEnd}`,
    );
    return {
      currency: response.metrics.current.totalRevenue.currency,
      revenue: amount(response.metrics.current.totalRevenue),
      revenue_previous: amount(response.metrics.previous.totalRevenue),
      unverified_bookings: response.metrics.current.unverifiedBookingCount ?? 0,
      unverified_bookings_previous: response.metrics.previous.unverifiedBookingCount ?? 0,
      other_currency_bookings: response.metrics.current.otherCurrencyBookingCount ?? 0,
      other_currency_bookings_previous: response.metrics.previous.otherCurrencyBookingCount ?? 0,
      bookings: response.metrics.current.bookingCount,
      bookings_previous: response.metrics.previous.bookingCount,
      conversion_bookings: response.metrics.current.conversionBookingCount ?? null,
      conversion_bookings_previous: response.metrics.previous.conversionBookingCount ?? null,
      conversion_page_views: response.metrics.current.conversionPageViewCount ?? null,
      conversion_page_views_previous: response.metrics.previous.conversionPageViewCount ?? null,
      page_views: response.metrics.current.pageViewCount,
      page_views_previous: response.metrics.previous.pageViewCount,
      next_arrival: response.metrics.nextArrivalDate,
      live_since: response.metrics.liveSinceDate,
    };
  },

  getChannelMix: async (range: TimeRange, timeZone: string): Promise<ChannelMix> => {
    const basePath = requireDashboardBasePath();
    const query = rangeQuery(range, timeZone);
    const response = await apiClient.get<TargetChannelMixResponse>(
      `${basePath}/channels?periodStart=${query.currentStart}&periodEnd=${query.currentEnd}&previousPeriodStart=${query.previousStart}&previousPeriodEnd=${query.previousEnd}`,
    );
    const counts = (rows: TargetChannelMixResponse["channelMix"]["channels"]) =>
      rows.map((row) => ({
        key: row.key,
        bookings: row.bookingCount,
        previous: row.previousBookingCount,
      }));
    return {
      channels: counts(response.channelMix.channels),
      sources: counts(response.channelMix.directSources),
    };
  },

  getConversionFunnel: async (range: TimeRange, timeZone: string): Promise<ConversionFunnel> => {
    const basePath = requireDashboardBasePath();
    const query = rangeQuery(range, timeZone);
    const response = await apiClient.get<{ funnel: ConversionFunnel }>(
      `${basePath}/conversion-funnel?windowStart=${query.currentStart}&windowEnd=${query.currentEnd}`,
    );
    return response.funnel;
  },

  getSparklines: async (range: TimeRange, timeZone: string): Promise<Sparklines> => {
    const basePath = requireDashboardBasePath();
    // Points are days, so a single day has no trend: Today's sparkline shows the 7 days ending
    // today as context.
    const query = rangeQuery(range === "today" ? "week" : range, timeZone);
    const response = await apiClient.get<TargetSparklinesResponse>(
      `${basePath}/sparklines?windowStart=${query.currentStart}&windowEnd=${query.currentEnd}`,
    );
    return {
      revenue: response.sparklines.points.map((point) => amount(point.revenue)),
      bookings: response.sparklines.points.map((point) => point.bookingCount),
      page_views: response.sparklines.points.map((point) => point.pageViewCount),
    };
  },

  /** One entry per day of the range, for the revenue chart. */
  getRevenueDays: async (range: TimeRange, timeZone: string): Promise<RevenueDays> => {
    const basePath = requireDashboardBasePath();
    const query = rangeQuery(range, timeZone);
    const response = await apiClient.get<TargetRevenueDaysResponse>(
      `${basePath}/revenue-days?windowStart=${query.currentStart}&windowEnd=${query.currentEnd}`,
    );
    return {
      currency: response.revenueDays.days[0]?.revenue.currency ?? "EUR",
      days: response.revenueDays.days.map((day) => ({
        date: day.date,
        revenue: amount(day.revenue),
        bookings: day.bookingCount,
      })),
    };
  },

  getDayBookings: async (date: string): Promise<DayBookings> => {
    const basePath = requireDashboardBasePath();
    const response = await apiClient.get<TargetDayBookingsResponse>(
      `${basePath}/day-bookings?date=${encodeURIComponent(date)}`,
    );
    const day = response.dayBookings;
    return {
      date: day.date,
      currency: day.revenue.currency,
      revenue: amount(day.revenue),
      bookings: day.bookingCount,
      room_nights: day.roomNights,
      list: day.bookings.map((booking) => ({
        id: booking.id,
        reference: booking.reference,
        check_in: booking.checkIn,
        check_out: booking.checkOut,
        nights: booking.nights,
        room_names: booking.roomNames,
        total: amount(booking.total),
        currency: booking.total.currency,
        counted_in_revenue: booking.countedInRevenue,
      })),
      bookings_hidden: response.bookingsHidden === true,
      can_open_in_pms: response.canOpenInPms === true,
    };
  },

  getPageViewsTimeline: async (
    weekOffset: number,
    timeZone: string,
  ): Promise<PageViewsTimeline> => {
    const basePath = requireDashboardBasePath();
    const propertyToday = dateInTimeZone(new Date(), timeZone);
    const windowEnd = shiftIsoDate(propertyToday, -7 * Math.max(weekOffset, 0));
    const windowStart = shiftIsoDate(windowEnd, -6);
    const response = await apiClient.get<TargetPageViewsResponse>(
      `${basePath}/page-views?windowStart=${windowStart}&windowEnd=${windowEnd}`,
    );
    if (response.pageViews.timeZone !== timeZone) {
      throw new Error("Property timezone changed while loading page views.");
    }
    return {
      time_zone: response.pageViews.timeZone,
      window_start: response.pageViews.windowStart,
      window_end: response.pageViews.windowEnd,
      previous_window_start: response.pageViews.previousWindowStart,
      previous_window_end: response.pageViews.previousWindowEnd,
      buckets: response.pageViews.buckets,
      previous_buckets: response.pageViews.previousBuckets,
      total: response.pageViews.total,
      previous_total: response.pageViews.previousTotal,
      has_previous_data: response.pageViews.previousTotal > 0,
    };
  },
};
