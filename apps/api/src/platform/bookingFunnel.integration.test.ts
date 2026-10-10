import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTargetBookingDashboardMetricsReadPort } from "./bookingDashboard.js";

const connectionString = process.env["TEST_DATABASE_URL"];
describe.skipIf(!connectionString)("target Booking funnel PostgreSQL scope", () => {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const propertyId = randomUUID();
  const otherId = randomUUID();
  const readPort = createTargetBookingDashboardMetricsReadPort({
    connectionString: connectionString ?? "disabled",
    pool,
  });
  beforeAll(async () => {
    if (!/(test|verify)/i.test(new URL(connectionString!).pathname))
      throw new Error("Unsafe test database");
    await pool.query("BEGIN");
    for (const id of [propertyId, otherId]) {
      await pool.query(
        "INSERT INTO hotel_catalog.properties (id, public_id, display_name, profile_status) VALUES ($1::uuid, $1::text, 'Funnel test', 'complete')",
        [id],
      );
      await pool.query(
        "INSERT INTO hotel_catalog.property_locations (property_id, timezone) VALUES ($1, 'America/New_York')",
        [id],
      );
    }
    for (const [id, session, at, metadata, traffic, stage] of [
      [propertyId, "human", "2026-03-08T05:00:00Z", {}, "human", "page_visit"],
      [propertyId, "last", "2026-03-09T03:59:59Z", {}, "human", "page_visit"],
      [propertyId, "before", "2026-03-08T04:59:59Z", {}, "human", "page_visit"],
      [propertyId, "after", "2026-03-09T04:00:00Z", {}, "human", "page_visit"],
      [propertyId, "test", "2026-03-08T12:00:00Z", { isTestData: true }, "human", "page_visit"],
      [propertyId, "bot", "2026-03-08T12:00:00Z", {}, "bot", "page_visit"],
      [otherId, "other", "2026-03-08T12:00:00Z", {}, "human", "page_visit"],
      // A room-detail view is tracked but neither required nor counted as a stage (VAY-2074).
      [propertyId, "human", "2026-03-08T05:01:00Z", { funnelSequence: 2 }, "human", "room_viewed"],
      [
        propertyId,
        "human",
        "2026-03-08T05:02:00Z",
        { funnelSequence: 3 },
        "human",
        "rate_selected",
      ],
      [propertyId, "last", "2026-03-09T03:59:59Z", { funnelSequence: 2 }, "human", "rate_selected"],
    ] as const) {
      await pool.query(
        `INSERT INTO platform.domain_events
        (source_system, event_key, event_type, occurred_at, tenant_scope, property_id,
         resource_product, resource_type, resource_id, payload, event_metadata)
        VALUES ('distribution', $1, $6, $2, 'property', $3,
          'distribution', 'booking_web_hotel', 'funnel-test', $4, $5)`,
        [
          randomUUID(),
          at,
          id,
          JSON.stringify({
            sessionId: session,
            metadata: { funnelVersion: 1, funnelSequence: 1, ...metadata },
          }),
          JSON.stringify({ trafficClass: traffic }),
          `booking_web.${stage}`,
        ],
      );
    }
  });
  afterAll(async () => {
    await pool.query("ROLLBACK");
    await pool.end();
  });

  it("uses the IANA timezone across DST, excludes bot/test evidence and other properties", async () => {
    const funnel = await readPort.getConversionFunnel({
      propertyId,
      windowStart: "2026-03-08",
      windowEnd: "2026-03-08",
    });
    expect(funnel?.steps[0]?.count).toBe(2);
    expect(funnel?.steps[1]).toMatchObject({ stage: "rate_selected", count: 2 });
    expect(funnel?.steps).toHaveLength(6);
    expect(funnel?.biggestDrop).toBe("details_completed");
    const empty = await readPort.getConversionFunnel({
      propertyId,
      windowStart: "2026-03-01",
      windowEnd: "2026-03-01",
    });
    expect(empty?.steps.every((step) => step.count === 0)).toBe(true);
  });

  it("shows add-ons only when public active definitions and the property flag both allow them", async () => {
    const input = { propertyId, windowStart: "2026-03-08", windowEnd: "2026-03-08" };
    await pool.query("INSERT INTO booking.booking_settings (property_id) VALUES ($1)", [
      propertyId,
    ]);
    await pool.query(
      "INSERT INTO booking.addon_definitions (property_id, name, pricing_model, currency) VALUES ($1, 'Breakfast', 'per_guest', 'USD')",
      [propertyId],
    );
    expect((await readPort.getConversionFunnel(input))?.steps).toHaveLength(7);
    await pool.query(
      "UPDATE booking.booking_settings SET show_addons_step = FALSE WHERE property_id = $1",
      [propertyId],
    );
    expect((await readPort.getConversionFunnel(input))?.steps).toHaveLength(6);
  });

  it("omits test/demo properties and rejects missing properties or timezones", async () => {
    await pool.query(
      "UPDATE hotel_catalog.properties SET profile_status = 'disabled' WHERE id = $1",
      [propertyId],
    );
    expect(
      (
        await readPort.getConversionFunnel({
          propertyId,
          windowStart: "2026-03-08",
          windowEnd: "2026-03-08",
        })
      )?.steps[0]?.count,
    ).toBe(0);
    expect(
      await readPort.getConversionFunnel({
        propertyId: randomUUID(),
        windowStart: "2026-03-08",
        windowEnd: "2026-03-08",
      }),
    ).toBeNull();
    await pool.query(
      "UPDATE hotel_catalog.property_locations SET timezone = NULL WHERE property_id = $1",
      [propertyId],
    );
    await expect(
      readPort.getConversionFunnel({
        propertyId,
        windowStart: "2026-03-08",
        windowEnd: "2026-03-08",
      }),
    ).rejects.toThrow("timezone");
  });
});
