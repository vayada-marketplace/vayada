// The record of every AI change (VAY-2524; design note §4.6): one platform.ai_operations row,
// written before anything runs. Only the executor of AI changes moves a row on: an Ask-first change
// waits as "pending" for the person's Yes, the Yes starts it for exactly one caller under a lease,
// the run records each step and finishes it, and a run whose lease ran out is taken over and run
// again with the same keys. A retried or regenerated tool call with the same arguments, in the same
// request scope, gets the same operation back, never a second change.
//
// "failed" means the change certainly did not happen (refused, or nothing was sent). An outcome the
// executor can't be sure of stays "running", so the recovery job runs it again with the same keys;
// after MAX_ATTEMPTS it gives up ("failed", gave_up).
import { createHash, randomBytes } from "node:crypto";

import pg from "pg";

import type { ChangeAction } from "../actions/defineChangeAction.js";

/** How long an Ask-first change waits for the person's answer at most (plan 3.4.2). */
export const PENDING_ANSWER_MS = 15 * 60_000;
/**
 * How long a retry (a resent call, a regenerated step, a resume) joins a change that already ended
 * the same way: done, declined, revoked, AI switched off, or failed after it sent a request. A
 * running change is always joined; a pending one until it expires.
 */
export const RETRY_JOIN_MS = 10 * 60_000;
/** Runs taken over this often give up. */
export const MAX_ATTEMPTS = 5;
export const MAX_STEPS = 20;
const MAX_JSON_BYTES = 32_768;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type AiOperationStatus = "pending" | "running" | "done" | "failed" | "closed";
export type AiOperationCloseReason =
  | "declined"
  | "expired"
  | "revoked"
  | "ai_switched_off"
  | "changed";

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
  requestScope: string | null;
  client: string;
  action: string;
  actionVersion: number;
  group: "ask" | "do";
  businessKey: string;
  arguments: Record<string, unknown>;
  status: AiOperationStatus;
  closeReason: AiOperationCloseReason | null;
  expiresAt: string | null;
  previewSha256: string | null;
  /** The token of the current lease: new at every start and take-over. */
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
  /**
   * What tells a retry from a new request: the in-app turn (a regenerated step stays in its turn;
   * a new question is a new turn). Without it, retries are told apart by RETRY_JOIN_MS alone.
   */
  requestScope?: string;
  client: string;
  action: Pick<ChangeAction, "name" | "version" | "group">;
  arguments: Record<string, unknown>;
  /** The route's own preview the Yes binds to, and its expiry if sooner than 15 minutes. */
  previewSha256?: string;
  expiresInMs?: number;
};

/** Who wants a run: a lease token is made from it at every start and take-over. */
export type AiOperationHolder = { holder: string; ms: number };

export type AiOperationStore = {
  /**
   * The live or just-ended operation of this change (see RETRY_JOIN_MS), or a new pending one.
   * Throws for arguments that are not plain JSON or name another property.
   */
  propose(change: ProposedChange, now: Date): Promise<{ operation: AiOperation; created: boolean }>;
  /**
   * Starts a pending change for exactly one caller (`won`); every other caller gets the row as it
   * is (a running change: join it). An unanswered change past its expiry is closed as expired.
   * Null for an unknown id.
   */
  start(
    id: string,
    holder: AiOperationHolder,
    now: Date,
  ): Promise<{ operation: AiOperation; won: boolean } | null>;
  /** Runs whose lease ran out, now leased to this holder; runs out of attempts give up. */
  takeOverExpired(holder: AiOperationHolder, now: Date, limit: number): Promise<AiOperation[]>;
  /** False once the lease is no longer this token's (taken over or finished). */
  renewLease(id: string, leaseOwner: string, ms: number, now: Date): Promise<boolean>;
  /** Records a step, replacing an earlier record of the same step (a replay after a take-over). */
  recordStep(id: string, leaseOwner: string, step: AiOperationStep): Promise<boolean>;
  /** A result too large to keep is not kept: the change still counts as done. */
  finish(
    id: string,
    leaseOwner: string,
    outcome: { status: "done"; result: unknown } | { status: "failed"; errorCode: string },
    now: Date,
  ): Promise<boolean>;
  /**
   * Closes a pending change that never ran (an expired one as "expired", whatever the reason
   * given); null if it is not pending any more.
   */
  closePending(id: string, reason: AiOperationCloseReason, now: Date): Promise<AiOperation | null>;
  /** Closes pending changes nobody answered in time; returns how many. */
  expirePending(now: Date, limit: number): Promise<number>;
  find(id: string): Promise<AiOperation | null>;
  end(): Promise<void>;
};

/** A database error without the row it was about (rows hold arguments, which can hold text). */
export class AiOperationStoreError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly constraint?: string,
  ) {
    super(message);
    this.name = "AiOperationStoreError";
  }
}

/**
 * The arguments as they are stored: plain JSON, no NUL and no broken characters (the database
 * refuses those, quoting the text), at most MAX_JSON_BYTES.
 */
export function storedArguments(value: Record<string, unknown>): {
  json: string;
  parsed: Record<string, unknown>;
} {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new AiOperationStoreError("AI change arguments are not JSON");
  }
  const parsed: unknown = json === undefined ? undefined : JSON.parse(json);
  if (!json || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AiOperationStoreError("AI change arguments must be an object");
  }
  if (Buffer.byteLength(json) > MAX_JSON_BYTES) {
    throw new AiOperationStoreError("AI change arguments are too large");
  }
  const clean = (node: unknown): boolean =>
    typeof node === "string"
      ? !LONE_SURROGATE.test(node) && !node.includes("\u0000")
      : Array.isArray(node)
        ? node.every(clean)
        : node !== null && typeof node === "object"
          ? Object.entries(node).every(([key, child]) => clean(key) && clean(child))
          : true;
  if (!clean(parsed)) throw new AiOperationStoreError("AI change arguments hold broken text");
  return { json, parsed: parsed as Record<string, unknown> };
}

/** Who asked, where, in which request scope, for which action, with which arguments. */
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
        change.requestScope ?? null,
        change.action.name,
        change.action.version,
        // Exactly what is stored: dates as their JSON text, no undefined members.
        storedArguments(change.arguments).parsed,
      ]),
    )
    .digest("hex");
}

/** JSON with every object's keys sorted, so equal values hash alike. For parsed JSON only. */
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
  surface, connection_id AS "connectionId", conversation_id AS "conversationId",
  request_scope AS "requestScope", client, action, action_version AS "actionVersion",
  action_group AS "group", business_key AS "businessKey", arguments, status,
  close_reason AS "closeReason", expires_at AS "expiresAt", preview_sha256 AS "previewSha256",
  lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt", attempts,
  step_cursor AS "stepCursor", steps, result, error_code AS "errorCode", created_at AS "createdAt",
  started_at AS "startedAt", finished_at AS "finishedAt"`;
const TIMES = ["expiresAt", "leaseExpiresAt", "createdAt", "startedAt", "finishedAt"] as const;
const HOLDER = /^[A-Za-z0-9._-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9:._-]{1,128}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Row = Omit<AiOperation, (typeof TIMES)[number]> & Record<(typeof TIMES)[number], Date | null>;

function toOperation(row: Row): AiOperation {
  const operation = { ...row } as unknown as AiOperation;
  for (const field of TIMES) {
    const value = row[field];
    (operation as Record<string, unknown>)[field] = value ? value.toISOString() : null;
  }
  return operation;
}

/** A fresh lease token for this holder, and the lease's end. */
function newLease(holder: AiOperationHolder, now: Date): { token: string; until: string } {
  if (!HOLDER.test(holder.holder)) throw new AiOperationStoreError("AI change holder is invalid");
  return {
    token: `${holder.holder}:${randomBytes(8).toString("hex")}`,
    until: leaseUntil(holder.ms, now),
  };
}

function leaseUntil(ms: number, now: Date): string {
  if (!Number.isSafeInteger(ms) || ms < 1) throw new AiOperationStoreError("AI lease is invalid");
  return new Date(now.getTime() + ms).toISOString();
}

function positive(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new AiOperationStoreError("bad limit");
  return limit;
}

type Queryable = {
  query<T extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
};

/** Runs a statement; a database error loses its row detail before anyone logs it. */
async function run<T extends pg.QueryResultRow>(
  db: Queryable,
  text: string,
  values: unknown[],
): Promise<pg.QueryResult<T>> {
  try {
    return await db.query<T>(text, values);
  } catch (error) {
    const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
    throw new AiOperationStoreError(
      `AI operation store query failed${code ? ` (${code}${constraint ? ` ${constraint}` : ""})` : ""}`,
      code,
      constraint,
    );
  }
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
    const result = await run<Row>(
      db,
      `SELECT ${COLUMNS} FROM platform.ai_operations WHERE id = $1::uuid`,
      [id],
    );
    return result.rows[0] ? toOperation(result.rows[0]) : null;
  };

  return {
    async propose(change, now) {
      if (change.action.group !== "ask") throw new Error("Only Ask-first AI changes exist yet");
      const { json } = storedArguments(change.arguments);
      const named = change.arguments["propertyId"];
      if (typeof named !== "string" || named.toLowerCase() !== change.propertyId.toLowerCase()) {
        throw new AiOperationStoreError("AI change arguments name another property");
      }
      if (change.requestScope !== undefined && !TOKEN.test(change.requestScope)) {
        throw new AiOperationStoreError("AI change request scope is invalid");
      }
      if (change.previewSha256 !== undefined && !SHA256.test(change.previewSha256)) {
        throw new AiOperationStoreError("AI change preview digest is invalid");
      }
      const answerMs = change.expiresInMs ?? PENDING_ANSWER_MS;
      if (!Number.isSafeInteger(answerMs) || answerMs < 1 || answerMs > PENDING_ANSWER_MS) {
        throw new AiOperationStoreError("AI change expiry is invalid");
      }
      const businessKey = operationBusinessKey(change);
      const client = await db.connect();
      try {
        await run(client, "BEGIN", []);
        // Two copies of one tool call at once write one row.
        await run(client, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [businessKey]);
        // An unanswered card past its expiry is closed first: it can never start after this.
        await run(
          client,
          `UPDATE platform.ai_operations
              SET status = 'closed', close_reason = 'expired', finished_at = $2::timestamptz
            WHERE business_key = $1 AND status = 'pending' AND expires_at <= $2::timestamptz`,
          [businessKey, now.toISOString()],
        );
        const existing = await run<Row>(
          client,
          `SELECT ${COLUMNS} FROM platform.ai_operations
            WHERE business_key = $1
              AND (status IN ('pending', 'running')
                   OR (created_at > $2::timestamptz
                       AND (status = 'done'
                            OR (status = 'closed'
                                AND close_reason IN ('declined', 'revoked', 'ai_switched_off'))
                            OR (status = 'failed' AND jsonb_array_length(steps) > 0))))
            ORDER BY created_at DESC
            LIMIT 1`,
          [businessKey, new Date(now.getTime() - RETRY_JOIN_MS).toISOString()],
        );
        if (existing.rows[0]) {
          await run(client, "COMMIT", []);
          return { operation: toOperation(existing.rows[0]), created: false };
        }
        const inserted = await run<Row>(
          client,
          `INSERT INTO platform.ai_operations
             (organization_id, property_id, user_id, surface, connection_id, conversation_id,
              request_scope, client, action, action_version, action_group, business_key,
              arguments, status, expires_at, preview_sha256, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7, $8, $9, $10, 'ask',
                   $11, $12::jsonb, 'pending', $13::timestamptz, $14, $15::timestamptz)
           RETURNING ${COLUMNS}`,
          [
            change.organizationId,
            change.propertyId,
            change.userId,
            change.surface,
            change.connectionId ?? null,
            change.conversationId ?? null,
            change.requestScope ?? null,
            change.client,
            change.action.name,
            change.action.version,
            businessKey,
            json,
            new Date(now.getTime() + answerMs).toISOString(),
            change.previewSha256 ?? null,
            now.toISOString(),
          ],
        );
        await run(client, "COMMIT", []);
        return { operation: toOperation(inserted.rows[0]!), created: true };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async start(id, holder, now) {
      const lease = newLease(holder, now);
      const result = await run<Row>(
        db,
        `UPDATE platform.ai_operations
            SET status = 'running', lease_owner = $2, lease_expires_at = $3::timestamptz,
                started_at = $4::timestamptz, attempts = attempts + 1
          WHERE id = $1::uuid AND status = 'pending' AND expires_at > $4::timestamptz
          RETURNING ${COLUMNS}`,
        [id, lease.token, lease.until, now.toISOString()],
      );
      if (result.rows[0]) return { operation: toOperation(result.rows[0]), won: true };
      // Not started: an unanswered change past its expiry is closed, never left looking pending.
      await run(
        db,
        `UPDATE platform.ai_operations
            SET status = 'closed', close_reason = 'expired', finished_at = $2::timestamptz
          WHERE id = $1::uuid AND status = 'pending' AND expires_at <= $2::timestamptz`,
        [id, now.toISOString()],
      );
      const current = await find(id);
      return current ? { operation: current, won: false } : null;
    },

    async takeOverExpired(holder, now, limit) {
      positive(limit);
      newLease(holder, now);
      // Runs that ran out of attempts give up, rather than replaying their requests for ever.
      await run(
        db,
        `UPDATE platform.ai_operations
            SET status = 'failed', error_code = 'gave_up', finished_at = $1::timestamptz,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE status = 'running' AND lease_expires_at <= $1::timestamptz AND attempts >= $2`,
        [now.toISOString(), MAX_ATTEMPTS],
      );
      const due = await run<{ id: string }>(
        db,
        `SELECT id FROM platform.ai_operations
          WHERE status = 'running' AND lease_expires_at <= $1::timestamptz
          ORDER BY lease_expires_at
          LIMIT $2`,
        [now.toISOString(), limit],
      );
      const taken: AiOperation[] = [];
      for (const { id } of due.rows) {
        // One statement per run: the WHERE is checked again on the newest row, so of two
        // recovery jobs only one takes a run, each with a token of its own.
        const lease = newLease(holder, now);
        const result = await run<Row>(
          db,
          `UPDATE platform.ai_operations
              SET lease_owner = $2, lease_expires_at = $3::timestamptz, attempts = attempts + 1
            WHERE id = $1::uuid AND status = 'running' AND lease_expires_at <= $4::timestamptz
              AND attempts < $5
            RETURNING ${COLUMNS}`,
          [id, lease.token, lease.until, now.toISOString(), MAX_ATTEMPTS],
        );
        if (result.rows[0]) taken.push(toOperation(result.rows[0]));
      }
      return taken;
    },

    async renewLease(id, leaseOwner, ms, now) {
      if (!TOKEN.test(leaseOwner)) return false;
      const result = await run(
        db,
        `UPDATE platform.ai_operations SET lease_expires_at = $3::timestamptz
          WHERE id = $1::uuid AND status = 'running' AND lease_owner = $2`,
        [id, leaseOwner, leaseUntil(ms, now)],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async recordStep(id, leaseOwner, step) {
      if (!TOKEN.test(leaseOwner)) return false;
      if (
        !Number.isSafeInteger(step.step) ||
        step.step < 1 ||
        step.step > MAX_STEPS ||
        !TOKEN.test(step.requestId) ||
        !SHA256.test(step.idempotencyKeySha256) ||
        !Number.isSafeInteger(step.statusCode) ||
        Number.isNaN(Date.parse(step.at))
      ) {
        throw new AiOperationStoreError("AI change step is invalid");
      }
      const record = {
        step: step.step,
        requestId: step.requestId,
        idempotencyKeySha256: step.idempotencyKeySha256,
        statusCode: step.statusCode,
        at: step.at,
      };
      const result = await run(
        db,
        `UPDATE platform.ai_operations
            SET steps = COALESCE((SELECT jsonb_agg(entry ORDER BY (entry->>'step')::int)
                                    FROM jsonb_array_elements(steps) entry
                                   WHERE (entry->>'step')::int <> $4), '[]'::jsonb)
                        || jsonb_build_array($3::jsonb),
                step_cursor = GREATEST(step_cursor, $4)
          WHERE id = $1::uuid AND status = 'running' AND lease_owner = $2`,
        [id, leaseOwner, JSON.stringify(record), step.step],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async finish(id, leaseOwner, outcome, now) {
      if (!TOKEN.test(leaseOwner)) return false;
      let result: string | null = null;
      if (outcome.status === "done") {
        const json = JSON.stringify(outcome.result ?? null);
        result = Buffer.byteLength(json) <= MAX_JSON_BYTES ? json : null;
      } else if (!ERROR_CODE.test(outcome.errorCode)) {
        throw new AiOperationStoreError("AI change error code is invalid");
      }
      const updated = await run(
        db,
        `UPDATE platform.ai_operations
            SET status = $3, result = $4::jsonb, error_code = $5, finished_at = $6::timestamptz,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $1::uuid AND status = 'running' AND lease_owner = $2`,
        [
          id,
          leaseOwner,
          outcome.status,
          result,
          outcome.status === "failed" ? outcome.errorCode : null,
          now.toISOString(),
        ],
      );
      return (updated.rowCount ?? 0) === 1;
    },

    async closePending(id, reason, now) {
      const result = await run<Row>(
        db,
        `UPDATE platform.ai_operations
            SET status = 'closed', finished_at = $3::timestamptz,
                close_reason = CASE WHEN expires_at <= $3::timestamptz THEN 'expired' ELSE $2 END
          WHERE id = $1::uuid AND status = 'pending'
          RETURNING ${COLUMNS}`,
        [id, reason, now.toISOString()],
      );
      return result.rows[0] ? toOperation(result.rows[0]) : null;
    },

    async expirePending(now, limit) {
      const result = await run<{ n: number }>(
        db,
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
        [now.toISOString(), positive(limit)],
      );
      return result.rows[0]?.n ?? 0;
    },

    find,

    async end() {
      if (ownsPool) await db.end();
    },
  };
}
