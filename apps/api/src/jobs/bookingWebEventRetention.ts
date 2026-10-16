import { randomUUID } from "node:crypto";

import pg from "pg";

/** Booking-page analytics are kept 13 months (VAY-2212): the growth chart shows 12. */
export const BOOKING_WEB_EVENT_RETENTION = "13 months";
export const DEFAULT_BOOKING_WEB_EVENT_RETENTION_BATCH_SIZE = 1_000;
const MAX_TIMER_INTERVAL_MS = 2_147_483_647;

export type BookingWebEventRetentionPool = {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<{ deleted: number }> }>;
  end(): Promise<void>;
};

export type BookingWebEventRetentionStore = {
  /** Deletes up to `limit` expired events and returns how many it deleted. */
  deleteExpiredBatch(now: Date, limit: number): Promise<number>;
  close(): Promise<void>;
};

export function createPgBookingWebEventRetentionStore(config: {
  connectionString: string;
  max?: number;
  pool?: BookingWebEventRetentionPool;
}): BookingWebEventRetentionStore {
  if (!config.connectionString.trim()) {
    throw new Error("Booking web event retention connectionString must not be empty");
  }
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async deleteExpiredBatch(now, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("Booking web event retention limit must be a positive integer");
      }
      // One statement, so a batch is deleted together with its audit row or not at all
      // (PostgreSQL runs a data-modifying CTE even when nothing reads it). The count comes from
      // the delete, so the API login needs no read access to the audit table.
      const result = await pool.query(
        `WITH expired AS (
           SELECT id
             FROM distribution.booking_web_events
            WHERE occurred_at < $1::timestamptz - $3::text::interval
            ORDER BY occurred_at ASC, id ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         ), deleted AS (
           DELETE FROM distribution.booking_web_events AS event
            USING expired
            WHERE event.id = expired.id
           RETURNING event.id
         ), audited AS (
           INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope, actor_type,
             target_resource_product, target_resource_type, target_resource_id,
             redacted_payload, audit_metadata, retention_class, privacy_scope
           )
           SELECT $4, 'distribution', 'booking_web.events.retention_purged', $1::timestamptz,
             'platform', 'system', 'distribution', 'booking_web_events', 'retention',
             jsonb_build_object('deleted', count(*), 'olderThan', $3::text),
             jsonb_build_object('source', 'apps/api-booking-web-event-retention'),
             'standard', 'internal'
             FROM deleted
           HAVING count(*) > 0
         )
         SELECT count(*)::integer AS deleted FROM deleted`,
        [
          now.toISOString(),
          limit,
          BOOKING_WEB_EVENT_RETENTION,
          `booking-web-event-retention:${randomUUID()}`,
        ],
      );
      return result.rows[0]?.deleted ?? 0;
    },

    async close() {
      await pool.end();
    },
  };
}

type RetentionLogger = {
  info(context: { deleted: number }, message: string): void;
  error(context: { err: unknown }, message: string): void;
};

export function startBookingWebEventRetentionWorker(options: {
  store: BookingWebEventRetentionStore;
  enabled: boolean;
  intervalMs: number;
  batchSize?: number;
  now?: () => Date;
  logger: RetentionLogger;
}): { runNow(): Promise<void>; close(): Promise<void> } {
  const batchSize = options.batchSize ?? DEFAULT_BOOKING_WEB_EVENT_RETENTION_BATCH_SIZE;
  if (
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 1 ||
    options.intervalMs > MAX_TIMER_INTERVAL_MS
  ) {
    throw new Error(
      `Booking web event retention interval must be between 1 and ${MAX_TIMER_INTERVAL_MS}`,
    );
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("Booking web event retention batch size must be a positive integer");
  }

  const now = options.now ?? (() => new Date());
  let activeRun: Promise<void> | undefined;
  let closing = false;
  const drain = async (cutoff: Date) => {
    let total = 0;
    for (;;) {
      const deleted = await options.store.deleteExpiredBatch(cutoff, batchSize);
      total += deleted;
      if (closing || deleted < batchSize) break;
    }
    if (total > 0) options.logger.info({ deleted: total }, "Deleted expired booking web events");
  };
  const runNow = (): Promise<void> => {
    if (closing) return Promise.resolve();
    activeRun ??= drain(now())
      .catch((error: unknown) => {
        options.logger.error({ err: error }, "Booking web event retention failed");
      })
      .finally(() => {
        activeRun = undefined;
      });
    return activeRun;
  };

  const timer = options.enabled ? setInterval(() => void runNow(), options.intervalMs) : undefined;
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
