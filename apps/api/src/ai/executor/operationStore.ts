// The record of every AI change (VAY-2524; design note §4.6): one platform.ai_operations row,
// written before anything runs. Only the executor of AI changes moves a row on: an Ask-first change
// waits as "pending" for the person's Yes, the Yes starts it for exactly one caller under a lease,
// the run records each step and finishes it, and a run whose lease ran out is taken over and run
// again with the same keys. A retried or regenerated tool call with the same arguments gets the
// same operation back, never a second change.
import { createHash } from "node:crypto";

import pg from "pg";

import type { ChangeAction } from "../actions/defineChangeAction.js";

/** How long an Ask-first change waits for the person's answer (plan 3.4.2). */
export const PENDING_ANSWER_MS = 15 * 60_000;
/** How long a retried tool call with the same arguments joins the change it repeats. */
export const SAME_CHANGE_MS = 60 * 60_000;

export type AiOperationStatus = "pending" | "running" | "done" | "failed" | "closed";
export type AiOperationCloseReason = "declined" | "expired" | "revoked" | "ai_switched_off";

/** One request a run made: never its answer text. */
export type AiOperationStep = {
  step: number;
  requestId: string;
  idempotencyKeySha256: string;
  statusCode: number;
  at: string;
};

export type AiOperation = {
  id: string;
  organizationId: string;
  propertyId: string;
  userId: string;
  surface: "mcp" | "in_app";
  connectionId: string | null;
  conversationId: string | null;
  client: string;
  action: string;
  actionVersion: number;
  group: "ask" | "do";
  businessKey: string;
  arguments: Record<string, unknown>;
  status: AiOperationStatus;
  closeReason: AiOperationCloseReason | null;
  expiresAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attempts: number;
  stepCursor: number;
  steps: AiOperationStep[];
  result: unknown;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

/** A change an AI asked for, its arguments already checked against the action's input. */
export type ProposedChange = {
  organizationId: string;
  propertyId: string;
  userId: string;
  surface: "mcp" | "in_app";
  /** The MCP connection (mcp) or the in-app conversation (in_app). */
  connectionId?: string;
  conversationId?: string;
  client: string;
  action: Pick<ChangeAction, "name" | "version" | "group">;
  arguments: Record<string, unknown>;
};

export type AiOperationLease = { owner: string; ms: number };

export type AiOperationStore = {
  /** The live operation for this change, or a new one: "pending" for an Ask-first change. */
  propose(change: ProposedChange, now: Date): Promise<{ operation: AiOperation; created: boolean }>;
  /**
   * Starts a pending change for exactly one caller (`won`); every other caller, and a change that
   * expired or was closed, gets the row as it is. Null for an unknown id.
   */
  start(
    id: string,
    lease: AiOperationLease,
    now: Date,
  ): Promise<{ operation: AiOperation; won: boolean } | null>;
  /** Runs whose lease ran out, now leased to this owner (the recovery job). */
  takeOverExpired(lease: AiOperationLease, now: Date, limit: number): Promise<AiOperation[]>;
  /** False once the run is no longer this owner's (taken over or finished). */
  renewLease(id: string, lease: AiOperationLease, now: Date): Promise<boolean>;
  recordStep(id: string, owner: string, step: AiOperationStep): Promise<boolean>;
  finish(
    id: string,
    owner: string,
    outcome: { status: "done"; result: unknown } | { status: "failed"; errorCode: string },
    now: Date,
  ): Promise<boolean>;
  /** Closes a pending change that never ran; null if it is not pending (any more). */
  closePending(id: string, reason: AiOperationCloseReason, now: Date): Promise<AiOperation | null>;
  /** Closes pending changes nobody answered in time; returns how many. */
  expirePending(now: Date, limit: number): Promise<number>;
  find(id: string): Promise<AiOperation | null>;
  end(): Promise<void>;
};

/** Who asked, where, for which action, with which arguments (keys in a fixed order). */
export function operationBusinessKey(change: ProposedChange): string {
  return createHash("sha256")
    .update(
      canonicalJson([
        change.organizationId,
        change.propertyId,
        change.userId,
        change.surface,
        change.connectionId ?? null,
        change.conversationId ?? null,
        change.action.name,
        change.action.version,
        change.arguments,
      ]),
    )
    .digest("hex");
}

/** JSON with every object's keys sorted, so equal values hash alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const COLUMNS = `
  id, organization_id AS "organizationId", property_id AS "propertyId", user_id AS "userId",
  surface, connection_id AS "connectionId", conversation_id AS "conversationId", client, action,
  action_version AS "actionVersion", action_group AS "group", business_key AS "businessKey",
  arguments, status, close_reason AS "closeReason", expires_at AS "expiresAt",
  lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt", attempts,
  step_cursor AS "stepCursor", steps, result, error_code AS "errorCode", created_at AS "createdAt",
  started_at AS "startedAt", finished_at AS "finishedAt"`;
const TIMES = ["expiresAt", "leaseExpiresAt", "createdAt", "startedAt", "finishedAt"] as const;
const LEASE_OWNER = /^[A-Za-z0-9:._-]{1,128}$/;

type Row = Omit<AiOperation, (typeof TIMES)[number]> & Record<(typeof TIMES)[number], Date | null>;

function toOperation(row: Row): AiOperation {
  const operation = { ...row } as unknown as AiOperation;
  for (const field of TIMES) {
    const value = row[field];
    (operation as Record<string, unknown>)[field] = value ? value.toISOString() : null;
  }
  return operation;
}

function leaseUntil(lease: AiOperationLease, now: Date): Date {
  if (!LEASE_OWNER.test(lease.owner) || !Number.isSafeInteger(lease.ms) || lease.ms < 1) {
    throw new Error("AI operation lease is invalid");
  }
  return new Date(now.getTime() + lease.ms);
}

export function createPgAiOperationStore(config: {
  connectionString: string;
  max?: number;
  pool?: pg.Pool;
}): AiOperationStore {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("AI operation store connectionString must not be empty");
  const ownsPool = !config.pool;
  const db =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  const find = async (id: string) => {
    const result = await db.query<Row>(
      `SELECT ${COLUMNS} FROM platform.ai_operations WHERE id = $1::uuid`,
      [id],
    );
    return result.rows[0] ? toOperation(result.rows[0]) : null;
  };

  return {
    async propose(change, now) {
      if (change.action.group !== "ask") throw new Error("Only Ask-first AI changes exist yet");
      const businessKey = operationBusinessKey(change);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        // Two copies of one tool call at once write one row.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [businessKey]);
        const existing = await client.query<Row>(
          `SELECT ${COLUMNS} FROM platform.ai_operations
            WHERE business_key = $1 AND created_at > $2::timestamptz
              AND status IN ('pending', 'running', 'done')
              AND NOT (status = 'pending' AND expires_at <= $3::timestamptz)
            ORDER BY created_at DESC
            LIMIT 1`,
          [businessKey, new Date(now.getTime() - SAME_CHANGE_MS).toISOString(), now.toISOString()],
        );
        if (existing.rows[0]) {
          await client.query("COMMIT");
          return { operation: toOperation(existing.rows[0]), created: false };
        }
        const inserted = await client.query<Row>(
          `INSERT INTO platform.ai_operations
             (organization_id, property_id, user_id, surface, connection_id, conversation_id,
              client, action, action_version, action_group, business_key, arguments, status,
              expires_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7, $8, $9, 'ask', $10,
                   $11::jsonb, 'pending', $12::timestamptz, $13::timestamptz)
           RETURNING ${COLUMNS}`,
          [
            change.organizationId,
            change.propertyId,
            change.userId,
            change.surface,
            change.connectionId ?? null,
            change.conversationId ?? null,
            change.client,
            change.action.name,
            change.action.version,
            businessKey,
            JSON.stringify(change.arguments),
            new Date(now.getTime() + PENDING_ANSWER_MS).toISOString(),
            now.toISOString(),
          ],
        );
        await client.query("COMMIT");
        return { operation: toOperation(inserted.rows[0]!), created: true };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async start(id, lease, now) {
      const result = await db.query<Row>(
        `UPDATE platform.ai_operations
            SET status = 'running', lease_owner = $2, lease_expires_at = $3::timestamptz,
                started_at = $4::timestamptz, attempts = attempts + 1
          WHERE id = $1::uuid AND status = 'pending' AND expires_at > $4::timestamptz
          RETURNING ${COLUMNS}`,
        [id, lease.owner, leaseUntil(lease, now).toISOString(), now.toISOString()],
      );
      if (result.rows[0]) return { operation: toOperation(result.rows[0]), won: true };
      const current = await find(id);
      return current ? { operation: current, won: false } : null;
    },

    async takeOverExpired(lease, now, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be positive");
      const result = await db.query<Row>(
        `UPDATE platform.ai_operations operation
            SET lease_owner = $1, lease_expires_at = $2::timestamptz, attempts = attempts + 1
           FROM (SELECT id AS due_id FROM platform.ai_operations
                  WHERE status = 'running' AND lease_expires_at <= $3::timestamptz
                  ORDER BY lease_expires_at
                  LIMIT $4
                  FOR UPDATE SKIP LOCKED) due
          WHERE operation.id = due.due_id
          RETURNING ${COLUMNS}`,
        [lease.owner, leaseUntil(lease, now).toISOString(), now.toISOString(), limit],
      );
      return result.rows.map(toOperation);
    },

    async renewLease(id, lease, now) {
      const result = await db.query(
        `UPDATE platform.ai_operations SET lease_expires_at = $3::timestamptz
          WHERE id = $1::uuid AND status = 'running' AND lease_owner = $2`,
        [id, lease.owner, leaseUntil(lease, now).toISOString()],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async recordStep(id, owner, step) {
      const result = await db.query(
        `UPDATE platform.ai_operations
            SET steps = steps || jsonb_build_array($3::jsonb), step_cursor = $4
          WHERE id = $1::uuid AND status = 'running' AND lease_owner = $2`,
        [id, owner, JSON.stringify(step), step.step],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async finish(id, owner, outcome, now) {
      const result = await db.query(
        `UPDATE platform.ai_operations
            SET status = $3, result = $4::jsonb, error_code = $5, finished_at = $6::timestamptz,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $1::uuid AND status = 'running' AND lease_owner = $2`,
        [
          id,
          owner,
          outcome.status,
          outcome.status === "done" ? JSON.stringify(outcome.result ?? null) : null,
          outcome.status === "failed" ? outcome.errorCode : null,
          now.toISOString(),
        ],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async closePending(id, reason, now) {
      const result = await db.query<Row>(
        `UPDATE platform.ai_operations
            SET status = 'closed', close_reason = $2, finished_at = $3::timestamptz
          WHERE id = $1::uuid AND status = 'pending'
          RETURNING ${COLUMNS}`,
        [id, reason, now.toISOString()],
      );
      return result.rows[0] ? toOperation(result.rows[0]) : null;
    },

    async expirePending(now, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be positive");
      const result = await db.query<{ n: number }>(
        `WITH due AS (
           SELECT id FROM platform.ai_operations
            WHERE status = 'pending' AND expires_at <= $1::timestamptz
            ORDER BY expires_at
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         ), closed AS (
           UPDATE platform.ai_operations operation
              SET status = 'closed', close_reason = 'expired', finished_at = $1::timestamptz
             FROM due
            WHERE operation.id = due.id
           RETURNING 1
         )
         SELECT count(*)::int AS n FROM closed`,
        [now.toISOString(), limit],
      );
      return result.rows[0]?.n ?? 0;
    },

    find,

    async end() {
      if (ownsPool) await db.end();
    },
  };
}
