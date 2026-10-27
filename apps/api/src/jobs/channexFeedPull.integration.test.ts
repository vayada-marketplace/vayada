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
  let resyncTotal: number | null = null;
  let resyncListStatus: number | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    const url = new globalThis.URL(String(input));
    const property = url.searchParams.get("filter[property_id]");
    if (url.pathname === "/api/v1/bookings") {
      if (resyncListStatus) return new Response(null, { status: resyncListStatus });
      const page = Number(url.searchParams.get("pagination[page]"));
      const total = resyncTotal ?? resyncPages.reduce((sum, rows) => sum + rows.length, 0);
      return Response.json({
        data: resyncPages[page - 1] ?? [],
        meta: { page, total, limit: 100 },
      });
    }
    if (url.pathname.startsWith("/api/v1/booking_revisions/") && !url.pathname.endsWith("/feed")) {
      const id = url.pathname.split("/").at(-1)!;
      if (id === "rev-gone") return new Response(null, { status: 404 });
      if (id === "rev-limited") return new Response(null, { status: 429 });
      if (id === "rev-broken")
        return Response.json({ data: { id, attributes: { property_id: "elsewhere" } } });
      return Response.json({ data: revision(id, `booking-${id.slice(4)}`) });
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
           VALUES ($1, 'pms.channex.webhooks', 'channex.resync-bookings', 'property', $2::uuid, 'pms', 'channel_connection', $2::uuid::text, 3,
             jsonb_build_object('propertyId', $2::uuid::text, 'providerPropertyId', $3::text, 'bindingGeneration', $4::text))
           RETURNING id::text`,
          [
            `channex.resync-bookings:${property}:${bindingGeneration}${suffix}`,
            property,
            external(property),
            bindingGeneration,
          ],
        )
      ).rows[0]!.id;
    const jobRow = async (id: string) =>
      (
        await db.query(
          `SELECT status, attempts_count AS attempts, run_after > now() AS later, finished_at IS NOT NULL AS finished,
             payload->>'channexHost' AS host, job_metadata - 'lastErrorCode' AS metadata, job_metadata->>'lastErrorCode' AS code
           FROM platform.jobs WHERE id=$1`,
          [id],
        )
      ).rows[0];
    const booking = (id: string, revisionId: string, property = OWNED) => ({
      id,
      type: "booking",
      attributes: {
        property_id: external(property).toUpperCase(),
        revision_id: revisionId,
        status: "new",
      },
    });
    const run = (extra: Partial<typeof options> = {}) =>
      runChannexFeedPulls(URL!, {
        ...options,
        ownedPropertyIds: [OWNED],
        resyncPaceMs: 0,
        ...extra,
      });
    // Page one is full, so the runner reads page two; another hotel's row is skipped; the
    // collection's own ids are compared case-insensitively.
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
    // A canary on the staging host never takes a production hotel's resync.
    expect(await run({ apiBaseUrl: "https://staging.channex.io" })).toMatchObject({
      resynced: 0,
      resyncFailed: 0,
    });
    expect((await jobRow(job)).status).toBe("pending");
    expect(await run()).toMatchObject({ resynced: 1, resyncFailed: 0 });
    const listed = calls.filter((call) => call.includes("/api/v1/bookings?"));
    expect(listed).toEqual([
      `GET ${BOOKINGS}?filter%5Bproperty_id%5D=${external(OWNED)}&filter%5Bdeparture_date%5D%5Bgte%5D=2026-10-08&pagination%5Bpage%5D=1&pagination%5Blimit%5D=100`,
      `GET ${BOOKINGS}?filter%5Bproperty_id%5D=${external(OWNED)}&filter%5Bdeparture_date%5D%5Bgte%5D=2026-10-08&pagination%5Bpage%5D=2&pagination%5Blimit%5D=100`,
    ]);
    expect(calls.filter((call) => call.includes("/booking_revisions/rev-")).length).toBe(100);
    expect(await jobRow(job)).toMatchObject({
      status: "succeeded",
      host: "app.channex.io",
      metadata: { bookings: 100, promoted: 100, skipped: 1 },
    });
    const ingest = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.jobs WHERE job_type='channex.ingest-booking'
         AND payload->>'propertyId'=$1 AND payload->>'channelBookingId' LIKE 'booking-r%'`,
      [OWNED],
    );
    expect(ingest.rows[0]!.n).toBe(100);
    // A missing revision and a row without one fail the attempt; the resync waits for its next one.
    resyncPages = [
      [
        booking("booking-gone", "rev-gone"),
        { id: "booking-bare", attributes: { property_id: external(OWNED) } },
      ],
    ];
    const retry = await resyncJob(OWNED, generation, ":retry");
    expect(await run()).toMatchObject({
      resyncFailed: 1,
      failures: [{ propertyId: OWNED, code: "booking_failed" }],
    });
    expect(await jobRow(retry)).toMatchObject({
      status: "pending",
      attempts: 1,
      later: true,
      finished: false,
      code: "booking_failed",
      metadata: {
        bookings: 1,
        promoted: 0,
        skipped: 0,
        failedBookings: [
          { id: "booking-bare", code: "booking_without_revision" },
          { id: "booking-gone", code: "revision_missing" },
        ],
      },
    });
    // Channex pausing us, on the list or on a revision, gives the attempt back.
    resyncPages = [[booking("booking-limited", "rev-limited")]];
    const limited = await resyncJob(OWNED, generation, ":limited");
    resyncListStatus = 429;
    expect(await run()).toMatchObject({
      resyncFailed: 1,
      failures: [{ propertyId: OWNED, code: "rate_limited" }],
    });
    expect(await jobRow(limited)).toMatchObject({
      status: "pending",
      attempts: 0,
      code: "rate_limited",
    });
    resyncListStatus = null;
    await db.query("UPDATE platform.jobs SET run_after = now() WHERE id = $1", [limited]);
    expect(await run()).toMatchObject({
      resyncFailed: 1,
      failures: [{ propertyId: OWNED, code: "rate_limited" }],
    });
    expect(await jobRow(limited)).toMatchObject({
      status: "pending",
      attempts: 0,
      later: true,
      code: "rate_limited",
    });
    await db.query(
      "UPDATE platform.jobs SET status = 'succeeded', finished_at = now() WHERE id = $1",
      [limited],
    );
    // A run that exceeds its budget pauses, keeps what it queued, and the next runs finish the
    // rest without reading those revisions again; a revision the store refuses gets a fixed code.
    resyncPages = [
      [
        booking("booking-p1", "rev-p1"),
        booking("booking-p2", "rev-p2"),
        booking("booking-p3", "rev-broken"),
      ],
    ];
    const paused = await resyncJob(OWNED, generation, ":paused");
    expect(await run({ resyncBudgetMs: 0 })).toMatchObject({
      failures: [{ propertyId: OWNED, code: "resync_paused" }],
    });
    expect(await jobRow(paused)).toMatchObject({
      status: "pending",
      attempts: 0,
      metadata: { promoted: 1, resyncDone: ["booking-p1"] },
    });
    await db.query("UPDATE platform.jobs SET run_after = now() WHERE id = $1", [paused]);
    calls.length = 0;
    expect(await run({ resyncBudgetMs: 0 })).toMatchObject({
      failures: [{ propertyId: OWNED, code: "resync_paused" }],
    });
    expect(calls.filter((call) => call.includes("/booking_revisions/rev-p"))).toEqual([
      "GET https://app.channex.io/api/v1/booking_revisions/rev-p2",
    ]);
    await db.query("UPDATE platform.jobs SET run_after = now() WHERE id = $1", [paused]);
    expect(await run({ resyncBudgetMs: 0 })).toMatchObject({
      failures: [{ propertyId: OWNED, code: "booking_failed" }],
    });
    expect(await jobRow(paused)).toMatchObject({
      status: "pending",
      attempts: 1,
      metadata: {
        bookings: 3,
        promoted: 0,
        resyncDone: ["booking-p1", "booking-p2"],
        failedBookings: [{ id: "booking-p3", code: "promotion_failed" }],
      },
    });
    await db.query(
      "UPDATE platform.jobs SET status = 'succeeded', finished_at = now() WHERE id = $1",
      [paused],
    );
    // A run a crashed task left behind gets its next attempt (taken in the same tick here).
    await db.query(
      "UPDATE platform.jobs SET status = 'running', locked_at = now() - interval '3 hours', locked_by = 'crashed' WHERE id = $1",
      [retry],
    );
    expect(await run()).toMatchObject({
      resyncFailed: 1,
      failures: [{ propertyId: OWNED, code: "rate_limited" }],
    });
    expect(await jobRow(retry)).toMatchObject({
      status: "pending",
      attempts: 1,
      code: "rate_limited",
    });
    // Out of attempts, a crashed run fails.
    await db.query(
      "UPDATE platform.jobs SET status = 'running', attempts_count = 3, locked_at = now() - interval '3 hours', locked_by = 'crashed' WHERE id = $1",
      [retry],
    );
    expect(await run()).toMatchObject({ resynced: 0, resyncFailed: 0 });
    expect(await jobRow(retry)).toMatchObject({
      status: "failed",
      finished: true,
      code: "worker_lease_expired",
    });
    // The hotel beyond the cap and a stale binding fail at once.
    resyncPages = [[booking("booking-many", "rev-many")]];
    resyncTotal = 5_000;
    const large = await resyncJob(OWNED, generation, ":large");
    expect(await run()).toMatchObject({
      resyncFailed: 1,
      failures: [{ propertyId: OWNED, code: "resync_truncated" }],
    });
    expect(await jobRow(large)).toMatchObject({
      status: "failed",
      finished: true,
      metadata: { total: 5_000 },
    });
    resyncTotal = null;
    const stale = await resyncJob(OWNED, "00000000-0000-4000-8000-000000000000");
    expect(await run()).toMatchObject({
      resyncFailed: 1,
      failures: [{ propertyId: OWNED, code: "connection_not_owned" }],
    });
    expect(await jobRow(stale)).toMatchObject({ status: "failed", attempts: 1, finished: true });
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
