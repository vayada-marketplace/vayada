import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgProviderWebhookStore } from "../platform/providerWebhooks.js";
import { runChannexBookingJobs } from "./channexBookings.js";
import { createPgPmsChannexManagementWorkerStore } from "./pmsChannexManagementWorkerStore.js";

const URL = process.env["TEST_DATABASE_URL"];
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Refusing non-test database");

// VAY-2108: Channex routing follows the active claim; writes also need the connected binding.
const OWNED = "21080000-0000-4000-8000-000000000001";
const RELEASED = "21080000-0000-4000-8000-000000000002";
const CLAIM_ONLY = "21080000-0000-4000-8000-000000000003";
const RESERVED = "21080000-0000-4000-8000-000000000004";
const PROPERTIES = [OWNED, RELEASED, CLAIM_ONLY, RESERVED];
const external = (property: string) =>
  property === RESERVED ? "46906724-72cb-4acf-a2eb-b740a3bdbcf7" : `chx-${property.slice(-4)}`;

describe.skipIf(!URL)("Channex per-hotel ownership gate (PostgreSQL)", () => {
  const db = new pg.Pool({ connectionString: URL ?? "postgresql://disabled", max: 2 });
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response(null, { status: 204 });
  };

  beforeAll(async () => {
    await cleanup();
    for (const property of PROPERTIES) {
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,$2,'VAY-2108 gate')",
        [property, `vay-2108-${property.slice(-4)}`],
      );
      await db.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Athens')",
        [property],
      );
      await db.query(
        `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source)
         VALUES($1,'channex',$2,'active','repair')`,
        [property, external(property)],
      );
      // The binding-claim trigger only admits a connected row while its claim is active.
      await db.query(
        `INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id)
         VALUES($1,'channex',$2,$3)`,
        [
          property,
          property === CLAIM_ONLY ? "disconnected" : "connected",
          property === CLAIM_ONLY ? null : external(property),
        ],
      );
    }
    await db.query(
      "UPDATE pms.channel_binding_claims SET claim_state='released' WHERE property_id=$1",
      [RELEASED],
    );
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("routes provider events by the active claim, never by a connection alone", async () => {
    const store = createPgProviderWebhookStore({ connectionString: URL!, channexExcludedIds: [] });
    const byDefault = createPgProviderWebhookStore({ connectionString: URL! });
    const byProperty = createPgProviderWebhookStore({
      connectionString: URL!,
      channexExcludedIds: [OWNED],
    });
    try {
      expect(await store.resolveChannexPropertyId!(external(OWNED))).toBe(OWNED);
      expect(await store.resolveChannexPropertyId!(external(RELEASED))).toBeNull();
      // A claimed hotel keeps its receipts while its connection is down; jobs re-check it.
      expect(await store.resolveChannexPropertyId!(external(CLAIM_ONLY))).toBe(CLAIM_ONLY);
      expect(await store.resolveChannexPropertyId!(external(RESERVED))).toBe(RESERVED);
      // The reserved staging/test ids are excluded unless a caller opts out (staging Channex).
      expect(await byDefault.resolveChannexPropertyId!(external(RESERVED))).toBeNull();
      expect(await byProperty.resolveChannexPropertyId!(external(OWNED))).toBeNull();
    } finally {
      await Promise.all([store, byDefault, byProperty].map((item) => item.close!()));
    }
  });

  // The owned happy path is channexBookings.integration.test.ts (its fixture is claimed and connected).
  it("refuses to ingest bookings for a released claim or a reserved test identity", async () => {
    const ids = [await job(RELEASED), await job(RESERVED)];
    const counters = await runChannexBookingJobs(URL!, {
      apiBaseUrl: "https://app.channex.io",
      apiKey: "secret",
      ownsMutation: () => true,
      fetch: fetcher,
      workerId: "vay-2108",
      limit: 2,
    });
    expect(counters).toEqual({ succeeded: 0, retryScheduled: 2, deadLettered: 0 });
    for (const id of ids) expect(await failure(id)).toBe("connection_not_owned");
    const bookings = await db.query(
      "SELECT 1 FROM booking.guest_bookings WHERE property_id = ANY($1::uuid[])",
      [PROPERTIES],
    );
    expect(bookings.rowCount).toBe(0);
    expect(calls).toEqual([]);
  });

  it("claims booking jobs only for allowlisted hotels under the claimed scope", async () => {
    const id = await job(OWNED);
    const counters = await runChannexBookingJobs(URL!, {
      apiBaseUrl: "https://app.channex.io",
      apiKey: "secret",
      ownsMutation: () => true,
      fetch: fetcher,
      workerId: "vay-2108",
      limit: 1,
      ownedPropertyIds: [CLAIM_ONLY],
    });
    expect(counters).toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 0 });
    const row = await db.query("SELECT status FROM platform.jobs WHERE id = $1::uuid", [id]);
    expect(row.rows[0]).toEqual({ status: "pending" });
    // Allowlisted, the same job is claimed (it then fails on the fixture's missing room mapping).
    await runChannexBookingJobs(URL!, {
      apiBaseUrl: "https://app.channex.io",
      apiKey: "secret",
      ownsMutation: () => true,
      fetch: fetcher,
      workerId: "vay-2108",
      limit: 1,
      ownedPropertyIds: [OWNED],
    });
    const claimed = await db.query("SELECT attempts_count FROM platform.jobs WHERE id = $1::uuid", [
      id,
    ]);
    expect(claimed.rows[0]).toEqual({ attempts_count: 1 });
  });

  it("enqueues the daily full ARI sync only for owned, unreserved hotels", async () => {
    // One store per property: the staging property scope keeps the producer and the claim on it.
    for (const property of PROPERTIES) {
      const store = createPgPmsChannexManagementWorkerStore({
        connectionString: URL!,
        targetState: { succeed: async () => undefined, fail: async () => undefined },
        ariSyncMutating: true,
        stagingRestrictionsPropertyId: property,
      });
      try {
        await store.claim({ workerId: "vay-2108", now: new Date() });
      } finally {
        await store.close?.();
      }
    }
    const queued = await db.query<{ propertyId: string }>(
      `SELECT property_id::text AS "propertyId" FROM platform.jobs
       WHERE queue_name='pms.channex.management' AND job_key LIKE 'channex.ari:%:full:%'
         AND property_id = ANY($1::uuid[]) ORDER BY 1`,
      [PROPERTIES],
    );
    expect(queued.rows.map((row) => row.propertyId)).toEqual([OWNED]);
  });

  let sequence = 0;
  async function job(property: string) {
    const bookingId = `booking-${++sequence}`;
    const revision = {
      id: `rev-${sequence}`,
      type: "booking_revision",
      attributes: {
        property_id: external(property),
        booking_id: bookingId,
        status: "new",
        arrival_date: "2026-11-01",
        departure_date: "2026-11-03",
        amount: "120.00",
        currency: "EUR",
        inserted_at: "2026-10-10T12:00:00.000Z",
        ota_name: "BookingCom",
        customer: { name: "Ada", surname: "Guest" },
        rooms: [
          {
            room_type_id: "provider-room",
            rate_plan_id: "provider-rate",
            occupancy: { adults: 1, children: 0 },
            days: { "2026-11-01": "60.00", "2026-11-02": "60.00" },
          },
        ],
      },
    };
    const row = await db.query<{ id: string }>(
      `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,resource_product,resource_type,resource_id,correlation_id,max_attempts,payload)
       VALUES($1,'pms.channex.webhooks','channex.ingest-booking','external','pms','channel_booking',$2,'vay-2108',5,$3)
       RETURNING id::text`,
      [
        `vay-2108:${sequence}`,
        bookingId,
        {
          propertyId: property,
          providerPropertyId: external(property),
          channelBookingId: bookingId,
          revision: revision.id,
          revisionSource: "revision_feed",
          pullRequired: false,
          rawPayload: { event: "booking", payload: revision },
        },
      ],
    );
    return row.rows[0]!.id;
  }

  async function failure(id: string) {
    const row = await db.query<{ code: string | null }>(
      "SELECT job_metadata->>'lastErrorCode' AS code FROM platform.jobs WHERE id=$1::uuid",
      [id],
    );
    return row.rows[0]?.code ?? null;
  }

  async function cleanup() {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role=replica");
      const jobs = `SELECT id FROM platform.jobs WHERE property_id = ANY($1::uuid[])
        OR payload->>'propertyId' = ANY($1::text[]) OR job_key LIKE 'vay-2108:%'`;
      await client.query(`DELETE FROM platform.product_audit_events WHERE job_id IN (${jobs})`, [
        PROPERTIES,
      ]);
      await client.query(`DELETE FROM platform.dead_letter_events WHERE job_id IN (${jobs})`, [
        PROPERTIES,
      ]);
      await client.query(`DELETE FROM platform.job_attempts WHERE job_id IN (${jobs})`, [
        PROPERTIES,
      ]);
      await client.query(`DELETE FROM platform.jobs WHERE id IN (${jobs})`, [PROPERTIES]);
      for (const table of [
        "booking.guest_bookings",
        "pms.channel_connections",
        "pms.channel_binding_claims",
        "hotel_catalog.property_locations",
      ])
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
