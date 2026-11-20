import { createHash } from "node:crypto";

import pg from "pg";

/**
 * VAY-2508: one `platform.ai_tool_calls` row per AI action (design note §7). It says who acted
 * (user, account, property), through which AI surface and app or feature, which action, which
 * records it read or changed, and how it ended, plus the keys that join it to the route's own
 * audit rows: the route sees the tool-call id as its request id, a change's operation id as its
 * correlation id, and the SHA-256 of the Idempotency-Key the action sent (as in
 * platform.idempotency_keys.key_hash).
 *
 * No guest text and no tool output is ever stored (Flamur, 2026-11-20: ids only, so guest erasure
 * has nothing to remove here). Arguments keep ids, dates, numbers and booleans; any other string
 * becomes "[text:<length>]" unless the caller names its key as a safe short token (an enum such
 * as a status or language code). Records are a type and a UUID, nothing else.
 */

export type AiSurface = "mcp" | "in_app" | "inbox_assist" | "concierge";
export type AiActionGroup = "R0" | "R1" | "R2-finance" | "R2" | "do" | "ask";
export type AiActionOutcome = "ok" | "denied" | "invalid" | "refused" | "failed";
export type AiRecordRef = { type: string; id: string };

export type AiActionEntry = {
  occurredAt?: Date;
  organizationId: string;
  propertyId?: string | null;
  userId: string;
  surface: AiSurface;
  /** The outside AI app's client id (MCP) or our own feature, e.g. "pms_inbox". */
  client: string;
  connectionId?: string | null;
  conversationId?: string | null;
  action: string;
  actionVersion?: number;
  group: AiActionGroup;
  /** Raw arguments; redacted here, never stored as given. */
  arguments?: unknown;
  /**
   * Keys whose value the input schema already limits to a fixed set or format (an enum, a
   * language code); a single short token there is kept. Never a free-text field.
   */
  keepArgumentKeys?: readonly string[];
  recordsRead?: readonly AiRecordRef[];
  recordsChanged?: readonly AiRecordRef[];
  outcome: AiActionOutcome;
  errorCode?: string | null;
  latencyMs: number;
  /** Guest text, contact data or finance read (R2): a security event. */
  sensitive?: boolean;
  /** The tool-call id, also the request id the route saw. */
  requestId: string;
  correlationId?: string | null;
  /** The Idempotency-Key sent to the route; only its SHA-256 is stored. */
  idempotencyKey?: string | null;
  operationId?: string | null;
  /** Provider tool-call id or MCP JSON-RPC id: logged, never the identity. */
  externalCallId?: string | null;
  /** provider/model/region for model calls we pay for (in-app, Inbox assist, Concierge). */
  model?: string | null;
};

export type AiActionLog = { record(entry: AiActionEntry): Promise<void> };

export type AiActionLogQueryable = {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const TOKEN = /^[A-Za-z0-9_.:-]{1,40}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RECORD_TYPE = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_RECORDS = 200;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 5;

/**
 * Ids, dates, numbers and booleans stay; every other string is reduced to its length. Keys stay
 * only when they look like schema field names; any other key (a map keyed by text) is numbered.
 */
export function redactArguments(value: unknown, keepKeys: readonly string[] = []): unknown {
  const keep = new Set(keepKeys);
  const redact = (node: unknown, key: string | null, depth: number): unknown => {
    if (node === null || typeof node === "boolean") return node;
    if (typeof node === "number") return Number.isFinite(node) ? node : null;
    if (typeof node === "string") {
      if (UUID.test(node) || DATE.test(node)) return node;
      if (key !== null && keep.has(key) && TOKEN.test(node)) return node;
      return `[text:${Array.from(node).length}]`;
    }
    if (depth >= MAX_DEPTH || typeof node !== "object") return "[omitted]";
    if (Array.isArray(node)) {
      const items = node.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, key, depth + 1));
      if (node.length > MAX_ARRAY_ITEMS) items.push(`[+${node.length - MAX_ARRAY_ITEMS} more]`);
      return items;
    }
    return Object.fromEntries(
      Object.entries(node).map(([k, child], index) =>
        KEY.test(k)
          ? [k, redact(child, k, depth + 1)]
          : [`[key:${index}]`, redact(child, null, depth + 1)],
      ),
    );
  };
  return redact(value ?? {}, null, 0);
}

function recordRefs(refs: readonly AiRecordRef[] | undefined): AiRecordRef[] {
  const seen = new Map<string, AiRecordRef>();
  for (const ref of refs ?? []) {
    if (!RECORD_TYPE.test(ref.type) || !UUID.test(ref.id))
      throw new TypeError("AI action records are a type and a UUID");
    seen.set(`${ref.type}:${ref.id.toLowerCase()}`, { type: ref.type, id: ref.id.toLowerCase() });
  }
  return [...seen.values()].slice(0, MAX_RECORDS);
}

function optionalUuid(value: string | null | undefined, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (!UUID.test(value)) throw new TypeError(`AI action ${name} must be a UUID`);
  return value;
}

/** Writes one row with any client, so a route can log inside its own transaction. */
export async function insertAiToolCall(
  client: AiActionLogQueryable,
  entry: AiActionEntry,
): Promise<void> {
  if (!Number.isSafeInteger(entry.latencyMs) || entry.latencyMs < 0)
    throw new TypeError("AI action latencyMs must be a non-negative integer");
  await client.query(
    `INSERT INTO platform.ai_tool_calls
       (occurred_at, organization_id, property_id, user_id, surface, client, connection_id,
        conversation_id, action, action_version, action_group, arguments, records_read,
        records_changed, outcome, error_code, latency_ms, sensitive, request_id, correlation_id,
        idempotency_key_hash, operation_id, external_call_id, model)
     VALUES ($1::timestamptz, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, $8::uuid, $9, $10,
             $11, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20, $21,
             $22::uuid, $23, $24)`,
    [
      (entry.occurredAt ?? new Date()).toISOString(),
      optionalUuid(entry.organizationId, "organizationId"),
      optionalUuid(entry.propertyId, "propertyId"),
      optionalUuid(entry.userId, "userId"),
      entry.surface,
      entry.client,
      optionalUuid(entry.connectionId, "connectionId"),
      optionalUuid(entry.conversationId, "conversationId"),
      entry.action,
      entry.actionVersion ?? 1,
      entry.group,
      JSON.stringify(redactArguments(entry.arguments, entry.keepArgumentKeys)),
      JSON.stringify(recordRefs(entry.recordsRead)),
      JSON.stringify(recordRefs(entry.recordsChanged)),
      entry.outcome,
      entry.errorCode ?? null,
      entry.latencyMs,
      entry.sensitive ?? false,
      entry.requestId,
      entry.correlationId ?? null,
      entry.idempotencyKey ? createHash("sha256").update(entry.idempotencyKey).digest("hex") : null,
      optionalUuid(entry.operationId, "operationId"),
      entry.externalCallId ?? null,
      entry.model ?? null,
    ],
  );
}

export function createPgAiActionLog(config: {
  connectionString: string;
  max?: number;
  pool?: AiActionLogQueryable & { end(): Promise<void> };
}): AiActionLog & { close(): Promise<void> } {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("AI action log connectionString must not be empty");
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  return {
    record: (entry) => insertAiToolCall(pool, entry),
    close: () => pool.end(),
  };
}

export type AiActionRunResult<T> = {
  value: T;
  outcome?: AiActionOutcome;
  errorCode?: string | null;
  recordsRead?: readonly AiRecordRef[];
  recordsChanged?: readonly AiRecordRef[];
};

/**
 * The hook for the action runner (VAY-2506/2507): runs one action and writes exactly one row,
 * whether it succeeds, is refused or throws. If the row can not be written, a successful result
 * is not handed back (an AI action that is not logged did not happen as far as the AI knows); a
 * thrown action error stays the error the caller sees.
 */
export async function withAiActionLog<T>(
  log: AiActionLog,
  entry: Omit<AiActionEntry, "outcome" | "latencyMs" | "recordsRead" | "recordsChanged">,
  run: () => Promise<AiActionRunResult<T>>,
  clock: () => number = () => performance.now(),
): Promise<T> {
  const started = clock();
  const occurredAt = entry.occurredAt ?? new Date();
  const latency = () => Math.max(0, Math.round(clock() - started));
  let result: AiActionRunResult<T>;
  try {
    result = await run();
  } catch (error) {
    await log
      .record({ ...entry, occurredAt, outcome: "failed", latencyMs: latency() })
      .catch(() => undefined);
    throw error;
  }
  await log.record({
    ...entry,
    occurredAt,
    outcome: result.outcome ?? "ok",
    errorCode: result.errorCode ?? null,
    latencyMs: latency(),
    recordsRead: result.recordsRead,
    recordsChanged: result.recordsChanged,
  });
  return result.value;
}
