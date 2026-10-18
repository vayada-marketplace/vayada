import { randomUUID } from "node:crypto";

import pg from "pg";

import {
  CONTACT_NOTIFICATION_JOB_TYPE,
  CONTACT_NOTIFICATION_QUEUE,
} from "../routes/platformContactIntake.js";

/**
 * VAY-2286: contact-form and in-app support messages are deleted 90 days after they arrive
 * (privacy page, section 8). They live only in the job row's payload; the row itself stays
 * (audit rows point at it), emptied, and a job that never ran is canceled.
 */
export const CONTACT_INTAKE_RETENTION = "90 days";
export const CONTACT_INTAKE_RETENTION_BATCH_SIZE = 500;
export const CONTACT_INTAKE_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type ContactIntakeRetentionPool = {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<{ purged: number }> }>;
  end(): Promise<void>;
};

export type ContactIntakeRetentionStore = {
  /** Empties up to `limit` expired contact jobs and returns how many it emptied. */
  purgeExpiredBatch(now: Date, limit: number): Promise<number>;
  close(): Promise<void>;
};

export function createPgContactIntakeRetentionStore(config: {
  connectionString: string;
  max?: number;
  pool?: ContactIntakeRetentionPool;
}): ContactIntakeRetentionStore {
  if (!config.connectionString.trim()) {
    throw new Error("Contact intake retention connectionString must not be empty");
  }
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async purgeExpiredBatch(now, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("Contact intake retention limit must be a positive integer");
      }
      // One statement: a batch is emptied together with its audit row or not at all. A job a
      // worker holds right now is left for the next run; one whose worker died (lock older than
      // an hour, e.g. a task replaced during its last attempt) is emptied and canceled too.
      const result = await pool.query(
        `WITH expired AS (
           SELECT id
             FROM platform.jobs
            WHERE queue_name = $5
              AND job_type = $6
              AND created_at < $1::timestamptz - $3::text::interval
              AND payload <> '{}'::jsonb
              AND (status <> 'running' OR locked_at < $1::timestamptz - interval '1 hour')
            ORDER BY created_at ASC, id ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         ), purged AS (
           UPDATE platform.jobs AS job
              SET payload = '{}'::jsonb,
                  status = CASE
                    WHEN job.status IN ('pending', 'running') THEN 'canceled'
                    ELSE job.status
                  END,
                  finished_at = COALESCE(job.finished_at, $1::timestamptz),
                  locked_at = NULL,
                  locked_by = NULL,
                  job_metadata = job.job_metadata || jsonb_build_object('payloadPurgedAt', $1::text),
                  updated_at = now()
             FROM expired
            WHERE job.id = expired.id
           RETURNING job.id
         ), audited AS (
           INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope, actor_type,
             target_resource_product, target_resource_type, target_resource_id,
             redacted_payload, audit_metadata, retention_class, privacy_scope
           )
           SELECT $4, 'platform', 'platform.contact_submission.retention_purged', $1::timestamptz,
             'platform', 'system', 'platform', 'contact_submission', 'retention',
             jsonb_build_object('purged', count(*), 'olderThan', $3::text),
             jsonb_build_object('source', 'apps/api-contact-intake-retention'),
             'standard', 'internal'
             FROM purged
           HAVING count(*) > 0
         )
         SELECT count(*)::integer AS purged FROM purged`,
        [
          now.toISOString(),
          limit,
          CONTACT_INTAKE_RETENTION,
          `contact-intake-retention:${randomUUID()}`,
          CONTACT_NOTIFICATION_QUEUE,
          CONTACT_NOTIFICATION_JOB_TYPE,
        ],
      );
      return result.rows[0]?.purged ?? 0;
    },

    async close() {
      await pool.end();
    },
  };
}

export function startContactIntakeRetentionWorker(options: {
  store: ContactIntakeRetentionStore;
  enabled: boolean;
  intervalMs?: number;
  batchSize?: number;
  now?: () => Date;
  logger: {
    info(context: { purged: number }, message: string): void;
    error(context: { err: unknown }, message: string): void;
  };
}): { runNow(): Promise<void>; close(): Promise<void> } {
  const batchSize = options.batchSize ?? CONTACT_INTAKE_RETENTION_BATCH_SIZE;
  const now = options.now ?? (() => new Date());
  let activeRun: Promise<void> | undefined;
  let closing = false;
  const drain = async (cutoff: Date) => {
    let total = 0;
    for (;;) {
      const purged = await options.store.purgeExpiredBatch(cutoff, batchSize);
      total += purged;
      if (closing || purged < batchSize) break;
    }
    if (total > 0) options.logger.info({ purged: total }, "Purged expired contact messages");
  };
  const runNow = (): Promise<void> => {
    if (closing) return Promise.resolve();
    activeRun ??= drain(now())
      .catch((error: unknown) => {
        options.logger.error({ err: error }, "Contact intake retention failed");
      })
      .finally(() => {
        activeRun = undefined;
      });
    return activeRun;
  };

  const timer = options.enabled
    ? setInterval(() => void runNow(), options.intervalMs ?? CONTACT_INTAKE_RETENTION_INTERVAL_MS)
    : undefined;
  timer?.unref();
  if (options.enabled) void runNow();

  return {
    runNow,
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      await activeRun;
      await options.store.close();
    },
  };
}
