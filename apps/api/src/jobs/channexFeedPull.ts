import pg from "pg";
import { createPgProviderWebhookStore } from "../platform/providerWebhooks.js";
import { promotePulledChannexBookingRevision } from "../routes/providerWebhooks.js";

// VAY-2108: the scheduled Channex booking-feed pull for hotels the target owns under the claimed
// scope (engineering/channex-per-hotel-ownership.md). Legacy acknowledges what it pulls, so a hotel
// is owned, and pulled, only after its handover, which requires legacy's disable for it. Pulled
// revisions become ordinary revision_feed ingest jobs; that worker persists and acknowledges them.
// The same loop runs the one-off resync the attach executor queues: the hotel's upcoming bookings,
// which legacy already acknowledged, read from the bookings collection instead of the feed.
const QUEUE = "pms.channex.webhooks";
const TYPE = "channex.pull-booking-feed";
const RESYNC_TYPE = "channex.resync-bookings";
const BUCKET_MS = 5 * 60_000;
const PAGE_SIZE = 100;
/** A resync reads at most this many upcoming bookings; a larger hotel is split by hand. */
const RESYNC_MAX_BOOKINGS = 2_000;
const RESYNC_RETRY_MS = 5 * 60_000;

type Options = {
  apiBaseUrl: string;
  apiKey: string;
  ownedPropertyIds: readonly string[];
  excludedIds: readonly string[];
  workerId: string;
  fetch?: typeof fetch;
  now?: () => Date;
  limit?: number;
  signal?: AbortSignal;
};
type PullJob = {
  id: string;
  propertyId: string;
  providerPropertyId: string;
  bindingGeneration: string;
};

/**
 * Queues at most one pull per gated hotel and 5-minute bucket (replays are no-ops), cancels
 * older still-pending buckets, reaps pulls a crashed task left running and prunes old rows.
 * Jobs carry the Channex host, so a staging canary and production never take each other's.
 */
export async function enqueueChannexFeedPulls(
  pool: Pick<pg.Pool, "query">,
  input: Pick<Options, "ownedPropertyIds" | "excludedIds" | "apiBaseUrl"> & { now: Date },
): Promise<number> {
  if (!input.ownedPropertyIds.length) return 0;
  const owned = [...input.ownedPropertyIds];
  const bucket = String(Math.floor(input.now.getTime() / BUCKET_MS));
  const host = new URL(input.apiBaseUrl).host;
  const result = await pool.query(
    `INSERT INTO platform.jobs (job_key, queue_name, job_type, tenant_scope, property_id,
       resource_product, resource_type, resource_id, max_attempts, payload)
     SELECT $1 || ':' || $6 || ':' || c.property_id || ':' || c.binding_generation || ':' || $2,
       $3, $1, 'property', c.property_id, 'pms', 'channex_connection', c.property_id::text, 1,
       jsonb_build_object('propertyId', c.property_id::text, 'providerPropertyId',
         c.external_property_id, 'bindingGeneration', c.binding_generation::text, 'channexHost', $6)
     FROM pms.channel_connections c
     JOIN pms.channel_binding_claims claim ON claim.property_id = c.property_id
       AND claim.provider = c.provider AND claim.external_property_id = c.external_property_id
       AND claim.claim_state = 'active'
     WHERE c.provider = 'channex' AND c.connection_status = 'connected'
       AND c.property_id::text = ANY($4::text[])
       AND NOT (c.property_id::text = ANY($5::text[]) OR lower(c.external_property_id) = ANY($5::text[]))
     ON CONFLICT (queue_name, job_key) DO NOTHING`,
    [TYPE, bucket, QUEUE, owned, [...input.excludedIds], host],
  );
  await pool.query(
    `UPDATE platform.jobs SET status = 'canceled', finished_at = now(), updated_at = now()
     WHERE queue_name = $1 AND job_type = $2 AND property_id::text = ANY($3::text[])
       AND payload->>'channexHost' = $5 AND status = 'pending' AND job_key NOT LIKE '%:' || $4`,
    [QUEUE, TYPE, owned, bucket, host],
  );
  await pool.query(
    `UPDATE platform.jobs SET status = 'failed', finished_at = now(), locked_at = NULL,
       locked_by = NULL, updated_at = now(),
       job_metadata = job_metadata || '{"lastErrorCode":"worker_lease_expired"}'::jsonb
     WHERE queue_name = $1 AND job_type = $2 AND status = 'running'
       AND locked_at < now() - interval '1 hour'`,
    [QUEUE, TYPE],
  );
  await pool.query(
    `DELETE FROM platform.jobs WHERE queue_name = $1 AND job_type = $2
       AND status IN ('succeeded', 'failed', 'canceled') AND finished_at < now() - interval '2 days'`,
    [QUEUE, TYPE],
  );
  return result.rowCount ?? 0;
}

/** Queues due pulls, then runs them: one feed read per job, no acknowledgement here. */
export async function runChannexFeedPulls(connectionString: string, options: Options) {
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 });
  const store = createPgProviderWebhookStore({
    connectionString,
    max: 2,
    channexExcludedIds: options.excludedIds,
  });
  const counters = { queued: 0, pulled: 0, failed: 0, revisions: 0, resynced: 0, resyncFailed: 0 };
  const failures: Array<{ propertyId: string; code: string }> = [];
  try {
    counters.queued = await enqueueChannexFeedPulls(pool, {
      ...options,
      now: options.now?.() ?? new Date(),
    });
    for (let index = 0; index < (options.limit ?? 10) && !options.signal?.aborted; index += 1) {
      const job = await claim(pool, options);
      if (!job) break;
      try {
        const revisions = await readFeed(pool, job, options);
        // One revision that cannot be queued must not hold back the rest of the hotel's feed.
        const failedRevisionIds: string[] = [];
        for (const revision of revisions)
          await promotePulledChannexBookingRevision({
            store,
            propertyId: job.propertyId,
            providerPropertyId: job.providerPropertyId,
            revision,
          }).catch(() => failedRevisionIds.push(String(revision["id"] ?? "unknown")));
        counters.revisions += revisions.length - failedRevisionIds.length;
        if (failedRevisionIds.length) throw new PullFailure("revision_failed", failedRevisionIds);
        await finish(pool, job, options, "succeeded", { revisions: revisions.length });
        counters.pulled += 1;
      } catch (error) {
        // The next bucket pulls again; a failed pull is recorded, never retried in place.
        const failure = error instanceof PullFailure ? error : new PullFailure("pull_failed");
        await finish(pool, job, options, "failed", {
          lastErrorCode: failure.message,
          ...(failure.revisionIds.length
            ? { failedRevisionIds: failure.revisionIds.slice(0, 20) }
            : {}),
        });
        failures.push({ propertyId: job.propertyId, code: failure.message });
        counters.failed += 1;
      }
    }
    // One resync per tick: it reads every upcoming booking of the hotel.
    const resync = options.signal?.aborted ? null : await claim(pool, options, RESYNC_TYPE);
    if (resync) {
      try {
        const result = await resyncBookings(pool, store, resync, options);
        await finish(pool, resync, options, "succeeded", result);
        counters.resynced += 1;
      } catch (error) {
        const failure = error instanceof PullFailure ? error : new PullFailure("resync_failed");
        await finish(pool, resync, options, "failed", {
          lastErrorCode: failure.message,
          ...(failure.revisionIds.length
            ? { failedBookingIds: failure.revisionIds.slice(0, 20) }
            : {}),
        });
        failures.push({ propertyId: resync.propertyId, code: failure.message });
        counters.resyncFailed += 1;
      }
    }
    return { ...counters, failures };
  } finally {
    await Promise.all([pool.end(), store.close?.()]);
  }
}

class PullFailure extends Error {
  constructor(
    code: string,
    readonly revisionIds: string[] = [],
  ) {
    super(code);
  }
}

async function claim(pool: pg.Pool, options: Options, type = TYPE): Promise<PullJob | null> {
  // Pulls carry the Channex host; the attach executor queues a resync without one, so the
  // production worker (never a canary, which lists other hotels) takes it for its owned hotel.
  const row = (
    await pool.query<{ id: string; payload: Record<string, unknown> }>(
      `UPDATE platform.jobs SET status = 'running', attempts_count = attempts_count + 1,
         locked_at = now(), locked_by = $3, updated_at = now()
       WHERE id = (SELECT id FROM platform.jobs WHERE queue_name = $1 AND job_type = $2
         AND status = 'pending' AND run_after <= now() AND property_id::text = ANY($4::text[])
         AND ($2::text = $6::text OR payload->>'channexHost' = $5::text)
         ORDER BY run_after DESC, created_at DESC FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id::text, payload`,
      [
        QUEUE,
        type,
        options.workerId,
        [...options.ownedPropertyIds],
        new URL(options.apiBaseUrl).host,
        RESYNC_TYPE,
      ],
    )
  ).rows[0];
  if (!row) return null;
  return {
    id: row.id,
    propertyId: String(row.payload["propertyId"]),
    providerPropertyId: String(row.payload["providerPropertyId"]),
    bindingGeneration: String(row.payload["bindingGeneration"]),
  };
}

async function assertOwned(pool: pg.Pool, job: PullJob, options: Options) {
  // The binding must still be owned, and be the same binding the job was queued for.
  const owned = await pool.query(
    `SELECT 1 FROM pms.channel_connections c
     JOIN pms.channel_binding_claims claim ON claim.property_id = c.property_id
       AND claim.provider = c.provider AND claim.external_property_id = c.external_property_id
       AND claim.claim_state = 'active'
     WHERE c.property_id = $1::uuid AND c.provider = 'channex' AND c.external_property_id = $2
       AND c.binding_generation::text = $3 AND c.connection_status = 'connected'
       AND NOT (c.property_id::text = ANY($4::text[]) OR lower(c.external_property_id) = ANY($4::text[]))`,
    [job.propertyId, job.providerPropertyId, job.bindingGeneration, [...options.excludedIds]],
  );
  if (!owned.rowCount) throw new PullFailure("connection_not_owned");
}

/**
 * The switch-day copy: every booking of the hotel still in house or arriving, as its latest
 * revision, queued like a pulled revision. Legacy acknowledged these, so the feed never shows them.
 */
async function resyncBookings(
  pool: pg.Pool,
  store: ReturnType<typeof createPgProviderWebhookStore>,
  job: PullJob,
  options: Options,
) {
  await assertOwned(pool, job, options);
  // Yesterday in UTC covers every hotel timezone for in-house stays.
  const since = new Date((options.now?.() ?? new Date()).getTime() - 24 * 60 * 60_000)
    .toISOString()
    .slice(0, 10);
  const bookings: Array<{ id: string; revisionId: string }> = [];
  for (let page = 1; page <= RESYNC_MAX_BOOKINGS / PAGE_SIZE; page += 1) {
    const url = new URL("/api/v1/bookings", `${options.apiBaseUrl}/`);
    url.searchParams.set("filter[property_id]", job.providerPropertyId);
    url.searchParams.set("filter[departure_date][gte]", since);
    url.searchParams.set("pagination[page]", String(page));
    url.searchParams.set("pagination[limit]", String(PAGE_SIZE));
    const data = await read(url, options);
    for (const item of data) {
      const attributes = record(item["attributes"]) ?? {};
      // The collection filter is not documented for property_id: refuse another hotel's rows.
      if (String(attributes["property_id"] ?? "") !== job.providerPropertyId) continue;
      const revisionId = String(attributes["revision_id"] ?? "");
      if (!revisionId) throw new PullFailure("booking_without_revision", [String(item["id"])]);
      bookings.push({ id: String(item["id"]), revisionId });
    }
    if (data.length < PAGE_SIZE) break;
  }
  const failedBookingIds: string[] = [];
  let promoted = 0;
  for (const booking of bookings) {
    if (options.signal?.aborted) throw new PullFailure("worker_shutdown");
    try {
      const url = new URL(
        `/api/v1/booking_revisions/${encodeURIComponent(booking.revisionId)}`,
        `${options.apiBaseUrl}/`,
      );
      const revision = (await read(url, options, false))[0];
      if (!revision) throw new PullFailure("revision_missing");
      await promotePulledChannexBookingRevision({
        store,
        propertyId: job.propertyId,
        providerPropertyId: job.providerPropertyId,
        revision,
      });
      promoted += 1;
    } catch {
      failedBookingIds.push(booking.id);
    }
  }
  if (failedBookingIds.length) throw new PullFailure("booking_failed", failedBookingIds);
  return { bookings: bookings.length, promoted };
}

/** One Channex GET; `data` is a list (collections) or one object (a single revision). */
async function read(url: URL, options: Options, list = true) {
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(30_000);
    response = await (options.fetch ?? fetch)(url, {
      method: "GET",
      headers: { "user-api-key": options.apiKey },
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    throw new PullFailure("provider_unavailable");
  }
  if (!response.ok)
    throw new PullFailure(
      response.status === 429
        ? "rate_limited"
        : response.status >= 500
          ? "provider_unavailable"
          : "provider_rejected",
    );
  const data = ((await response.json().catch(() => null)) as { data?: unknown } | null)?.data;
  const items = list ? data : [data];
  if (!Array.isArray(items)) throw new PullFailure("invalid_feed");
  return items.filter((item): item is Record<string, unknown> => record(item) !== null);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readFeed(pool: pg.Pool, job: PullJob, options: Options) {
  await assertOwned(pool, job, options);
  const url = new URL("/api/v1/booking_revisions/feed", `${options.apiBaseUrl}/`);
  url.searchParams.set("filter[property_id]", job.providerPropertyId);
  url.searchParams.set("order[inserted_at]", "asc");
  url.searchParams.set("pagination[limit]", String(PAGE_SIZE));
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(30_000);
    response = await (options.fetch ?? fetch)(url, {
      method: "GET",
      headers: { "user-api-key": options.apiKey },
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    throw new PullFailure("provider_unavailable");
  }
  if (!response.ok)
    throw new PullFailure(
      response.status === 429
        ? "rate_limited"
        : response.status >= 500
          ? "provider_unavailable"
          : "provider_rejected",
    );
  const data = ((await response.json().catch(() => null)) as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new PullFailure("invalid_feed");
  return data.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

async function finish(
  pool: pg.Pool,
  job: PullJob,
  options: Options,
  status: "succeeded" | "failed",
  metadata: Record<string, unknown>,
) {
  // A failed resync waits for another attempt while it has one; pulls never retry in place.
  await pool.query(
    `UPDATE platform.jobs SET
       status = CASE WHEN $2 = 'failed' AND job_type = $5 AND attempts_count < max_attempts
         THEN 'pending' ELSE $2 END,
       run_after = CASE WHEN $2 = 'failed' AND job_type = $5 AND attempts_count < max_attempts
         THEN now() + ($6::bigint * interval '1 millisecond') ELSE run_after END,
       finished_at = CASE WHEN $2 = 'failed' AND job_type = $5 AND attempts_count < max_attempts
         THEN NULL ELSE now() END,
       locked_at = NULL, locked_by = NULL, updated_at = now(), job_metadata = job_metadata || $3::jsonb
     WHERE id = $1::uuid AND locked_by = $4`,
    [job.id, status, JSON.stringify(metadata), options.workerId, RESYNC_TYPE, RESYNC_RETRY_MS],
  );
}
