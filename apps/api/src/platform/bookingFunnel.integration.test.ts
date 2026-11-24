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
    // Sessions are the browser's random UUIDs; test traffic is its own class and bots are never
    // stored (VAY-2212).
    const sessions = new Map<string, string>();
    const session = (name: string) =>
      sessions.get(name) ?? sessions.set(name, randomUUID()).get(name)!;
    for (const [id, name, at, metadata, traffic, stage] of [
      [propertyId, "human", "2026-03-08T05:00:00Z", {}, "human", "page_visit"],
      [propertyId, "last", "2026-03-09T03:59:59Z", {}, "human", "page_visit"],
      [propertyId, "before", "2026-03-08T04:59:59Z", {}, "human", "page_visit"],
      [propertyId, "after", "2026-03-09T04:00:00Z", {}, "human", "page_visit"],
      [propertyId, "test", "2026-03-08T12:00:00Z", {}, "test", "page_visit"],
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
      // VAY-2594: a guest who picked dates but chose no room.
      [propertyId, "searcher", "2026-03-08T06:00:00Z", {}, "human", "page_visit"],
      [
        propertyId,
        "searcher",
        "2026-03-08T06:01:00Z",
        { funnelSequence: 2 },
        "human",
        "dates_searched",
      ],
    ] as const) {
      await pool.query(
        `INSERT INTO distribution.booking_web_events
        (property_id, event_type, event_id, session_id, metadata, traffic_class, occurred_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          stage,
          randomUUID(),
          session(name),
          JSON.stringify({ funnelVersion: 1, funnelSequence: 1, ...metadata }),
          traffic,
          at,
        ],
      );
    }
  });
  afterAll(async () => {
    await pool.query("ROLLBACK");
    await pool.end();
  });

  it("uses the IANA timezone across DST, excludes test traffic and other properties", async () => {
    const funnel = await readPort.getConversionFunnel({
      propertyId,
      windowStart: "2026-03-08",
      windowEnd: "2026-03-08",
    });
    expect(funnel?.steps[0]?.count).toBe(3);
    // The searcher, plus the two who chose a rate on the page's own dates.
    expect(funnel?.steps[1]).toMatchObject({ stage: "dates_searched", count: 3 });
    expect(funnel?.steps[2]).toMatchObject({ stage: "rate_selected", count: 2 });
    expect(funnel?.steps).toHaveLength(7);
    expect(funnel?.biggestDrop).toBe("details_completed");
    const empty = await readPort.getConversionFunnel({
      propertyId,
      windowStart: "2026-03-01",
      windowEnd: "2026-03-01",
    });
    expect(empty?.steps.every((step) => step.count === 0)).toBe(true);
  });

  it("counts human page visits per local day across DST, without test traffic or other hotels", async () => {
    const timeline = await readPort.getPageViewTimeline({
      propertyId,
      windowStart: "2026-03-08",
      windowEnd: "2026-03-09",
    });
    // New York: "before" is 7 March, "human", "last" and "searcher" are 8 March, "after" is 9 March.
    expect(timeline).toMatchObject({
      timeZone: "America/New_York",
      total: 4,
      previousTotal: 1,
      buckets: [
        { date: "2026-03-08", count: 3 },
        { date: "2026-03-09", count: 1 },
      ],
    });
  });

  it("counts anonymous page views from a hotel's first one on, and keeps them out of the funnel (VAY-2592)", async () => {
    const viewsId = randomUUID();
    await pool.query(
      "INSERT INTO hotel_catalog.properties (id, public_id, display_name, profile_status) VALUES ($1::uuid, $1::text, 'Page views test', 'complete')",
      [viewsId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.property_locations (property_id, timezone) VALUES ($1, 'America/New_York')",
      [viewsId],
    );
    const consented = randomUUID();
    for (const [type, at, sessionId, metadata] of [
      // Before the hotel's first anonymous page view, its consented visits are its page views.
      ["page_visit", "2026-03-10T15:00:00Z", randomUUID(), { funnelVersion: 1, funnelSequence: 1 }],
      ["page_view", "2026-03-11T15:00:00Z", null, {}],
      // From then on every load sends a page view, so a consented visit is not counted again.
      ["page_visit", "2026-03-11T15:00:01Z", consented, { funnelVersion: 1, funnelSequence: 1 }],
      ["rate_selected", "2026-03-11T15:01:00Z", consented, { funnelVersion: 1, funnelSequence: 2 }],
      ["page_view", "2026-03-11T16:00:00Z", null, {}],
    ] as const) {
      await pool.query(
        `INSERT INTO distribution.booking_web_events
          (property_id, event_type, event_id, session_id, metadata, occurred_at)
          VALUES ($1, $2, $3, $4, $5, $6)`,
        [viewsId, type, randomUUID(), sessionId, JSON.stringify(metadata), at],
      );
    }

    const timeline = await readPort.getPageViewTimeline({
      propertyId: viewsId,
      windowStart: "2026-03-10",
      windowEnd: "2026-03-11",
    });
    expect(timeline).toMatchObject({
      total: 3,
      buckets: [
        { date: "2026-03-10", count: 1 },
        { date: "2026-03-11", count: 2 },
      ],
    });
    const metrics = await readPort.getDashboardMetrics({
      propertyId: viewsId,
      periodStart: "2026-03-11",
      periodEnd: "2026-03-11",
      previousPeriodStart: "2026-03-10",
      previousPeriodEnd: "2026-03-10",
    });
    expect(metrics?.current.pageViewCount).toBe(2);
    expect(metrics?.previous.pageViewCount).toBe(1);
    // The funnel still starts from consented visits only.
    const funnel = await readPort.getConversionFunnel({
      propertyId: viewsId,
      windowStart: "2026-03-11",
      windowEnd: "2026-03-11",
    });
    expect(funnel?.steps[0]).toMatchObject({ stage: "page_visit", count: 1 });
    expect(funnel?.steps[2]).toMatchObject({ stage: "rate_selected", count: 1 });
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
    expect((await readPort.getConversionFunnel(input))?.steps).toHaveLength(8);
    await pool.query(
      "UPDATE booking.booking_settings SET show_addons_step = FALSE WHERE property_id = $1",
      [propertyId],
    );
    expect((await readPort.getConversionFunnel(input))?.steps).toHaveLength(7);
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
