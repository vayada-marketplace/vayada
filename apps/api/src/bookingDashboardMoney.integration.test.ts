import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createTargetBookingDashboardMetricsReadPort } from "./platform/bookingDashboard.js";

const url = process.env["TEST_DATABASE_URL"];
if (url && !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(url).pathname))
  throw new Error("Refusing non-test database");

describe.skipIf(!url)("dashboard unverified booking money", () => {
  it("excludes uncertain amounts and ADR nights while keeping bookings and coverage across all reports", async () => {
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
      for (const [channel, total, metadata, currency, createdAt] of [
        ["direct", 200, { channel: "direct" }, "EUR", "2026-09-01"],
        [
          "airbnb",
          900,
          { channel: "airbnb", airbnbMoneyStatus: "unverified" },
          "USD",
          "2026-09-02",
        ],
      ] as const) {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO booking.guest_bookings(id,property_id,public_reference,booking_channel,lifecycle_status,check_in,check_out,currency,total_amount,room_count,adults,children,booking_metadata,direct_booking_source,created_at) VALUES($1::uuid,$2,$1::text,$3,'confirmed','2026-10-01','2026-10-03',$6,$4,1,2,0,$5,CASE WHEN $3='direct' THEN 'booking_engine' ELSE NULL END,$7::timestamptz)`,
          [id, property, channel, total, metadata, currency, createdAt],
        );
      }
      const period = { propertyId: property, periodStart: "2026-10-01", periodEnd: "2026-10-07" };
      const metrics = await port.getDashboardMetrics({
        ...period,
        previousPeriodStart: "2026-09-01",
        previousPeriodEnd: "2026-09-07",
      });
      expect(metrics?.current).toMatchObject({
        bookingCount: 2,
        unverifiedBookingCount: 1,
        totalRevenue: { amountDecimal: "200.00", currency: "EUR" },
        avgNightlyRate: { amountDecimal: "100.00", currency: "EUR" },
      });
      const sources = await port.getSourceMix(period);
      expect(sources.totalRevenue).toEqual({ amountDecimal: "200.00", currency: "EUR" });
      expect(sources.items.find((item) => item.source === "airbnb")).toMatchObject({
        bookingCount: 1,
        unverifiedBookingCount: 1,
        revenue: { amountDecimal: "0.00", currency: "EUR" },
        revenueSharePercent: 0,
      });
      const spark = await port.getSparklines({
        propertyId: property,
        windowStart: period.periodStart,
        windowEnd: period.periodEnd,
      });
      expect(spark.points[0]).toMatchObject({
        bookingCount: 2,
        unverifiedBookingCount: 1,
        revenue: { amountDecimal: "200.00", currency: "EUR" },
        avgNightlyRate: { amountDecimal: "100.00", currency: "EUR" },
      });
      // With only unverified bookings, zero eligible revenue remains explicitly incomplete.
      await pool.query(
        `DELETE FROM booking.guest_bookings WHERE property_id=$1 AND booking_channel='direct'`,
        [property],
      );
      const onlyUnverified = await port.getDashboardMetrics({
        ...period,
        previousPeriodStart: "2026-09-01",
        previousPeriodEnd: "2026-09-07",
      });
      expect(onlyUnverified?.current).toMatchObject({
        bookingCount: 1,
        unverifiedBookingCount: 1,
        totalRevenue: { amountDecimal: "0.00" },
      });
    } finally {
      await pool.query("DELETE FROM booking.guest_bookings WHERE property_id=$1", [property]);
      await pool.query("DELETE FROM hotel_catalog.property_locations WHERE property_id=$1", [
        property,
      ]);
      await pool.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [property]);
      await pool.end();
    }
  });
});
