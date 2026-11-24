import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createTargetBookingDashboardMetricsReadPort } from "./platform/bookingDashboard.js";

const url = process.env["TEST_DATABASE_URL"];
if (url && !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(url).pathname))
  throw new Error("Refusing non-test database");

describe.skipIf(!url)("dashboard booking money", () => {
  it("counts direct bookings by the day they were made, and every channel in the source mix", async () => {
    const pool = new pg.Pool({ connectionString: url });
    const property = randomUUID();
    const port = createTargetBookingDashboardMetricsReadPort({ connectionString: url!, pool });
    try {
      await pool.query(
        `INSERT INTO hotel_catalog.properties(id,public_id,display_name,lifecycle_status) VALUES($1::uuid,$1::text,'Dashboard money test','active')`,
        [property],
      );
      await pool.query(
        `INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Berlin')`,
        [property],
      );
      const insert = async (input: {
        channel: string;
        source?: string;
        total: number;
        currency?: string;
        createdAt: string;
        checkIn?: string;
        metadata?: Record<string, unknown>;
      }) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO booking.guest_bookings(id,property_id,public_reference,booking_channel,direct_booking_source,lifecycle_status,check_in,check_out,currency,total_amount,room_count,adults,children,booking_metadata,created_at) VALUES($1::uuid,$2,$1::text,$3,$4,'confirmed',$5::date,$5::date + 2,$6,$7,1,2,0,$8,$9::timestamptz)`,
          [
            id,
            property,
            input.channel,
            input.source ?? null,
            input.checkIn ?? "2026-12-01",
            input.currency ?? "EUR",
            input.total,
            input.metadata ?? { channel: input.channel },
            input.createdAt,
          ],
        );
        return id;
      };
      // VAY-2594: direct bookings, dated by the day they were made in the property's time zone
      // (Europe/Berlin), whatever the arrival date.
      const roomType = randomUUID();
      await pool.query(
        `INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Deluxe Room')`,
        [roomType, property],
      );
      const first = await insert({
        channel: "direct",
        source: "booking_engine",
        total: 200,
        createdAt: "2026-09-30T22:30:00Z",
        metadata: { channel: "direct", pricingSelections: [{ roomTypeId: roomType }] },
      });
      await insert({
        channel: "direct",
        source: "call",
        total: 100,
        createdAt: "2026-10-03T09:00:00Z",
      });
      // Made on Sep 30 in Berlin: the previous period.
      await insert({
        channel: "direct",
        source: "booking_engine",
        total: 50,
        createdAt: "2026-09-30T21:30:00Z",
      });
      // Booking sites: in the source mix, never in the totals.
      await insert({
        channel: "airbnb",
        total: 900,
        currency: "USD",
        createdAt: "2026-10-02T10:00:00Z",
        metadata: { channel: "airbnb", airbnbMoneyStatus: "unverified" },
      });
      // Imported on Oct 4, but Channex had it on Sep 3: dated Sep 3.
      const imported = await insert({
        channel: "booking_com",
        total: 500,
        createdAt: "2026-10-04T08:00:00Z",
      });
      const connection = randomUUID();
      await pool.query(
        // Disconnected and unbound: enough for the mapping, without a binding claim.
        `INSERT INTO pms.channel_connections(id,property_id,provider,connection_status) VALUES($1,$2,'channex','disconnected')`,
        [connection, property],
      );
      await pool.query(
        `INSERT INTO pms.channel_booking_mappings(property_id,connection_id,guest_booking_id,external_booking_id,mapping_metadata) VALUES($1,$2,$3,$4,$5)`,
        [
          property,
          connection,
          imported,
          `ext-${imported}`,
          { providerInsertedAt: "2026-09-03T12:00:00.000000Z" },
        ],
      );

      // VAY-2592: a consented visit on Sep 28, then every page view from Oct 1 on.
      for (const [eventType, occurredAt] of [
        ["page_visit", "2026-09-28T10:00:00Z"],
        ["page_view", "2026-10-01T10:00:00Z"],
        ["page_view", "2026-10-02T10:00:00Z"],
      ])
        await pool.query(
          `INSERT INTO distribution.booking_web_events(property_id,event_type,event_id,occurred_at) VALUES($1,$2,gen_random_uuid(),$3::timestamptz)`,
          [property, eventType, occurredAt],
        );

      const period = { propertyId: property, periodStart: "2026-10-01", periodEnd: "2026-10-07" };
      const previous = { previousPeriodStart: "2026-09-24", previousPeriodEnd: "2026-09-30" };
      const metrics = await port.getDashboardMetrics({ ...period, ...previous });
      expect(metrics?.current).toMatchObject({
        bookingCount: 2,
        pageViewCount: 2,
        // Booking page bookings ÷ page views, both since Oct 1.
        conversionBookingCount: 1,
        conversionPageViewCount: 2,
        unverifiedBookingCount: 0,
        otherCurrencyBookingCount: 0,
        totalRevenue: { amountDecimal: "300.00", currency: "EUR" },
        avgNightlyRate: { amountDecimal: "75.00", currency: "EUR" },
      });
      expect(metrics?.previous).toMatchObject({
        bookingCount: 1,
        pageViewCount: 1,
        // Before every view was counted: no conversion rate, though a booking and a visit exist.
        conversionBookingCount: 0,
        conversionPageViewCount: 0,
        totalRevenue: { amountDecimal: "50.00", currency: "EUR" },
      });

      const sources = await port.getSourceMix(period);
      expect(
        Object.fromEntries(sources.items.map((item) => [item.source, item.bookingCount])),
      ).toEqual({
        direct: 2,
        airbnb: 1,
      });
      expect(sources.items.find((item) => item.source === "airbnb")).toMatchObject({
        unverifiedBookingCount: 1,
        revenue: { amountDecimal: "0.00", currency: "EUR" },
      });
      const september = await port.getSourceMix({
        ...period,
        periodStart: "2026-09-01",
        periodEnd: "2026-09-07",
      });
      expect(september.items.map((item) => [item.source, item.bookingCount])).toEqual([
        ["booking_com", 1],
      ]);

      // Bookings by channel: every channel, and direct ones by source, now and in the week before.
      const mix = await port.getChannelMix({ ...period, ...previous });
      const byKey = (
        rows: readonly { key: string; bookingCount: number; previousBookingCount: number }[],
      ) =>
        Object.fromEntries(
          rows.map((row) => [row.key, [row.bookingCount, row.previousBookingCount]]),
        );
      expect(byKey(mix.channels)).toEqual({ direct: [2, 1], airbnb: [1, 0] });
      expect(byKey(mix.directSources)).toEqual({ booking_engine: [1, 1], call: [1, 0] });
      // The Booking.com booking Channex had on Sep 3 counts there.
      const septemberMix = await port.getChannelMix({
        ...period,
        periodStart: "2026-09-01",
        periodEnd: "2026-09-07",
        previousPeriodStart: "2026-08-25",
        previousPeriodEnd: "2026-08-31",
      });
      expect(byKey(septemberMix.channels)).toEqual({ booking_com: [1, 0] });
      expect(septemberMix.directSources).toEqual([]);

      const spark = await port.getSparklines({
        propertyId: property,
        windowStart: period.periodStart,
        windowEnd: period.periodEnd,
      });
      expect(spark.points.map((point) => point.bookingCount)).toEqual([1, 0, 1, 0, 0, 0, 0]);
      expect(spark.points.map((point) => point.revenue.amountDecimal)).toEqual([
        "200.00",
        "0.00",
        "100.00",
        "0.00",
        "0.00",
        "0.00",
        "0.00",
      ]);
      // Daily buckets up to 31 days; longer windows split into 31 contiguous buckets.
      const month = await port.getSparklines({
        propertyId: property,
        windowStart: "2026-09-10",
        windowEnd: "2026-10-09",
      });
      expect(month.points).toHaveLength(30);
      expect(month.points[21]).toMatchObject({
        bucketStart: "2026-10-01",
        bucketEnd: "2026-10-01",
        bookingCount: 1,
      });
      const year = await port.getSparklines({
        propertyId: property,
        windowStart: "2026-01-01",
        windowEnd: "2026-12-31",
      });
      expect(year.points).toHaveLength(31);
      expect(year.points[0]?.bucketStart).toBe("2026-01-01");
      expect(year.points.at(-1)?.bucketEnd).toBe("2026-12-31");
      expect(year.points.reduce((total, point) => total + point.bookingCount, 0)).toBe(3);

      // The revenue chart: one day per date of the window, direct bookings by booking date.
      const revenueDays = await port.getRevenueDays({
        propertyId: property,
        windowStart: period.periodStart,
        windowEnd: period.periodEnd,
      });
      expect(
        revenueDays?.days.map((day) => [day.date, day.bookingCount, day.revenue.amountDecimal]),
      ).toEqual([
        ["2026-10-01", 1, "200.00"],
        ["2026-10-02", 0, "0.00"],
        ["2026-10-03", 1, "100.00"],
        ["2026-10-04", 0, "0.00"],
        ["2026-10-05", 0, "0.00"],
        ["2026-10-06", 0, "0.00"],
        ["2026-10-07", 0, "0.00"],
      ]);
      // The day window: Oct 1 in Berlin, though the booking was made on Sep 30 in UTC.
      const day = await port.getDayBookings({ propertyId: property, date: "2026-10-01" });
      expect(day).toMatchObject({
        date: "2026-10-01",
        bookingCount: 1,
        roomNights: 2,
        revenue: { amountDecimal: "200.00", currency: "EUR" },
        bookings: [
          {
            id: first,
            reference: first,
            checkIn: "2026-12-01",
            checkOut: "2026-12-03",
            nights: 2,
            roomCount: 1,
            roomNames: ["Deluxe Room"],
            total: { amountDecimal: "200.00", currency: "EUR" },
            countedInRevenue: true,
          },
        ],
      });
      // Booking sites' bookings aren't in the window.
      expect(
        (await port.getDayBookings({ propertyId: property, date: "2026-10-02" }))?.bookings,
      ).toEqual([]);
      expect(
        await port.getDayBookings({ propertyId: randomUUID(), date: "2026-10-01" }),
      ).toBeNull();
      expect(
        await port.getRevenueDays({
          propertyId: randomUUID(),
          windowStart: "2026-10-01",
          windowEnd: "2026-10-02",
        }),
      ).toBeNull();

      // VAY-2390: amounts are in the PMS pricing currency, not Booking settings' default. A direct
      // booking in another currency is counted, but not added to revenue or rates.
      await pool.query(
        `INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES($1,'EUR')`,
        [property],
      );
      await pool.query(
        `INSERT INTO booking.booking_settings(property_id,default_currency) VALUES($1,'LKR')`,
        [property],
      );
      await insert({
        channel: "direct",
        source: "email",
        total: 70,
        currency: "GBP",
        createdAt: "2026-10-05T10:00:00Z",
      });
      const mixed = await port.getDashboardMetrics({ ...period, ...previous });
      expect(mixed?.current).toMatchObject({
        bookingCount: 3,
        otherCurrencyBookingCount: 1,
        totalRevenue: { amountDecimal: "300.00", currency: "EUR" },
      });
      const gbpDay = await port.getDayBookings({ propertyId: property, date: "2026-10-05" });
      expect(gbpDay).toMatchObject({
        bookingCount: 1,
        revenue: { amountDecimal: "0.00", currency: "EUR" },
        bookings: [{ total: { amountDecimal: "70.00", currency: "GBP" }, countedInRevenue: false }],
      });
      const mixedSpark = await port.getSparklines({
        propertyId: property,
        windowStart: period.periodStart,
        windowEnd: period.periodEnd,
      });
      expect(mixedSpark.points[4]).toMatchObject({
        bookingCount: 1,
        otherCurrencyBookingCount: 1,
        revenue: { amountDecimal: "0.00", currency: "EUR" },
      });
    } finally {
      await pool.query("DELETE FROM pms.channel_booking_mappings WHERE property_id=$1", [property]);
      await pool.query("DELETE FROM pms.channel_connections WHERE property_id=$1", [property]);
      await pool.query("DELETE FROM booking.guest_bookings WHERE property_id=$1", [property]);
      await pool.query("DELETE FROM booking.booking_settings WHERE property_id=$1", [property]);
      await pool.query("DELETE FROM pms.room_types WHERE property_id=$1", [property]);
      await pool.query("DELETE FROM pms.property_pricing_settings WHERE property_id=$1", [
        property,
      ]);
      await pool.query("DELETE FROM hotel_catalog.property_locations WHERE property_id=$1", [
        property,
      ]);
      await pool.query("DELETE FROM distribution.booking_web_events WHERE property_id=$1", [
        property,
      ]);
      await pool.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [property]);
      await pool.end();
    }
  });
});
