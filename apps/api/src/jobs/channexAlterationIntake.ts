import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import type { createChannexAlterationFeed } from "../integrations/channexAlterationFeed.js";
import { persistChannexAlterationInTransaction } from "../domains/channexAlterationIntake.js";

const scopeSchema = z.object({
  propertyId: z.uuid(),
  connectionId: z.uuid(),
  bindingGeneration: z.uuid(),
  providerPropertyId: z.uuid(),
});
type Scope = z.infer<typeof scopeSchema>;
const queue = "pms.channex.webhooks",
  type = "channex.scan-alterations";
/** A page is one Channex list plus up to 20 reads of 30 s each: a lease older than this is dead. */
const LEASE_MINUTES = 15;

/** Default-off runtime integration must supply its explicit rollout property allowlist. */
export async function scheduleChannexAlterationScans(options: {
  pool: pg.Pool;
  propertyIds: readonly string[];
  ownsMutation: () => boolean;
  signal?: AbortSignal;
  limit?: number;
}): Promise<number> {
  const properties = z.array(z.uuid()).max(100).parse(options.propertyIds);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.limit ?? 25);
  const active = () => !options.signal?.aborted && options.ownsMutation();
  if (!properties.length || !active()) return 0;
  const client = await options.pool.connect();
  try {
    await client.query("BEGIN");
    const bindings = await client.query<Scope>(
      `SELECT connection.id AS "connectionId",connection.property_id AS "propertyId",
         connection.binding_generation AS "bindingGeneration",connection.external_property_id AS "providerPropertyId"
       FROM pms.channel_connections connection JOIN pms.channel_binding_claims claim
         ON claim.property_id=connection.property_id AND claim.provider='channex'
         AND claim.external_property_id=connection.external_property_id AND claim.claim_state='active'
       WHERE connection.provider='channex' AND connection.connection_status='connected'
         AND connection.property_id=ANY($1::uuid[]) AND NOT EXISTS (
           SELECT 1 FROM platform.jobs job WHERE job.queue_name=$2 AND job.job_type=$3
             AND job.resource_product='pms' AND job.property_id=connection.property_id
             AND ((job.resource_type='channel_connection' AND job.resource_id=connection.id::text)
               OR (job.resource_type='channel_property' AND job.resource_id=connection.property_id::text))
             AND job.payload->>'connectionId'=connection.id::text
             AND job.payload->>'bindingGeneration'=connection.binding_generation::text
             AND (job.status IN ('pending','running') OR
               (job.job_metadata->>'trigger'='periodic' AND job.created_at>now()-interval '15 minutes'))
         ) ORDER BY connection.property_id,connection.id LIMIT $4
       FOR UPDATE OF connection SKIP LOCKED FOR SHARE OF claim SKIP LOCKED`,
      [properties, queue, type, limit],
    );
    let scheduled = 0;
    for (const scope of bindings.rows) {
      if (!active()) return 0;
      // Fresh statement snapshot after the binding lock: another scheduler may have just committed.
      const result = await client.query(
        `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,property_id,
           resource_product,resource_type,resource_id,payload,job_metadata)
         SELECT $2 || ':' || $4 || ':' || $6 || ':periodic:' || floor(extract(epoch FROM now())/900)::text,
           $1,$2,'property',$3,'pms','channel_connection',$4,$5::jsonb,'{"page":1,"trigger":"periodic"}'
         WHERE NOT EXISTS (
           SELECT 1 FROM platform.jobs job WHERE job.queue_name=$1 AND job.job_type=$2
             AND job.resource_product='pms' AND job.property_id=$3
             AND ((job.resource_type='channel_connection' AND job.resource_id=$4)
               OR (job.resource_type='channel_property' AND job.resource_id=$3::text))
             AND job.payload->>'connectionId'=$4 AND job.payload->>'bindingGeneration'=$6
             AND (job.status IN ('pending','running') OR
               (job.job_metadata->>'trigger'='periodic' AND job.created_at>now()-interval '15 minutes'))
         ) ON CONFLICT(queue_name,job_key) DO NOTHING`,
        [
          queue,
          type,
          scope.propertyId,
          scope.connectionId,
          JSON.stringify(scope),
          scope.bindingGeneration,
        ],
      );
      scheduled += result.rowCount ?? 0;
    }
    if (!active()) return 0;
    await client.query("COMMIT");
    return scheduled;
  } finally {
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch {
      client.release(true);
    }
  }
}

/** Persist only our bounded diagnostic vocabulary, never upstream bodies or SQL. */
function scanFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^alteration_[a-z_]+$/.test(message) ? message : "alteration_scan_failed";
}

async function assertBinding(
  client: Pick<pg.Pool, "query">,
  scope: Scope,
  /** Inside a transaction, the share lock fences the binding until commit. */
  lock: "" | "FOR SHARE OF connection,claim" = "",
) {
  const result = await client.query(
    `SELECT connection.id FROM pms.channel_connections connection
     JOIN pms.channel_binding_claims claim ON claim.property_id=connection.property_id
       AND claim.provider='channex' AND claim.external_property_id=connection.external_property_id
       AND claim.claim_state='active'
     WHERE connection.id=$1 AND connection.property_id=$2 AND connection.provider='channex'
       AND connection.connection_status='connected' AND connection.external_property_id=$3
       AND connection.binding_generation=$4 ${lock}`,
    [scope.connectionId, scope.propertyId, scope.providerPropertyId, scope.bindingGeneration],
  );
  if (result.rowCount !== 1) throw new Error("alteration_scan_binding_changed");
}

/** Internal trigger; scanId is the durable triggering receipt/scheduled run UUID. */
export async function enqueueChannexAlterationScan(pool: pg.Pool, value: Scope, scanId: string) {
  const scope = scopeSchema.parse(value);
  z.uuid().parse(scanId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertBinding(client, scope, "FOR SHARE OF connection,claim");
    const jobKey = `${type}:${scope.connectionId}:${scope.bindingGeneration}:${scanId}`;
    await client.query(
      `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,property_id,
         resource_product,resource_type,resource_id,payload,job_metadata)
       VALUES($1,$2,$3,'property',$4,'pms','channel_connection',$5,$6::jsonb,'{"page":1}')
       ON CONFLICT(queue_name,job_key) DO NOTHING`,
      [jobKey, queue, type, scope.propertyId, scope.connectionId, JSON.stringify(scope)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** One page per durable job turn; runtime triggering remains disabled. */
export async function runChannexAlterationIntake(options: {
  pool: pg.Pool;
  provider: ReturnType<typeof createChannexAlterationFeed>;
  ownsMutation: () => boolean;
  propertyIds?: readonly string[];
  signal?: AbortSignal;
  limit?: number;
}) {
  const counts = { processed: 0, retried: 0, deadLettered: 0 };
  const properties =
    options.propertyIds === undefined
      ? null
      : z
          .array(z.uuid())
          .max(100)
          .parse(options.propertyIds)
          .map((id) => id.toLowerCase());
  if (properties?.length === 0) return counts;
  const limit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.limit ?? 10);
  const active = () => !options.signal?.aborted && options.ownsMutation();
  for (let index = 0; index < limit && active(); index++) {
    // The Channex calls run with no transaction open (VAY-2297). A lease marks the job running
    // while its page is fetched (the scheduler already counts a running job as in flight), and a
    // short transaction then fences the binding, persists the page and moves the cursor. A
    // worker that dies mid-fetch leaves a lease another worker takes over after LEASE_MINUTES.
    const workerId = `channex-alterations:${randomUUID()}`;
    const job = (
      await options.pool.query<{
        id: string;
        payload: unknown;
        page: unknown;
        propertyId: string;
        attempts: number;
        maxAttempts: number;
      }>(
        `UPDATE platform.jobs job SET status='running',locked_at=now(),locked_by=$4,updated_at=now()
         FROM (SELECT id FROM platform.jobs WHERE queue_name=$1 AND job_type=$2
             AND (status='pending' OR (status='running' AND locked_at<now()-make_interval(mins=>$5)))
             AND run_after<=now() AND attempts_count<max_attempts
             AND ($3::uuid[] IS NULL OR property_id=ANY($3::uuid[]))
           ORDER BY run_after,created_at FOR UPDATE SKIP LOCKED LIMIT 1) candidate
         WHERE job.id=candidate.id
         RETURNING job.id,job.payload,job.job_metadata->'page' AS page,job.property_id AS "propertyId",
           job.attempts_count AS attempts,job.max_attempts AS "maxAttempts"`,
        [queue, type, properties, workerId, LEASE_MINUTES],
      )
    ).rows[0];
    if (!job) break;
    const releaseLease = () =>
      options.pool.query(
        `UPDATE platform.jobs SET status='pending',locked_at=NULL,locked_by=NULL,updated_at=now()
         WHERE id=$1 AND status='running' AND locked_by=$2`,
        [job.id, workerId],
      );
    let failure: string | null = null,
      hasMore = false,
      page = 1,
      scope: Scope | null = null;
    const events: { eventId: string; event: unknown }[] = [];
    try {
      scope = scopeSchema.parse(job.payload);
      page = z.number().int().min(1).max(10_000).parse(job.page);
      if (
        scope.propertyId !== job.propertyId ||
        (properties && !properties.includes(scope.propertyId.toLowerCase()))
      )
        throw new Error("alteration_scan_scope_mismatch");
      await assertBinding(options.pool, scope);
      if (!active()) break;
      const result = await options.provider.list(scope.providerPropertyId, page, options.signal);
      hasMore = result.hasMore;
      for (const eventId of result.eventIds) {
        if (!active()) break;
        const event = await options.provider.read(
          scope.providerPropertyId,
          eventId,
          options.signal,
        );
        if (event) events.push({ eventId, event });
      }
    } catch (error) {
      failure = scanFailure(error);
    }
    if (!active()) {
      await releaseLease();
      break;
    }
    const client = await options.pool.connect();
    try {
      await client.query("BEGIN");
      const leased = await client.query(
        "SELECT id FROM platform.jobs WHERE id=$1 AND status='running' AND locked_by=$2 FOR UPDATE",
        [job.id, workerId],
      );
      // Another worker took the lease over: its page, not this one, is the job's.
      if (leased.rowCount !== 1) break;
      if (!failure && scope) {
        await client.query("SAVEPOINT intake_page");
        try {
          await assertBinding(client, scope, "FOR SHARE OF connection,claim");
          for (const { eventId, event } of events)
            await persistChannexAlterationInTransaction(client, { ...scope, eventId }, event);
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT intake_page");
          failure = scanFailure(error);
        }
      }
      const exhausted = Boolean(failure && job.attempts + 1 >= job.maxAttempts);
      const status = exhausted ? "dead_lettered" : failure || hasMore ? "pending" : "succeeded";
      await client.query(
        `UPDATE platform.jobs SET status=$2,attempts_count=CASE WHEN $3::text IS NULL THEN 0 ELSE attempts_count+1 END,
           job_metadata=job_metadata || jsonb_build_object('failure',$3::text)
             || CASE WHEN $3::text IS NULL THEN jsonb_build_object('page',$4::int) ELSE '{}'::jsonb END,
           run_after=now()+CASE WHEN $3::text IS NULL THEN interval '1 second' ELSE interval '5 minutes' END,
           finished_at=CASE WHEN $2 IN ('succeeded','dead_lettered') THEN now() ELSE NULL END,
           locked_at=NULL,locked_by=NULL,updated_at=now()
         WHERE id=$1`,
        [job.id, status, failure, failure ? page : page + 1],
      );
      await client.query(
        `INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id,finished_at,error_type)
         SELECT $1,COALESCE(MAX(attempt_number),0)+1,$2,$3,now(),$4
         FROM platform.job_attempts WHERE job_id=$1`,
        [job.id, failure ? "failed" : "succeeded", workerId, failure],
      );
      if (!active()) {
        await client.query("ROLLBACK");
        await releaseLease();
        break;
      }
      await client.query("COMMIT");
      counts[exhausted ? "deadLettered" : failure ? "retried" : "processed"]++;
    } finally {
      try {
        await client.query("ROLLBACK");
        client.release();
      } catch {
        client.release(true);
      }
    }
  }
  return counts;
}
