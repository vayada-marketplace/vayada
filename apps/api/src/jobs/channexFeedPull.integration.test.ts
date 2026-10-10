import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueChannexFeedPulls, runChannexFeedPulls } from "./channexFeedPull.js";

const URL = process.env["TEST_DATABASE_URL"];
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Refusing non-test database");

// VAY-2108: the scheduled feed pull reads only owned, allowlisted hotels and queues ingest jobs.
const OWNED = "21082000-0000-4000-8000-000000000001";
const UNLISTED = "21082000-0000-4000-8000-000000000002";
const REVOKED = "21082000-0000-4000-8000-000000000003";
const REBOUND = "21082000-0000-4000-8000-000000000004";
const PROPERTIES = [OWNED, UNLISTED, REVOKED, REBOUND];
const external = (property: string) => `chx-pull-${property.slice(-1)}`;
const NOW = new Date("2026-10-10T10:02:00.000Z");
const FEED = "https://app.channex.io/api/v1/booking_revisions/feed";

describe.skipIf(!URL)("Channex scheduled booking-feed pull (PostgreSQL)", () => {
  const db = new pg.Pool({ connectionString: URL ?? "postgresql://disabled", max: 2 });
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    const property = new globalThis.URL(String(input)).searchParams.get("filter[property_id]");
    return Response.json({
      data:
        property === external(OWNED)
          ? [
              revision("rev-1", "booking-1"),
              { id: "rev-bad", attributes: {} },
              revision("rev-2", "booking-2"),
            ]
          : [],
    });
  };
  const options = {
    apiBaseUrl: "https://app.channex.io",
    apiKey: "secret",
    ownedPropertyIds: [OWNED, REVOKED, REBOUND],
    excludedIds: [],
    workerId: "vay-2108-pull",
    fetch: fetcher,
    now: () => NOW,
  };

  beforeAll(async () => {
    await cleanup();
    for (const property of PROPERTIES) {
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,$2,'VAY-2108 pull')",
        [property, `vay-2108-pull-${property.slice(-1)}`],
      );
      await db.query(
        `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source)
         VALUES($1,'channex',$2,'active','repair')`,
        [property, external(property)],
      );
      await db.query(
        `INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id)
         VALUES($1,'channex','connected',$2)`,
        [property, external(property)],
      );
    }
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("queues one pull per owned, allowlisted hotel and bucket, and cancels older buckets", async () => {
    const earlier = new Date(NOW.getTime() - 5 * 60_000);
    expect(await enqueueChannexFeedPulls(db, { ...options, now: earlier })).toBe(3);
    expect(await enqueueChannexFeedPulls(db, { ...options, now: NOW })).toBe(3);
    expect(await enqueueChannexFeedPulls(db, { ...options, now: NOW })).toBe(0);
    expect(await enqueueChannexFeedPulls(db, { ...options, ownedPropertyIds: [], now: NOW })).toBe(
      0,
    );
    expect(await pullJobs()).toEqual([
      [OWNED, "canceled"],
      [OWNED, "pending"],
      [REVOKED, "canceled"],
      [REVOKED, "pending"],
      [REBOUND, "canceled"],
      [REBOUND, "pending"],
    ]);
  });

  it("never lets another Channex host take the pulls", async () => {
    const staging = await runChannexFeedPulls(URL!, {
      ...options,
      apiBaseUrl: "https://staging.channex.io",
      ownedPropertyIds: [OWNED],
      // Queue nothing for staging here: only the claim side is under test.
      excludedIds: [OWNED],
    });
    expect(staging).toMatchObject({ pulled: 0, failed: 0 });
    expect(calls).toEqual([]);
  });

  it("pulls owned hotels, isolates a bad revision and refuses a changed binding", async () => {
    await db.query(
      "UPDATE pms.channel_binding_claims SET claim_state='released' WHERE property_id=$1",
      [REVOKED],
    );
    await db.query(
      "UPDATE pms.channel_connections SET binding_generation = gen_random_uuid() WHERE property_id=$1",
      [REBOUND],
    );
    const counters = await runChannexFeedPulls(URL!, options);
    // The rebound hotel gets a fresh pull for its new binding; the old binding's pull is refused.
    expect(counters).toMatchObject({ queued: 1, pulled: 1, failed: 3, revisions: 2 });
    expect(
      new Set(counters.failures.map((failure) => `${failure.propertyId}:${failure.code}`)),
    ).toEqual(
      new Set([
        `${OWNED}:revision_failed`,
        `${REVOKED}:connection_not_owned`,
        `${REBOUND}:connection_not_owned`,
      ]),
    );
    const read = (property: string) =>
      `GET ${FEED}?filter%5Bproperty_id%5D=${external(property)}&order%5Binserted_at%5D=asc&pagination%5Blimit%5D=100`;
    expect(new Set(calls)).toEqual(new Set([read(OWNED), read(REBOUND)]));
    const failed = await db.query(
      `SELECT job_metadata->'failedRevisionIds' AS ids FROM platform.jobs
       WHERE job_type='channex.pull-booking-feed' AND property_id=$1 AND status='failed'`,
      [OWNED],
    );
    expect(failed.rows).toEqual([{ ids: ["rev-bad"] }]);
    const ingest = await db.query<{ booking: string; source: string; pull: boolean }>(
      `SELECT payload->>'channelBookingId' AS booking, payload->>'revisionSource' AS source,
         (payload->>'pullRequired')::boolean AS pull
       FROM platform.jobs WHERE job_type='channex.ingest-booking' AND payload->>'propertyId'=$1 ORDER BY 1`,
      [OWNED],
    );
    expect(ingest.rows).toEqual([
      { booking: "booking-1", source: "revision_feed", pull: false },
      { booking: "booking-2", source: "revision_feed", pull: false },
    ]);
  });

  async function pullJobs() {
    const rows = await db.query<{ property: string; status: string }>(
      `SELECT property_id::text AS property, status FROM platform.jobs
       WHERE job_type='channex.pull-booking-feed' AND property_id = ANY($1::uuid[]) ORDER BY 1, 2`,
      [PROPERTIES],
    );
    return rows.rows.map((row) => [row.property, row.status]);
  }

  function revision(id: string, bookingId: string) {
    return {
      id,
      type: "booking_revision",
      attributes: {
        property_id: external(OWNED),
        booking_id: bookingId,
        status: "new",
        arrival_date: "2026-11-01",
        departure_date: "2026-11-03",
        amount: "120.00",
        currency: "EUR",
        inserted_at: "2026-10-10T10:00:00.000Z",
        rooms: [
          {
            room_type_id: "provider-room",
            rate_plan_id: "provider-rate",
            occupancy: { adults: 1, children: 0 },
          },
        ],
      },
    };
  }

  async function cleanup() {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role=replica");
      // Booking receipts and their domain events carry the target property id in their keys.
      const patterns = PROPERTIES.map((property) => `%${property}%`);
      await client.query(
        `DELETE FROM platform.idempotency_keys WHERE response_resource_type = 'external_webhook_event'
           AND response_resource_id IN (SELECT id::text FROM platform.external_webhook_events
             WHERE provider = 'channex' AND provider_event_id LIKE ANY($1::text[]))`,
        [patterns],
      );
      await client.query(
        "DELETE FROM platform.external_webhook_events WHERE provider = 'channex' AND provider_event_id LIKE ANY($1::text[])",
        [patterns],
      );
      await client.query(
        "DELETE FROM platform.domain_events WHERE event_key LIKE ANY($1::text[])",
        [patterns],
      );
      const jobs = `SELECT id FROM platform.jobs WHERE property_id = ANY($1::uuid[])
        OR payload->>'propertyId' = ANY($1::text[])`;
      await client.query(`DELETE FROM platform.job_attempts WHERE job_id IN (${jobs})`, [
        PROPERTIES,
      ]);
      await client.query(`DELETE FROM platform.jobs WHERE id IN (${jobs})`, [PROPERTIES]);
      for (const table of ["pms.channel_connections", "pms.channel_binding_claims"])
        await client.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [
          PROPERTIES,
        ]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        PROPERTIES,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});
