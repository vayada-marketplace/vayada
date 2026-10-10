import pg from "pg";
import { createPgProviderWebhookStore } from "../platform/providerWebhooks.js";
import { promotePulledChannexBookingRevision } from "../routes/providerWebhooks.js";

// VAY-2108: the scheduled Channex booking-feed pull for hotels the target owns under the claimed
// scope (engineering/channex-per-hotel-ownership.md). Legacy acknowledges what it pulls, so a hotel
// is owned, and pulled, only after its handover, which requires legacy's disable for it. Pulled
// revisions become ordinary revision_feed ingest jobs; that worker persists and acknowledges them.
const QUEUE = "pms.channex.webhooks";
const TYPE = "channex.pull-booking-feed";
const BUCKET_MS = 5 * 60_000;
const PAGE_SIZE = 100;

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
  const counters = { queued: 0, pulled: 0, failed: 0, revisions: 0 };
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

async function claim(pool: pg.Pool, options: Options): Promise<PullJob | null> {
  const row = (
    await pool.query<{ id: string; payload: Record<string, unknown> }>(
      `UPDATE platform.jobs SET status = 'running', attempts_count = attempts_count + 1,
         locked_at = now(), locked_by = $3, updated_at = now()
       WHERE id = (SELECT id FROM platform.jobs WHERE queue_name = $1 AND job_type = $2
         AND status = 'pending' AND run_after <= now() AND property_id::text = ANY($4::text[])
         AND payload->>'channexHost' = $5
         ORDER BY run_after DESC, created_at DESC FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id::text, payload`,
      [
        QUEUE,
        TYPE,
        options.workerId,
        [...options.ownedPropertyIds],
        new URL(options.apiBaseUrl).host,
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

async function readFeed(pool: pg.Pool, job: PullJob, options: Options) {
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
  await pool.query(
    `UPDATE platform.jobs SET status = $2, finished_at = now(), locked_at = NULL, locked_by = NULL,
       updated_at = now(), job_metadata = job_metadata || $3::jsonb
     WHERE id = $1::uuid AND locked_by = $4`,
    [job.id, status, JSON.stringify(metadata), options.workerId],
  );
}
