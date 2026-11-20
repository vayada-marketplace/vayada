import pg from "pg";

import type { AiActionGroup, AiActionOutcome, AiRecordRef, AiSurface } from "./actionLog.js";

/**
 * VAY-2508 part 2: reading the AI action log for the "AI activity" API, and its retention.
 * The log keeps rows two years (design note §7.3). The same worker also empties Inbox assist
 * results whose own 30-day retention passed: `pms.purge_expired_message_assistance_results`
 * (0146) is operator-only and nothing ran it, so the API does the same UPDATE as plain DML.
 */
export const AI_ACTION_LOG_RETENTION = "2 years";

export type AiActivityItem = {
  id: string;
  occurredAt: string;
  userId: string;
  propertyId: string | null;
  surface: AiSurface;
  client: string;
  action: string;
  actionVersion: number;
  group: AiActionGroup;
  arguments: unknown;
  recordsRead: AiRecordRef[];
  recordsChanged: AiRecordRef[];
  outcome: AiActionOutcome;
  errorCode: string | null;
  sensitive: boolean;
  latencyMs: number;
  requestId: string;
  correlationId: string | null;
  operationId: string | null;
};

export type AiActivityQuery = {
  organizationId: string;
  /** Only this user's rows; absent for the account owner's whole-account view. */
  userId?: string;
  propertyId?: string;
  /** Rows strictly older than this (the previous page's last row). */
  before?: { occurredAt: string; id: string };
  limit: number;
};

export type AiActivityStore = {
  list(query: AiActivityQuery): Promise<AiActivityItem[]>;
};

export type AiActionLogRetentionStore = {
  /** Deletes up to `limit` expired log rows and empties up to `limit` expired assist results. */
  purgeExpiredBatch(now: Date, limit: number): Promise<{ logRows: number; assistResults: number }>;
  close(): Promise<void>;
};

type Queryable = {
  query<T extends pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

function pool(config: { connectionString: string; max?: number; pool?: Queryable }): Queryable {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("AI action log connectionString must not be empty");
  return config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
}

export function createPgAiActivityStore(config: {
  connectionString: string;
  max?: number;
  pool?: Queryable;
}): AiActivityStore & { close(): Promise<void> } {
  const db = pool(config);
  return {
    async list(query) {
      const result = await db.query<AiActivityItem>(
        `SELECT id::text AS id, to_json(occurred_at) #>> '{}' AS "occurredAt",
                user_id::text AS "userId", property_id::text AS "propertyId", surface, client,
                action, action_version AS "actionVersion", action_group AS "group", arguments,
                records_read AS "recordsRead", records_changed AS "recordsChanged", outcome,
                error_code AS "errorCode", sensitive, latency_ms AS "latencyMs",
                request_id AS "requestId", correlation_id AS "correlationId",
                operation_id::text AS "operationId"
           FROM platform.ai_tool_calls
          WHERE organization_id = $1::uuid
            AND ($2::uuid IS NULL OR user_id = $2::uuid)
            AND ($3::uuid IS NULL OR property_id = $3::uuid)
            AND ($4::timestamptz IS NULL OR (occurred_at, id) < ($4::timestamptz, $5::uuid))
          ORDER BY occurred_at DESC, id DESC
          LIMIT $6`,
        [
          query.organizationId,
          query.userId ?? null,
          query.propertyId ?? null,
          query.before?.occurredAt ?? null,
          query.before?.id ?? null,
          query.limit,
        ],
      );
      return result.rows;
    },
    close: () => db.end(),
  };
}

export function createPgAiActionLogRetentionStore(config: {
  connectionString: string;
  max?: number;
  pool?: Queryable;
}): AiActionLogRetentionStore {
  const db = pool(config);
  return {
    async purgeExpiredBatch(now, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error("AI action log retention limit must be a positive integer");
      const log = await db.query<{ n: number }>(
        `WITH expired AS (
           SELECT id FROM platform.ai_tool_calls
            WHERE occurred_at < $1::timestamptz - $3::text::interval
            ORDER BY occurred_at
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         ), deleted AS (
           DELETE FROM platform.ai_tool_calls call USING expired
            WHERE call.id = expired.id
           RETURNING 1
         )
         SELECT count(*)::int AS n FROM deleted`,
        [now.toISOString(), limit, AI_ACTION_LOG_RETENTION],
      );
      const assist = await db.query<{ n: number }>(
        `WITH expired AS (
           SELECT id FROM pms.message_assistance_results
            WHERE purged_at IS NULL AND pii_retention_until <= $1::timestamptz
            ORDER BY pii_retention_until
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         ), purged AS (
           UPDATE pms.message_assistance_results result
              SET assisted_text = NULL, purged_at = $1::timestamptz
             FROM expired
            WHERE result.id = expired.id
           RETURNING 1
         )
         SELECT count(*)::int AS n FROM purged`,
        [now.toISOString(), limit],
      );
      return { logRows: log.rows[0]?.n ?? 0, assistResults: assist.rows[0]?.n ?? 0 };
    },
    close: () => db.end(),
  };
}
