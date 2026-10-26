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
const BOOKINGS = "https://app.channex.io/api/v1/bookings";

describe.skipIf(!URL)("Channex scheduled booking-feed pull (PostgreSQL)", () => {
  const db = new pg.Pool({ connectionString: URL ?? "postgresql://disabled", max: 2 });
  const calls: string[] = [];
  let resyncPages: Array<Record<string, unknown>[]> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    const url = new globalThis.URL(String(input));
    const property = url.searchParams.get("filter[property_id]");
    if (url.pathname === "/api/v1/bookings")
      return Response.json({
        data: resyncPages[Number(url.searchParams.get("pagination[page]")) - 1] ?? [],
      });
    if (url.pathname.startsWith("/api/v1/booking_revisions/")) {
      const id = url.pathname.split("/").at(-1)!;
      return id === "rev-gone"
        ? new Response(null, { status: 404 })
        : Response.json({ data: revision(id, `booking-${id.slice(4)}`) });
    }
    return Response.json({
      data:
        property === external(OWNED)
          ? [
              revision("rev-1", "booking-1"),
              // Another provider property's revision: promotion refuses it.
              {
                id: "rev-bad",
                attributes: { property_id: "chx-pull-elsewhere", booking_id: "booking-bad" },
              },
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

  it("copies the upcoming bookings the attach executor asked for, once per binding", async () => {
    calls.length = 0;
    const generation = (
      await db.query<{ generation: string }>(
        "SELECT binding_generation::text AS generation FROM pms.channel_connections WHERE property_id=$1",
        [OWNED],
      )
    ).rows[0]!.generation;
    const resyncJob = async (property: string, bindingGeneration: string, suffix = "") =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO platform.jobs (job_key, queue_name, job_type, tenant_scope, property_id, resource_product,
             resource_type, resource_id, max_attempts, payload)
           VALUES ($1, 'pms.channex.webhooks', 'channex.resync-bookings', 'property', $2, 'pms', 'channel_connection', $2::text, 3,
             jsonb_build_object('propertyId', $2::text, 'providerPropertyId', $3, 'bindingGeneration', $4))
           RETURNING id::text`,
          [
            `channex.resync-bookings:${property}:${bindingGeneration}${suffix}`,
            property,
            external(property),
            bindingGeneration,
          ],
        )
      ).rows[0]!.id;
    const booking = (id: string, revisionId: string, property = OWNED) => ({
      id,
      type: "booking",
      attributes: { property_id: external(property), revision_id: revisionId, status: "new" },
    });
    // Page one is full, so the runner reads page two; another hotel's row is skipped.
    resyncPages = [
      [
        ...Array.from({ length: 98 }, (_, index) =>
          booking(`booking-r${index + 10}`, `rev-r${index + 10}`),
        ),
        booking("booking-elsewhere", "rev-elsewhere", UNLISTED),
        booking("booking-r1", "rev-r1"),
      ],
      [booking("booking-r2", "rev-r2")],
    ];
    const job = await resyncJob(OWNED, generation);
    const counters = await runChannexFeedPulls(URL!, { ...options, ownedPropertyIds: [OWNED] });
    expect(counters).toMatchObject({ resynced: 1, resyncFailed: 0 });
    const listed = calls.filter((call) => call.includes("/api/v1/bookings?"));
    expect(listed).toEqual([
      `GET ${BOOKINGS}?filter%5Bproperty_id%5D=${external(OWNED)}&filter%5Bdeparture_date%5D%5Bgte%5D=2026-10-09&pagination%5Bpage%5D=1&pagination%5Blimit%5D=100`,
      `GET ${BOOKINGS}?filter%5Bproperty_id%5D=${external(OWNED)}&filter%5Bdeparture_date%5D%5Bgte%5D=2026-10-09&pagination%5Bpage%5D=2&pagination%5Blimit%5D=100`,
    ]);
    expect(calls.filter((call) => call.includes("/booking_revisions/rev-")).length).toBe(100);
    const done = await db.query(
      "SELECT status, job_metadata->'bookings' AS bookings, job_metadata->'promoted' AS promoted FROM platform.jobs WHERE id=$1",
      [job],
    );
    expect(done.rows[0]).toEqual({ status: "succeeded", bookings: 100, promoted: 100 });
    const ingest = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.jobs WHERE job_type='channex.ingest-booking'
         AND payload->>'propertyId'=$1 AND payload->>'channelBookingId' LIKE 'booking-r%'`,
      [OWNED],
    );
    expect(ingest.rows[0]!.n).toBe(100);
    // A missing revision fails the resync, which waits for its next attempt; a stale binding is refused.
    resyncPages = [[booking("booking-gone", "rev-gone")]];
    const retry = await resyncJob(OWNED, generation, ":retry");
    expect(
      await runChannexFeedPulls(URL!, { ...options, ownedPropertyIds: [OWNED] }),
    ).toMatchObject({
      resyncFailed: 1,
      failures: [{ propertyId: OWNED, code: "booking_failed" }],
    });
    const waiting = await db.query(
      "SELECT status, attempts_count AS attempts, run_after > now() AS later, job_metadata->'failedBookingIds' AS ids FROM platform.jobs WHERE id=$1",
      [retry],
    );
    expect(waiting.rows[0]).toEqual({
      status: "pending",
      attempts: 1,
      later: true,
      ids: ["booking-gone"],
    });
    const stale = await resyncJob(OWNED, "00000000-0000-4000-8000-000000000000");
    await db.query("UPDATE platform.jobs SET max_attempts = 1 WHERE id = $1", [stale]);
    expect(
      await runChannexFeedPulls(URL!, { ...options, ownedPropertyIds: [OWNED] }),
    ).toMatchObject({
      resyncFailed: 1,
      failures: [{ propertyId: OWNED, code: "connection_not_owned" }],
    });
    expect(
      (await db.query("SELECT status FROM platform.jobs WHERE id=$1", [stale])).rows[0],
    ).toEqual({
      status: "failed",
    });
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
