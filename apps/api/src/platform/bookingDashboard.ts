import { buildBookingConversionFunnel, type BookingFunnelEvent } from "@vayada/domain-booking";
import type {
  BookingDashboardMetricsPeriodInput,
  BookingDashboardMetricsReadModel,
  BookingChannelMixReadModel,
  BookingDashboardBooking,
  BookingDashboardDetailsReadModel,
  BookingDashboardMetricsReadPort,
  BookingDate,
  BookingDayBookingsReadModel,
  BookingMoney,
  BookingPageViewTimelineReadModel,
  BookingRevenueDaysReadModel,
  BookingSourceMixReadModel,
  BookingSparklineReadModel,
} from "@vayada/domain-booking";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type BookingDashboardMetricsReadClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

export type BookingDashboardMetricsReadPool = BookingDashboardMetricsReadClient & {
  end(): Promise<void>;
};

type BookingDashboardMetricsRow = {
  propertyFound: boolean;
  revenueAmount: string | null;
  bookingCount: string;
  conversionBookingCount: string;
  pageViewsCountedFrom: string | Date | null;
  unverifiedBookingCount: string;
  otherCurrencyBookingCount: string;
  roomNightCount: string | null;
  currency: string | null;
  nextArrivalDate: string | Date | null;
  liveSinceDate: string | Date | null;
};

type BookingDashboardSourceRow = {
  source: string | null;
  revenueAmount: string | null;
  bookingCount: string;
  unverifiedBookingCount: string;
  otherCurrencyBookingCount: string;
  currency: string | null;
};

type BookingDashboardSparklineRow = {
  bucketStart: string | Date;
  bucketEnd: string | Date;
  revenueAmount: string | null;
  bookingCount: string;
  unverifiedBookingCount: string;
  otherCurrencyBookingCount: string;
  roomNightCount: string | null;
  currency: string | null;
};

type BookingPageViewBucketRow = {
  propertyFound: boolean;
  timeZone: string | null;
  bucketDate: string | Date;
  pageViewCount: string;
};

type BookingRevenueDayRow = {
  propertyFound: boolean;
  date: string | Date;
  revenueAmount: string | null;
  bookingCount: string;
  bookingPageBookingCount: string;
  otherCurrencyBookingCount: string;
  currency: string | null;
};

type BookingRowJson = {
  id: string;
  reference: string;
  bookedOn: string;
  status: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  totalAmount: string;
  currency: string;
  counted: boolean;
  roomNames: string[] | null;
};

type BookingDayBookingsRow = {
  propertyFound: boolean;
  currency: string | null;
  bookings: BookingRowJson[];
};

type BookingDashboardDetailsRow = {
  currency: string | null;
  pageViewsCountedFrom: string | null;
  roomTypes: { name: string | null; revenue: string; previousRevenue: string }[];
  leadTimes: {
    bucket: "0-7" | "8-30" | "31-90" | "90+";
    bookingCount: number;
    previousBookingCount: number;
  }[];
  canceledBookingCount: string;
  topBookings: BookingRowJson[];
  recentBookings: BookingRowJson[];
};

/** A booking row from bookingRowJsonSql. */
function toDashboardBooking(booking: BookingRowJson): BookingDashboardBooking {
  return {
    id: booking.id,
    reference: booking.reference,
    bookedOn: booking.bookedOn,
    status: booking.status === "canceled" ? "canceled" : "confirmed",
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    nights: inclusiveDays(booking.checkIn, booking.checkOut) - 1,
    roomCount: booking.roomCount,
    // One name per room type, in room order.
    roomNames: [...new Set(booking.roomNames ?? [])],
    total: money(numeric(booking.totalAmount), booking.currency),
    countedInRevenue: booking.counted,
  };
}

export function createTargetBookingDashboardMetricsReadPort(config: {
  connectionString: string;
  max?: number;
  pool?: BookingDashboardMetricsReadPool;
}): BookingDashboardMetricsReadPort & {
  resolveCanonicalPropertyId(propertyId: string): Promise<string | null>;
  close(): Promise<void>;
} {
  if (!config.connectionString.trim()) {
    throw new Error("Booking dashboard metrics read port connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool: BookingDashboardMetricsReadPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async resolveCanonicalPropertyId(propertyId) {
      const result = await pool.query<{ propertyId: string }>(
        `${bookingScopedPropertyCte()}
         SELECT property_id::text AS "propertyId" FROM scoped_property`,
        [propertyId],
      );
      return result.rows[0]?.propertyId ?? null;
    },
    async getConversionFunnel(input) {
      const result = await pool.query<{
        timeZone: string | null;
        addonsEnabled: boolean;
        events: BookingFunnelEvent[];
      }>(conversionFunnelSql(), [input.propertyId, input.windowStart, input.windowEnd]);
      const row = result.rows[0];
      if (!row) return null;
      if (!row.timeZone) throw new Error("Booking funnel requires a canonical property timezone");
      return buildBookingConversionFunnel(row.events, row.addonsEnabled);
    },
    async getDashboardMetrics(input) {
      const [currentResult, previousResult, currentPageViews, previousPageViews] =
        await Promise.all([
          pool.query<BookingDashboardMetricsRow>(dashboardMetricsSql(), [
            input.propertyId,
            input.periodStart,
            input.periodEnd,
          ]),
          pool.query<BookingDashboardMetricsRow>(dashboardMetricsSql(), [
            input.propertyId,
            input.previousPeriodStart,
            input.previousPeriodEnd,
          ]),
          pool.query<BookingPageViewBucketRow>(pageViewBucketsSql(), [
            input.propertyId,
            input.periodStart,
            input.periodEnd,
          ]),
          pool.query<BookingPageViewBucketRow>(pageViewBucketsSql(), [
            input.propertyId,
            input.previousPeriodStart,
            input.previousPeriodEnd,
          ]),
        ]);

      const current = currentResult.rows[0];
      const previous = previousResult.rows[0];
      const currentViews = currentPageViews.rows[0];
      const previousViews = previousPageViews.rows[0];
      if (
        !current?.propertyFound ||
        !previous?.propertyFound ||
        !currentViews?.propertyFound ||
        !previousViews?.propertyFound
      ) {
        return null;
      }
      requirePageViewTimeZone(currentViews);
      requirePageViewTimeZone(previousViews);

      return {
        propertyId: input.propertyId,
        current: toRevenueStats(current, currentPageViews.rows),
        previous: toRevenueStats(previous, previousPageViews.rows),
        nextArrivalDate: toDateString(current.nextArrivalDate),
        liveSinceDate: toDateString(current.liveSinceDate),
      } satisfies BookingDashboardMetricsReadModel;
    },
    async getSourceMix(input) {
      const result = await pool.query<BookingDashboardSourceRow>(sourceMixSql(), [
        input.propertyId,
        input.periodStart,
        input.periodEnd,
      ]);
      const totalRevenue = result.rows.reduce((sum, row) => sum + numeric(row.revenueAmount), 0);
      const currency = result.rows.find((row) => row.currency)?.currency ?? "USD";

      return {
        propertyId: input.propertyId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        totalRevenue: money(totalRevenue, currency),
        items: result.rows.map((row) => {
          const revenue = numeric(row.revenueAmount);
          return {
            source: row.source || "direct",
            revenue: money(revenue, row.currency ?? currency),
            bookingCount: Number(row.bookingCount),
            unverifiedBookingCount: Number(row.unverifiedBookingCount ?? 0),
            otherCurrencyBookingCount: Number(row.otherCurrencyBookingCount ?? 0),
            revenueSharePercent:
              totalRevenue > 0 ? Math.round((revenue / totalRevenue) * 1000) / 10 : 0,
          };
        }),
      } satisfies BookingSourceMixReadModel;
    },
    async getSparklines(input) {
      const [result, pageViews] = await Promise.all([
        pool.query<BookingDashboardSparklineRow>(sparklineSql(), [
          input.propertyId,
          input.windowStart,
          input.windowEnd,
        ]),
        pool.query<BookingPageViewBucketRow>(pageViewBucketsSql(), [
          input.propertyId,
          input.windowStart,
          input.windowEnd,
        ]),
      ]);
      const currency = result.rows.find((row) => row.currency)?.currency ?? "USD";
      requirePageViewTimeZone(pageViews.rows[0]);

      return {
        propertyId: input.propertyId,
        points: result.rows.map((row) => ({
          bucketStart: toDateString(row.bucketStart) ?? input.windowStart,
          bucketEnd: toDateString(row.bucketEnd) ?? input.windowEnd,
          revenue: money(numeric(row.revenueAmount), row.currency ?? currency),
          bookingCount: Number(row.bookingCount),
          unverifiedBookingCount: Number(row.unverifiedBookingCount ?? 0),
          otherCurrencyBookingCount: Number(row.otherCurrencyBookingCount ?? 0),
          avgNightlyRate: averageNightlyRate(row, row.currency ?? currency),
          pageViewCount: totalPageViews(
            pageViews.rows,
            toDateString(row.bucketStart),
            toDateString(row.bucketEnd),
          ),
        })),
      } satisfies BookingSparklineReadModel;
    },
    async getPageViewTimeline(input) {
      const windowDays = inclusiveDays(input.windowStart, input.windowEnd);
      const previousWindowStart = shiftIsoDate(input.windowStart, -windowDays);
      const previousWindowEnd = shiftIsoDate(input.windowStart, -1);
      const result = await pool.query<BookingPageViewBucketRow>(pageViewBucketsSql(), [
        input.propertyId,
        previousWindowStart,
        input.windowEnd,
      ]);
      const first = result.rows[0];
      if (!first?.propertyFound) return null;
      const timeZone = requirePageViewTimeZone(first);
      const current = result.rows.filter(
        (row) => (toDateString(row.bucketDate) ?? "") >= input.windowStart,
      );
      const previous = result.rows.filter(
        (row) => (toDateString(row.bucketDate) ?? "") < input.windowStart,
      );
      const buckets = current.map(toPageViewBucket);
      const previousBuckets = previous.map(toPageViewBucket);
      return {
        propertyId: input.propertyId,
        timeZone,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        previousWindowStart,
        previousWindowEnd,
        buckets,
        previousBuckets,
        total: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
        previousTotal: previousBuckets.reduce((sum, bucket) => sum + bucket.count, 0),
      } satisfies BookingPageViewTimelineReadModel;
    },
    async getChannelMix(input) {
      const result = await pool.query<{
        kind: "channel" | "source";
        key: string | null;
        bookingCount: string;
        previousBookingCount: string;
      }>(channelMixSql(), [
        input.propertyId,
        input.periodStart,
        input.periodEnd,
        input.previousPeriodStart,
        input.previousPeriodEnd,
      ]);
      const counts = (kind: "channel" | "source") =>
        result.rows
          .filter((row) => row.kind === kind)
          .map((row) => ({
            key: row.key ?? "unknown",
            bookingCount: Number(row.bookingCount),
            previousBookingCount: Number(row.previousBookingCount),
          }));
      return {
        propertyId: input.propertyId,
        channels: counts("channel"),
        directSources: counts("source"),
      } satisfies BookingChannelMixReadModel;
    },
    async getDashboardDetails(input) {
      const result = await pool.query<BookingDashboardDetailsRow>(detailsSql(), [
        input.propertyId,
        input.periodStart,
        input.periodEnd,
        input.previousPeriodStart,
        input.previousPeriodEnd,
      ]);
      const row = result.rows[0];
      const currency = row?.currency ?? "USD";
      return {
        propertyId: input.propertyId,
        pageViewsCountedFrom: toDateString(row?.pageViewsCountedFrom),
        roomTypes: (row?.roomTypes ?? []).map((roomType) => ({
          name: roomType.name,
          revenue: money(numeric(roomType.revenue), currency),
          previousRevenue: money(numeric(roomType.previousRevenue), currency),
        })),
        leadTimes: (row?.leadTimes ?? []).map((lead) => ({
          bucket: lead.bucket,
          bookingCount: Number(lead.bookingCount),
          previousBookingCount: Number(lead.previousBookingCount),
        })),
        canceledBookingCount: Number(row?.canceledBookingCount ?? 0),
        topBookings: (row?.topBookings ?? []).map(toDashboardBooking),
        recentBookings: (row?.recentBookings ?? []).map(toDashboardBooking),
      } satisfies BookingDashboardDetailsReadModel;
    },
    async getRevenueDays(input) {
      const result = await pool.query<BookingRevenueDayRow>(revenueDaysSql(), [
        input.propertyId,
        input.windowStart,
        input.windowEnd,
      ]);
      if (!result.rows[0]?.propertyFound) return null;
      const currency = result.rows[0].currency ?? "USD";
      return {
        propertyId: input.propertyId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        days: result.rows.map((row) => ({
          date: toDateString(row.date) ?? String(row.date),
          revenue: money(numeric(row.revenueAmount), currency),
          bookingCount: Number(row.bookingCount),
          bookingPageBookingCount: Number(row.bookingPageBookingCount ?? 0),
          otherCurrencyBookingCount: Number(row.otherCurrencyBookingCount ?? 0),
        })),
      } satisfies BookingRevenueDaysReadModel;
    },
    async getDayBookings(input) {
      const result = await pool.query<BookingDayBookingsRow>(dayBookingsSql(), [
        input.propertyId,
        input.date,
      ]);
      const row = result.rows[0];
      if (!row?.propertyFound) return null;
      const currency = row.currency ?? "USD";
      const bookings = row.bookings.map((booking) => {
        const { bookedOn: _bookedOn, status: _status, ...dayBooking } = toDashboardBooking(booking);
        return dayBooking;
      });
      return {
        propertyId: input.propertyId,
        date: input.date,
        revenue: money(
          bookings.reduce(
            (sum, booking) =>
              booking.countedInRevenue ? sum + numeric(booking.total.amountDecimal) : sum,
            0,
          ),
          currency,
        ),
        bookingCount: bookings.length,
        roomNights: bookings.reduce(
          (sum, booking) => sum + Math.max(booking.nights, 1) * booking.roomCount,
          0,
        ),
        bookings,
      } satisfies BookingDayBookingsReadModel;
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

export function bookingScopedPropertyCte(): string {
  return `WITH scoped_property_candidates AS (
    SELECT property.id AS property_id
    FROM hotel_catalog.properties property
    WHERE property.id::text = $1
    UNION
    SELECT source.property_id
    FROM hotel_catalog.property_source_links source
    WHERE source.source_system = 'booking'
      AND source.source_table = 'booking_hotels'
      AND source.source_id = $1
      AND source.relationship = 'canonical_input'
      AND source.status = 'active'
  ),
  scoped_property AS (
    SELECT MIN(property_id::text)::uuid AS property_id
    FROM scoped_property_candidates
    HAVING COUNT(*) = 1
  )`;
}

// VAY-2390: money metrics add up only bookings in the property's currency, the PMS pricing currency
// guests pay in (Booking settings' default before the hotel has prices). An OTA booking in another
// currency still counts as a booking and is reported as otherCurrencyBookingCount.
function propertyCurrencyCte(): string {
  return `property_currency AS (
    SELECT COALESCE(pricing.currency, settings.default_currency, 'EUR')::text AS currency
    FROM scoped_property scoped
    LEFT JOIN pms.property_pricing_settings pricing ON pricing.property_id = scoped.property_id
    LEFT JOIN booking.booking_settings settings ON settings.property_id = scoped.property_id
  )`;
}

// VAY-2594: the dashboard dates a booking by the day it was made, in the property's time zone, not
// by check-in. A booking imported from the channel manager was made before the import, so it is
// dated by the channel manager's time when that is earlier. The mapping keeps the time of the
// latest change only, so a booking changed after its import keeps the import date.
function datedBookingsCte(options: { withCanceled?: boolean } = {}): string {
  const statuses = options.withCanceled
    ? "('confirmed', 'completed', 'canceled')"
    : "('confirmed', 'completed')";
  return `property_zone AS (
    SELECT COALESCE(zone.name, 'UTC') AS time_zone
    FROM scoped_property scoped
    LEFT JOIN hotel_catalog.property_locations location ON location.property_id = scoped.property_id
    LEFT JOIN pg_timezone_names zone ON zone.name = location.timezone
  ),
  dated_bookings AS (
    SELECT booking.*,
      (LEAST(booking.created_at, channex.first_seen_at) AT TIME ZONE (SELECT time_zone FROM property_zone))::date
        AS booked_on
    FROM booking.guest_bookings booking
    JOIN scoped_property scoped ON scoped.property_id = booking.property_id
    LEFT JOIN LATERAL (
      SELECT MIN((mapping.mapping_metadata ->> 'providerInsertedAt')::timestamptz) AS first_seen_at
      FROM pms.channel_booking_mappings mapping
      WHERE mapping.guest_booking_id = booking.id
        AND mapping.property_id = booking.property_id
        -- Only well-formed times, so one odd value can't fail the whole dashboard.
        AND mapping.mapping_metadata ->> 'providerInsertedAt'
          ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
    ) channex ON TRUE
    WHERE booking.lifecycle_status IN ${statuses}
  )`;
}

const VERIFIED_AMOUNT = `booking.booking_metadata->>'airbnbMoneyStatus' IS DISTINCT FROM 'unverified'`;
const COUNTED_AMOUNT = `${VERIFIED_AMOUNT} AND booking.currency::text = (SELECT currency FROM property_currency)`;
const OTHER_CURRENCY = `${VERIFIED_AMOUNT} AND booking.currency::text <> (SELECT currency FROM property_currency)`;

function dashboardMetricsSql(): string {
  return `${bookingScopedPropertyCte()},
  ${propertyCurrencyCte()},
  ${datedBookingsCte()},
  -- VAY-2592: the booking page counts every page view from its first anonymous one on; before,
  -- only visits of guests who allowed analytics. The conversion rate uses only the days since.
  page_views_counted AS (
    SELECT (MIN(first_view.occurred_at) AT TIME ZONE (SELECT time_zone FROM property_zone))::date
      AS counted_from
    FROM distribution.booking_web_events first_view
    JOIN scoped_property scoped ON scoped.property_id = first_view.property_id
    WHERE first_view.event_type = 'page_view'
  )
  SELECT
    COALESCE(SUM(booking.total_amount) FILTER (WHERE ${COUNTED_AMOUNT}), 0)::text AS "revenueAmount",
    COUNT(*)::text AS "bookingCount",
    COUNT(*) FILTER (
      WHERE booking.direct_booking_source = 'booking_engine'
        AND booking.booked_on >= (SELECT counted_from FROM page_views_counted)
    )::text AS "conversionBookingCount",
    (SELECT counted_from::text FROM page_views_counted) AS "pageViewsCountedFrom",
    COUNT(*) FILTER (WHERE booking.booking_metadata->>'airbnbMoneyStatus' = 'unverified')::text AS "unverifiedBookingCount",
    COUNT(*) FILTER (WHERE ${OTHER_CURRENCY})::text AS "otherCurrencyBookingCount",
    COALESCE(
      SUM(GREATEST(booking.check_out - booking.check_in, 1) * booking.room_count) FILTER (WHERE ${COUNTED_AMOUNT}),
      0
    )::text AS "roomNightCount",
    (SELECT currency FROM property_currency) AS currency,
    (
      SELECT MIN(upcoming.check_in)::text
      FROM dated_bookings upcoming
      WHERE upcoming.check_in >= CURRENT_DATE
    ) AS "nextArrivalDate",
    (
      SELECT MIN(live.check_in)::text
      FROM dated_bookings live
    ) AS "liveSinceDate",
    EXISTS (SELECT 1 FROM scoped_property) AS "propertyFound"
  FROM dated_bookings booking
  WHERE booking.booking_channel = 'direct'
    AND booking.booked_on >= $2::date
    AND booking.booked_on <= $3::date`;
}

function sourceMixSql(): string {
  return `${bookingScopedPropertyCte()},
  ${propertyCurrencyCte()},
  ${datedBookingsCte()}
  SELECT
    COALESCE(
      NULLIF(booking.booking_metadata ->> 'channel', ''),
      NULLIF(booking.source_system, ''),
      'direct'
    ) AS source,
    COALESCE(SUM(booking.total_amount) FILTER (WHERE ${COUNTED_AMOUNT}), 0)::text AS "revenueAmount",
    COUNT(*)::text AS "bookingCount",
    COUNT(*) FILTER (WHERE booking.booking_metadata->>'airbnbMoneyStatus' = 'unverified')::text AS "unverifiedBookingCount",
    COUNT(*) FILTER (WHERE ${OTHER_CURRENCY})::text AS "otherCurrencyBookingCount",
    (SELECT currency FROM property_currency) AS currency
  FROM dated_bookings booking
  WHERE booking.booked_on >= $2::date
    AND booking.booked_on <= $3::date
  GROUP BY COALESCE(
    NULLIF(booking.booking_metadata ->> 'channel', ''),
    NULLIF(booking.source_system, ''),
    'direct'
  )
  ORDER BY SUM(booking.total_amount) FILTER (WHERE ${COUNTED_AMOUNT}) DESC, source ASC`;
}

function sparklineSql(): string {
  return `${bookingScopedPropertyCte()},
  ${propertyCurrencyCte()},
  ${datedBookingsCte()},
  -- One bucket per day up to 31 days; longer windows split into 31 contiguous buckets.
  sizing AS (
    SELECT $3::date - $2::date + 1 AS window_days, LEAST($3::date - $2::date + 1, 31) AS bucket_count
  ),
  buckets AS (
    SELECT
      ($2::date + floor((sizing.window_days * bucket_index)::numeric / sizing.bucket_count)::int)
        AS bucket_start,
      ($2::date + floor((sizing.window_days * (bucket_index + 1))::numeric / sizing.bucket_count)::int - 1)
        AS bucket_end
    FROM sizing
    CROSS JOIN LATERAL generate_series(0, sizing.bucket_count - 1) bucket_index
  )
  SELECT
    bucket.bucket_start::text AS "bucketStart",
    bucket.bucket_end::text AS "bucketEnd",
    COALESCE(SUM(booking.total_amount) FILTER (WHERE ${COUNTED_AMOUNT}), 0)::text AS "revenueAmount",
    COUNT(booking.id)::text AS "bookingCount",
    COUNT(booking.id) FILTER (WHERE booking.booking_metadata->>'airbnbMoneyStatus' = 'unverified')::text AS "unverifiedBookingCount",
    COUNT(booking.id) FILTER (WHERE ${OTHER_CURRENCY})::text AS "otherCurrencyBookingCount",
    COALESCE(
      SUM(GREATEST(booking.check_out - booking.check_in, 1) * booking.room_count) FILTER (WHERE ${COUNTED_AMOUNT}),
      0
    )::text AS "roomNightCount",
    (SELECT currency FROM property_currency) AS currency
  FROM buckets bucket
  JOIN scoped_property scoped ON TRUE
  LEFT JOIN dated_bookings booking
    ON booking.booking_channel = 'direct'
   AND booking.booked_on >= bucket.bucket_start
   AND booking.booked_on <= bucket.bucket_end
  GROUP BY bucket.bucket_start, bucket.bucket_end
  ORDER BY bucket.bucket_start`;
}

// Bookings by channel (VAY-2594): every channel, and direct bookings by source, made in the period
// and in the period before, by booking date.
function channelMixSql(): string {
  const inPeriods = `(booking.booked_on BETWEEN $2::date AND $3::date
      OR booking.booked_on BETWEEN $4::date AND $5::date)`;
  const counts = `COUNT(*) FILTER (WHERE booking.booked_on BETWEEN $2::date AND $3::date)::text AS "bookingCount",
    COUNT(*) FILTER (WHERE booking.booked_on BETWEEN $4::date AND $5::date)::text AS "previousBookingCount"`;
  return `${bookingScopedPropertyCte()},
  ${datedBookingsCte()}
  SELECT 'channel' AS kind, booking.booking_channel AS key, ${counts}
  FROM dated_bookings booking
  WHERE ${inPeriods}
  GROUP BY booking.booking_channel
  UNION ALL
  SELECT 'source' AS kind, booking.direct_booking_source AS key, ${counts}
  FROM dated_bookings booking
  WHERE booking.booking_channel = 'direct' AND ${inPeriods}
  GROUP BY booking.direct_booking_source`;
}

// One row per day of the window: the direct bookings made that day (VAY-2594 revenue chart).
function revenueDaysSql(): string {
  return `${bookingScopedPropertyCte()},
  ${propertyCurrencyCte()},
  ${datedBookingsCte()},
  days AS (
    SELECT day::date AS day FROM generate_series($2::date, $3::date, INTERVAL '1 day') day
  )
  SELECT
    EXISTS (SELECT 1 FROM scoped_property) AS "propertyFound",
    days.day::text AS date,
    COALESCE(SUM(booking.total_amount) FILTER (WHERE ${COUNTED_AMOUNT}), 0)::text AS "revenueAmount",
    COUNT(booking.id)::text AS "bookingCount",
    COUNT(booking.id) FILTER (WHERE booking.direct_booking_source = 'booking_engine')::text
      AS "bookingPageBookingCount",
    COUNT(booking.id) FILTER (WHERE ${OTHER_CURRENCY})::text AS "otherCurrencyBookingCount",
    (SELECT currency FROM property_currency) AS currency
  FROM days
  LEFT JOIN dated_bookings booking
    ON booking.booking_channel = 'direct'
   AND booking.booked_on = days.day
  GROUP BY days.day
  ORDER BY days.day`;
}

// One booking in a dashboard list (the day window, Details): its stay, room types and value. The
// room types are those of its PMS rooms, or of what was booked before PMS has rooms for it.
function bookingRowJsonSql(): string {
  return `jsonb_build_object(
    'id', booking.id::text,
    'reference', booking.public_reference,
    'bookedOn', booking.booked_on::text,
    'status', booking.lifecycle_status,
    'checkIn', booking.check_in::text,
    'checkOut', booking.check_out::text,
    'roomCount', booking.room_count,
    'totalAmount', booking.total_amount::text,
    'currency', booking.currency::text,
    'counted', ${COUNTED_AMOUNT},
    'roomNames', COALESCE(
      (
        SELECT array_agg(typed.name ORDER BY typed.first_position)
        FROM (
          SELECT room_type.name, MIN(assignment.position) AS first_position
          FROM pms.operational_booking_assignments assignment
          JOIN pms.room_types room_type
            ON room_type.id = assignment.room_type_id
           AND room_type.property_id = assignment.property_id
          WHERE assignment.guest_booking_id = booking.id
            AND assignment.property_id = booking.property_id
            AND NOT (assignment.assignment_status = 'released'
              AND assignment.assignment_payload @> '{"channexAlterationReleased":true}')
          GROUP BY room_type.id, room_type.name
        ) typed
      ),
      (
        SELECT array_agg(room_type.name ORDER BY selection.position)
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(booking.booking_metadata -> 'pricingSelections') = 'array'
            THEN booking.booking_metadata -> 'pricingSelections' ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS selection(value, position)
        JOIN pms.room_types room_type
          ON room_type.id::text = selection.value ->> 'roomTypeId'
         AND room_type.property_id = booking.property_id
      )
    )
  )`;
}

// The Details window (VAY-2594): direct bookings made in the period and the one before, by room
// type and lead time, with the period's cancellations, its top bookings and its latest ones.
function detailsSql(): string {
  const current = "booking.booked_on BETWEEN $2::date AND $3::date";
  const previous = "booking.booked_on BETWEEN $4::date AND $5::date";
  const kept = "booking.lifecycle_status IN ('confirmed', 'completed')";
  return `${bookingScopedPropertyCte()},
  ${propertyCurrencyCte()},
  ${datedBookingsCte({ withCanceled: true })},
  direct_bookings AS (
    SELECT booking.* FROM dated_bookings booking
    WHERE booking.booking_channel = 'direct' AND (${current} OR ${previous})
  ),
  room_typed AS (
    SELECT booking.booked_on, booking.total_amount, ${current} AS in_current,
      -- A booking with rooms of several types counts under its first room's type.
      COALESCE(
        (
          SELECT room_type.name
          FROM pms.operational_booking_assignments assignment
          JOIN pms.room_types room_type
            ON room_type.id = assignment.room_type_id
           AND room_type.property_id = assignment.property_id
          WHERE assignment.guest_booking_id = booking.id
            AND assignment.property_id = booking.property_id
            AND NOT (assignment.assignment_status = 'released'
              AND assignment.assignment_payload @> '{"channexAlterationReleased":true}')
          ORDER BY assignment.position, assignment.created_at, assignment.id
          LIMIT 1
        ),
        (
          SELECT room_type.name
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(booking.booking_metadata -> 'pricingSelections') = 'array'
              THEN booking.booking_metadata -> 'pricingSelections' ELSE '[]'::jsonb END
          ) WITH ORDINALITY AS selection(value, position)
          JOIN pms.room_types room_type
            ON room_type.id::text = selection.value ->> 'roomTypeId'
           AND room_type.property_id = booking.property_id
          ORDER BY selection.position
          LIMIT 1
        )
      ) AS room_name
    FROM direct_bookings booking
    WHERE ${kept} AND ${COUNTED_AMOUNT}
  )
  SELECT
    (SELECT currency FROM property_currency) AS currency,
    (SELECT counted_from::text FROM (
      SELECT (MIN(first_view.occurred_at) AT TIME ZONE (SELECT time_zone FROM property_zone))::date
        AS counted_from
      FROM distribution.booking_web_events first_view
      JOIN scoped_property scoped ON scoped.property_id = first_view.property_id
      WHERE first_view.event_type = 'page_view'
    ) counted) AS "pageViewsCountedFrom",
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', grouped.room_name,
        'revenue', grouped.revenue::text,
        'previousRevenue', grouped.previous_revenue::text
      ) ORDER BY grouped.revenue DESC, grouped.room_name)
      FROM (
        SELECT room_name,
          COALESCE(SUM(total_amount) FILTER (WHERE in_current), 0) AS revenue,
          COALESCE(SUM(total_amount) FILTER (WHERE NOT in_current), 0) AS previous_revenue
        FROM room_typed
        GROUP BY room_name
      ) grouped
    ), '[]'::jsonb) AS "roomTypes",
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'bucket', bucket.name,
        'bookingCount', (SELECT COUNT(*) FROM direct_bookings booking
          WHERE ${kept} AND ${current} AND booking.check_in - booking.booked_on BETWEEN bucket.low AND bucket.high),
        'previousBookingCount', (SELECT COUNT(*) FROM direct_bookings booking
          WHERE ${kept} AND ${previous} AND booking.check_in - booking.booked_on BETWEEN bucket.low AND bucket.high)
      ) ORDER BY bucket.low)
      FROM (VALUES ('0-7', -100000, 7), ('8-30', 8, 30), ('31-90', 31, 90), ('90+', 91, 100000))
        AS bucket(name, low, high)
    ), '[]'::jsonb) AS "leadTimes",
    (SELECT COUNT(*) FROM direct_bookings booking
      WHERE booking.lifecycle_status = 'canceled' AND ${current})::text AS "canceledBookingCount",
    COALESCE((
      SELECT jsonb_agg(${bookingRowJsonSql()} ORDER BY booking.total_amount DESC, booking.created_at)
      FROM (
        SELECT * FROM direct_bookings booking
        WHERE ${kept} AND ${current} AND ${COUNTED_AMOUNT}
        ORDER BY booking.total_amount DESC, booking.created_at
        LIMIT 5
      ) booking
    ), '[]'::jsonb) AS "topBookings",
    COALESCE((
      SELECT jsonb_agg(${bookingRowJsonSql()} ORDER BY booking.booked_on DESC, booking.created_at DESC, booking.id)
      FROM (
        SELECT * FROM direct_bookings booking
        WHERE ${current}
        ORDER BY booking.booked_on DESC, booking.created_at DESC, booking.id
        LIMIT 5
      ) booking
    ), '[]'::jsonb) AS "recentBookings"`;
}

// The direct bookings made on one day, with their room types (VAY-2594 day window).
function dayBookingsSql(): string {
  return `${bookingScopedPropertyCte()},
  ${propertyCurrencyCte()},
  ${datedBookingsCte()}
  SELECT
    EXISTS (SELECT 1 FROM scoped_property) AS "propertyFound",
    (SELECT currency FROM property_currency) AS currency,
    COALESCE((
      SELECT jsonb_agg(${bookingRowJsonSql()} ORDER BY booking.created_at, booking.id)
      FROM dated_bookings booking
      WHERE booking.booking_channel = 'direct'
        AND booking.booked_on = $2::date
    ), '[]'::jsonb) AS bookings`;
}

function pageViewBucketsSql(): string {
  return `${bookingScopedPropertyCte()},
  telemetry_scope AS (
    SELECT scoped.property_id, location.timezone AS time_zone,
      -- VAY-2592: from a hotel's first anonymous page view on, every page load sends one, so
      -- only those count. Before it, the consented visits are the only page views there are.
      (
        SELECT MIN(first_view.occurred_at)
        FROM distribution.booking_web_events first_view
        WHERE first_view.property_id = scoped.property_id AND first_view.event_type = 'page_view'
      ) AS views_counted_from
    FROM scoped_property scoped
    JOIN hotel_catalog.property_locations location ON location.property_id = scoped.property_id
    JOIN pg_timezone_names timezone ON timezone.name = location.timezone
  ),
  buckets AS (
    SELECT day::date AS bucket_date
    FROM generate_series($2::date, $3::date, INTERVAL '1 day') day
  )
  SELECT
    EXISTS (SELECT 1 FROM scoped_property) AS "propertyFound",
    (SELECT time_zone FROM telemetry_scope) AS "timeZone",
    bucket.bucket_date::text AS "bucketDate",
    COUNT(DISTINCT event.id)::text AS "pageViewCount"
  FROM buckets bucket
  LEFT JOIN telemetry_scope scope ON TRUE
  LEFT JOIN distribution.booking_web_events event
    ON event.property_id = scope.property_id
   AND event.event_type IN ('page_view', 'page_visit')
   AND (
     event.event_type = 'page_view'
     OR scope.views_counted_from IS NULL
     OR event.occurred_at < scope.views_counted_from
   )
   AND event.traffic_class = 'human'
   AND event.occurred_at >= (bucket.bucket_date::timestamp AT TIME ZONE scope.time_zone)
   AND event.occurred_at < ((bucket.bucket_date + 1)::timestamp AT TIME ZONE scope.time_zone)
  GROUP BY bucket.bucket_date
  ORDER BY bucket.bucket_date`;
}

function toRevenueStats(
  row: BookingDashboardMetricsRow,
  pageViews: BookingPageViewBucketRow[],
): BookingDashboardMetricsReadModel["current"] {
  const currency = row.currency ?? "USD";
  const countedFrom = toDateString(row.pageViewsCountedFrom);
  const pageViewCount = totalPageViews(pageViews);
  return {
    totalRevenue: money(numeric(row.revenueAmount), currency),
    bookingCount: Number(row.bookingCount),
    conversionBookingCount: Number(row.conversionBookingCount ?? 0),
    conversionPageViewCount: countedFrom ? totalPageViews(pageViews, countedFrom) : 0,
    unverifiedBookingCount: Number(row.unverifiedBookingCount ?? 0),
    otherCurrencyBookingCount: Number(row.otherCurrencyBookingCount ?? 0),
    avgNightlyRate: averageNightlyRate(row, currency),
    pageViewCount,
  };
}

function requirePageViewTimeZone(row: BookingPageViewBucketRow | undefined): string {
  if (!row?.propertyFound || !row.timeZone) {
    throw new Error("Booking dashboard page views require a canonical property timezone");
  }
  return row.timeZone;
}

function totalPageViews(
  rows: BookingPageViewBucketRow[],
  start?: BookingDate | null,
  end?: BookingDate | null,
): number {
  return rows.reduce((sum, row) => {
    const date = toDateString(row.bucketDate);
    return date && (!start || date >= start) && (!end || date <= end)
      ? sum + Number(row.pageViewCount)
      : sum;
  }, 0);
}

function inclusiveDays(start: BookingDate, end: BookingDate): number {
  return (
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
  );
}

function shiftIsoDate(value: BookingDate, days: number): BookingDate {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toPageViewBucket(row: BookingPageViewBucketRow): {
  date: BookingDate;
  count: number;
} {
  return {
    date: toDateString(row.bucketDate) ?? String(row.bucketDate),
    count: Number(row.pageViewCount),
  };
}

function averageNightlyRate(
  row: { revenueAmount: string | null; roomNightCount: string | null },
  currency: string,
): BookingMoney {
  const roomNights = numeric(row.roomNightCount);
  return money(roomNights > 0 ? numeric(row.revenueAmount) / roomNights : 0, currency);
}

function money(amount: number, currency: string): BookingMoney {
  return {
    amountDecimal: amount.toFixed(2),
    currency,
  };
}

function numeric(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDateString(value: string | Date | null | undefined): BookingDate | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function conversionFunnelSql(): string {
  return `${bookingScopedPropertyCte()}
  SELECT timezone.name AS "timeZone",
    (COALESCE(settings.show_addons_step AND settings.addons_enabled, TRUE) AND EXISTS (
      SELECT 1 FROM booking.addon_definitions addon
      WHERE addon.property_id = scoped.property_id AND addon.status = 'active' AND addon.public_visible
    )) AS "addonsEnabled",
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'sessionId', event.session_id::text,
      'sequence', event.metadata -> 'funnelSequence',
      'stage', event.event_type,
      'paymentMethod', event.metadata ->> 'paymentMethod'
    ) ORDER BY event.occurred_at, event.id)
    FROM distribution.booking_web_events event
    WHERE property.profile_status = 'complete'
      AND event.property_id = scoped.property_id
      AND event.event_type IN ('page_visit', 'dates_searched', 'rate_selected', 'addons_step_passed',
        'details_completed', 'complete_booking_clicked', 'payment_authorized', 'booking_completed')
      AND event.metadata -> 'funnelVersion' = '1'::jsonb
      AND event.traffic_class = 'human'
      AND event.occurred_at >= ($2::date::timestamp AT TIME ZONE timezone.name)
      AND event.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE timezone.name)
    ), '[]'::jsonb) AS events
  FROM scoped_property scoped
  JOIN hotel_catalog.properties property ON property.id = scoped.property_id
  LEFT JOIN hotel_catalog.property_locations location ON location.property_id = scoped.property_id
  LEFT JOIN pg_timezone_names timezone ON timezone.name = location.timezone
  LEFT JOIN booking.booking_settings settings ON settings.property_id = scoped.property_id`;
}
