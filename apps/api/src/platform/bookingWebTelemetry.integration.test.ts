import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHotelSetupOrdinaryLoginFixture } from "../hotelSetupOrdinaryLogin.fixture.js";
import { createPgBookingWebEventSink } from "./bookingWebEvents.js";

const URL = process.env["TEST_DATABASE_URL"];
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

// VAY-2212: Booking Web's funnel events go to distribution.booking_web_events, never to the
// append-only event log, and the API login may write, read and prune them.
describe.skipIf(!URL)("PostgreSQL Booking Web funnel event storage", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const property = randomUUID();
  const rows = () =>
    admin.query(
      `SELECT event_type AS "eventType", event_id AS "eventId", session_id AS "sessionId",
         metadata, traffic_class AS "trafficClass", occurred_at AS "occurredAt"
       FROM distribution.booking_web_events WHERE property_id=$1`,
      [property],
    );

  beforeAll(async () => {
    await admin.connect();
    await admin.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Telemetry hotel')",
      [property],
    );
  });

  afterAll(async () => {
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [property]);
    await admin.end();
  });

  it("stores each event once in its own table and nothing for bots", async () => {
    // The sink's pool is never closed in the API either; one connection, ended with the run.
    const sink = createPgBookingWebEventSink({ connectionString: URL!, max: 1 });
    const event = {
      propertyId: property,
      hotelSlug: "telemetry-hotel",
      eventType: "booking_completed",
      eventId: randomUUID(),
      sessionId: randomUUID(),
      occurredAt: new Date("2026-10-15T12:00:00.000Z"),
      userAgent: "Mozilla/5.0 Safari/605.1.15",
      metadata: {
        funnelVersion: 1,
        funnelSequence: 7,
        paymentMethod: "pay_at_property",
        outcome: "confirmed",
      },
    };
    const logRows = async () =>
      Number(
        (
          await admin.query("SELECT count(*) FROM platform.domain_events WHERE property_id=$1", [
            property,
          ])
        ).rows[0].count,
      );
    const logBefore = await logRows();

    await sink.recordTelemetryEvent(event);
    await sink.recordTelemetryEvent(event);
    await sink.recordTelemetryEvent({
      ...event,
      eventId: randomUUID(),
      userAgent: "Googlebot/2.1",
    });

    expect((await rows()).rows).toEqual([
      {
        eventType: "booking_completed",
        eventId: event.eventId,
        sessionId: event.sessionId,
        metadata: event.metadata,
        trafficClass: "human",
        occurredAt: event.occurredAt,
      },
    ]);
    expect(await logRows()).toBe(logBefore);
  });

  it("lets a login shaped like the production API role write, read and prune the table", async () => {
    const login = await createHotelSetupOrdinaryLoginFixture(admin, URL!);
    const pool = new pg.Pool({ connectionString: login.connectionString, max: 1 });
    try {
      const count = async () =>
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM distribution.booking_web_events WHERE property_id=$1",
            [property],
          )
        ).rows[0].count as number;
      const before = await count();
      await pool.query(
        `INSERT INTO distribution.booking_web_events
           (property_id, event_type, event_id, session_id, metadata, occurred_at)
         VALUES ($1::uuid, 'page_visit', $2::uuid, $3::uuid, '{"funnelVersion":1}', now())
         ON CONFLICT (property_id, event_id) DO NOTHING`,
        [property, randomUUID(), randomUUID()],
      );
      expect(await count()).toBe(before + 1);
      await expect(
        pool.query("DELETE FROM distribution.booking_web_events WHERE property_id=$1", [property]),
      ).resolves.toMatchObject({ rowCount: before + 1 });
    } finally {
      await pool.end();
      await login.drop();
    }
  }, 60_000);
});
