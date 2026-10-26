import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "../hotelSetupOrdinaryLogin.fixture.js";
import {
  createPgBookingWebEventRetentionStore,
  startBookingWebEventRetentionWorker,
  type BookingWebEventRetentionStore,
} from "./bookingWebEventRetention.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = randomUUID();
// Dated long before any other suite's rows, so this run deletes only rows of its own era; a run
// from another suite at a later "now" would delete these, so CI runs this file on its own. The
// random millisecond in a whole day keeps this run's audit rows apart from earlier runs.
const ERA_END = "2001-01-01T00:00:00.000Z";
const NOW = new Date(Date.UTC(2000, 2, 15) + Math.floor(Math.random() * 86_400_000));
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

describe.skipIf(!URL)("PostgreSQL booking web event retention", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  let login: HotelSetupOrdinaryLoginFixture;
  let store: BookingWebEventRetentionStore;

  beforeAll(async () => {
    await admin.connect();
    // Rows a crashed earlier run left in this era would change the counts.
    await admin.query("DELETE FROM distribution.booking_web_events WHERE occurred_at < $1", [
      ERA_END,
    ]);
    await admin.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Retention hotel')",
      [PROPERTY],
    );
    // The job runs as a login shaped like the production API role: INSERT-only on the audit table.
    login = await createHotelSetupOrdinaryLoginFixture(admin, URL!);
    store = createPgBookingWebEventRetentionStore({ connectionString: login.connectionString });
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await login?.drop();
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [PROPERTY]);
    await admin.end();
  });

  it("deletes events older than 13 months in audited batches and keeps the rest", async () => {
    const ages = {
      expired: ["13 months 1 second", "13 months 1 day", "14 months", "2 years", "5 years"],
      kept: ["13 months", "12 months", "1 day"],
    };
    for (const age of [...ages.expired, ...ages.kept])
      await admin.query(
        `INSERT INTO distribution.booking_web_events
           (property_id,event_type,event_id,session_id,metadata,occurred_at)
         VALUES ($1,'page_visit',gen_random_uuid(),gen_random_uuid(),
           '{"funnelVersion":1,"funnelSequence":1}',$2::timestamptz - $3::interval)`,
        [PROPERTY, NOW.toISOString(), age],
      );

    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = startBookingWebEventRetentionWorker({
      store,
      enabled: false,
      intervalMs: 1_000,
      batchSize: 2,
      now: () => NOW,
      logger,
    });
    await worker.runNow();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith({ deleted: 5 }, "Deleted expired booking web events");

    const left = await admin.query<{ age: string }>(
      `SELECT age FROM unnest($3::text[]) AS age
       WHERE EXISTS (SELECT 1 FROM distribution.booking_web_events event
         WHERE event.property_id=$1 AND event.occurred_at = $2::timestamptz - age::interval)`,
      [PROPERTY, NOW.toISOString(), [...ages.expired, ...ages.kept]],
    );
    expect(left.rows.map((row) => row.age).sort()).toEqual([...ages.kept].sort());
    const total = await admin.query(
      "SELECT count(*)::int AS count FROM distribution.booking_web_events WHERE property_id=$1",
      [PROPERTY],
    );
    expect(total.rows[0].count).toBe(ages.kept.length);

    // Each batch wrote its own audit row in the same statement as its delete.
    const audits = await admin.query(
      `SELECT redacted_payload AS payload, tenant_scope AS scope, actor_type AS actor
       FROM platform.product_audit_events
       WHERE product='distribution' AND action='booking_web.events.retention_purged'
         AND occurred_at=$1
       ORDER BY (redacted_payload->>'deleted')::int DESC`,
      [NOW.toISOString()],
    );
    expect(audits.rows).toEqual(
      [2, 2, 1].map((deleted) => ({
        payload: { deleted, olderThan: "13 months" },
        scope: "platform",
        actor: "system",
      })),
    );

    // Nothing left to delete: no batch and no audit row.
    await expect(store.deleteExpiredBatch(NOW, 2)).resolves.toBe(0);
    const after = await admin.query(
      `SELECT count(*)::int AS count FROM platform.product_audit_events
       WHERE action='booking_web.events.retention_purged' AND occurred_at=$1`,
      [NOW.toISOString()],
    );
    expect(after.rows[0].count).toBe(3);
  });
});
