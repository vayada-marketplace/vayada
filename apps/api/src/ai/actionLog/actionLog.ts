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
 * has nothing to remove here). Only argument keys the caller declares are kept, each checked
 * against its kind (an id, a date, an enum value...); records are a type and a UUID; every other
 * text field is a fixed token or, when it is not, its SHA-256.
 */

export type AiSurface = "mcp" | "in_app" | "inbox_assist" | "concierge";
export type AiActionGroup = "R0" | "R1" | "R2-finance" | "R2" | "do" | "ask";
export type AiActionOutcome = "ok" | "denied" | "invalid" | "refused" | "failed";
export type AiRecordRef = { type: string; id: string };

/**
 * How one argument is kept. The runner derives these from the action's input schema: UUID fields
 * are "id", UUID lists "ids", stay dates "date", counts and prices "number", booleans "flag",
 * language codes "language", enums `{ oneOf }`. Free-text fields are never declared, so they are
 * never stored; a value that does not fit its kind is stored as "[invalid]".
 */
export type AiArgumentKind =
  | "id"
  | "ids"
  | "date"
  | "number"
  | "flag"
  | "language"
  | { oneOf: readonly string[] };

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
  /** Raw arguments; only the keys in `argumentKinds` are kept. */
  arguments?: unknown;
  argumentKinds?: Readonly<Record<string, AiArgumentKind>>;
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
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RECORD_TYPE = /^[a-z][a-z0-9_]{1,39}$/;
const ACTION = /^[a-z][a-z0-9_.]{0,79}$/;
const ID_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
const NAME = /^[A-Za-z0-9:/._-]{1,200}$/;
const SURFACES = new Set<string>(["mcp", "in_app", "inbox_assist", "concierge"]);
const GROUPS = new Set<string>(["R0", "R1", "R2-finance", "R2", "do", "ask"]);
const OUTCOMES = new Set<string>(["ok", "denied", "invalid", "refused", "failed"]);
const MAX_RECORDS = 200;
const MAX_IDS = 50;
// jsonb text adds a space after every ':' and ',', so stay well under the table's 16,384.
const MAX_ARGUMENT_BYTES = 8_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function keepArgument(kind: AiArgumentKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const ok = (fits: boolean, kept: unknown = value) => (fits ? kept : "[invalid]");
  if (typeof kind === "object") return ok(typeof value === "string" && kind.oneOf.includes(value));
  switch (kind) {
    case "id":
      return ok(typeof value === "string" && UUID.test(value), String(value).toLowerCase());
    case "ids":
      return ok(
        Array.isArray(value) &&
          value.length <= MAX_IDS &&
          value.every((item) => typeof item === "string" && UUID.test(item)),
        Array.isArray(value) ? value.map((item) => String(item).toLowerCase()) : null,
      );
    case "date":
      return ok(typeof value === "string" && DATE.test(value));
    case "number":
      return ok(typeof value === "number" && Number.isFinite(value));
    case "flag":
      return ok(typeof value === "boolean");
    case "language":
      return ok(typeof value === "string" && LANGUAGE.test(value));
  }
}

/** Only declared top-level keys of their declared kind; the rest is dropped and counted. */
export function redactArguments(
  value: unknown,
  kinds: Readonly<Record<string, AiArgumentKind>> = {},
): Record<string, unknown> {
  const args =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const kept: Record<string, unknown> = {};
  let omitted = value !== null && value !== undefined && args !== value ? 1 : 0;
  for (const key of Object.keys(args)) {
    if (KEY.test(key) && Object.hasOwn(kinds, key))
      kept[key] = keepArgument(kinds[key]!, args[key]);
    else omitted += 1;
  }
  if (omitted > 0) kept._omitted = omitted;
  return Buffer.byteLength(JSON.stringify(kept)) <= MAX_ARGUMENT_BYTES
    ? kept
    : { _omitted: Object.keys(args).length };
}

// Never throws: a reference that is not a type and a UUID is left out.
function recordRefs(refs: readonly AiRecordRef[] | undefined): AiRecordRef[] {
  const seen = new Map<string, AiRecordRef>();
  for (const ref of refs ?? []) {
    if (typeof ref?.type !== "string" || typeof ref.id !== "string") continue;
    if (!RECORD_TYPE.test(ref.type) || !UUID.test(ref.id)) continue;
    seen.set(`${ref.type}:${ref.id.toLowerCase()}`, { type: ref.type, id: ref.id.toLowerCase() });
  }
  return [...seen.values()].slice(0, MAX_RECORDS);
}

function uuid(value: string | null | undefined, name: string, required = false): string | null {
  if (value === null || value === undefined) {
    if (required) throw new TypeError(`AI action ${name} is required`);
    return null;
  }
  if (!UUID.test(value)) throw new TypeError(`AI action ${name} must be a UUID`);
  return value.toLowerCase();
}

// An id or name that is not a plain token is stored as its SHA-256, never as given.
function token(value: string | number | null | undefined, pattern: RegExp): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  return pattern.test(text) ? text : `sha256:${sha256(text)}`;
}

function errorCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
  return code || null;
}

/**
 * The row for an entry, as the database will check it. Throws only for what the caller's own
 * code got wrong (ids, action name, surface, group, outcome); everything else is normalised, so a
 * checked entry is never refused by the insert.
 */
export function toAiToolCallRow(entry: AiActionEntry): unknown[] {
  if (!ACTION.test(entry.action)) throw new TypeError("AI action name is not valid");
  if (!SURFACES.has(entry.surface) || !GROUPS.has(entry.group) || !OUTCOMES.has(entry.outcome))
    throw new TypeError("AI action surface, group or outcome is not valid");
  const version = entry.actionVersion ?? 1;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new TypeError("AI action version must be a positive integer");
  return [
    (entry.occurredAt ?? new Date()).toISOString(),
    uuid(entry.organizationId, "organizationId", true),
    uuid(entry.propertyId, "propertyId"),
    uuid(entry.userId, "userId", true),
    entry.surface,
    token(entry.client, NAME) ?? "unknown",
    uuid(entry.connectionId, "connectionId"),
    uuid(entry.conversationId, "conversationId"),
    entry.action,
    version,
    entry.group,
    JSON.stringify(redactArguments(entry.arguments, entry.argumentKinds)),
    JSON.stringify(recordRefs(entry.recordsRead)),
    JSON.stringify(recordRefs(entry.recordsChanged)),
    entry.outcome,
    errorCode(entry.errorCode),
    Number.isFinite(entry.latencyMs)
      ? Math.min(2_147_483_647, Math.max(0, Math.round(entry.latencyMs)))
      : 0,
    entry.sensitive === true,
    token(entry.requestId, ID_TOKEN) ?? `sha256:${sha256("")}`,
    token(entry.correlationId, ID_TOKEN),
    entry.idempotencyKey ? sha256(entry.idempotencyKey) : null,
    uuid(entry.operationId, "operationId"),
    token(entry.externalCallId, ID_TOKEN),
    token(entry.model, NAME),
  ];
}

/** Writes one row with any client, so a route can log inside its own transaction. */
export async function insertAiToolCall(
  client: AiActionLogQueryable,
  entry: AiActionEntry,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.ai_tool_calls
       (occurred_at, organization_id, property_id, user_id, surface, client, connection_id,
        conversation_id, action, action_version, action_group, arguments, records_read,
        records_changed, outcome, error_code, latency_ms, sensitive, request_id, correlation_id,
        idempotency_key_hash, operation_id, external_call_id, model)
     VALUES ($1::timestamptz, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, $8::uuid, $9, $10,
             $11, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20, $21,
             $22::uuid, $23, $24)`,
    toAiToolCallRow(entry),
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
 * whether it succeeds, is refused or throws. The entry is checked before the action runs, so a
 * row the database would refuse never follows an action that already ran; after it, only the
 * database itself can fail. Then a successful result is not handed back (an AI action that is not
 * logged did not happen as far as the AI knows), and a thrown action error stays the error the
 * caller sees, with the log failure reported to `onLogFailure`. Changes (P4) also get their
 * `ai_operations` row before they run (VAY-2524).
 */
export async function withAiActionLog<T>(
  log: AiActionLog,
  entry: Omit<AiActionEntry, "outcome" | "latencyMs" | "recordsRead" | "recordsChanged">,
  run: () => Promise<AiActionRunResult<T>>,
  options: { clock?: () => number; onLogFailure?: (error: unknown) => void } = {},
): Promise<T> {
  const clock = options.clock ?? (() => performance.now());
  const occurredAt = entry.occurredAt ?? new Date();
  toAiToolCallRow({ ...entry, occurredAt, outcome: "ok", latencyMs: 0 });
  const started = clock();
  const latency = () => clock() - started;
  let result: AiActionRunResult<T>;
  try {
    result = await run();
  } catch (error) {
    await log
      .record({ ...entry, occurredAt, outcome: "failed", latencyMs: latency() })
      .catch((logError: unknown) => options.onLogFailure?.(logError));
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
