import { createHash } from "node:crypto";

const DOMAIN = "vayada:channex-property-adoption:v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RowEvidence = { rowOrdinal: number; rowChecksumSha256: string };
type TargetRow = { id: string; rowStateSha256: string };

export class ChannexAdoptionManifestError extends Error {
  constructor(
    readonly code: string,
    path = "manifest",
  ) {
    super(`${code}:${path}`);
    this.name = "ChannexAdoptionManifestError";
  }
}

const fail = (code: string, path?: string): never => {
  throw new ChannexAdoptionManifestError(code, path);
};

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("INVALID_UNICODE");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail("INVALID_UNICODE");
  }
}

export function canonicalizeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): string => {
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "string") {
      assertUnicode(item);
      return JSON.stringify(item);
    }
    if (typeof item === "number")
      return Number.isFinite(item) ? JSON.stringify(item) : fail("INVALID_NUMBER");
    if (!item || typeof item !== "object") return fail("INVALID_JSON_VALUE");
    if (seen.has(item)) return fail("CYCLIC_JSON");
    seen.add(item);
    if (Array.isArray(item))
      for (let index = 0; index < item.length; index += 1)
        if (!Object.hasOwn(item, index)) fail("SPARSE_ARRAY", `manifest.${index}`);
    const result = Array.isArray(item)
      ? `[${item.map(visit).join(",")}]`
      : canonicalizeObject(item, visit);
    seen.delete(item);
    return result;
  };
  return visit(value);
}

function canonicalizeObject(item: object, visit: (value: unknown) => string): string {
  const prototype = Object.getPrototypeOf(item);
  if (prototype !== Object.prototype && prototype !== null) return fail("INVALID_JSON_OBJECT");
  return `{${Object.keys(item)
    .sort()
    .map((key) => {
      assertUnicode(key);
      return `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key])}`;
    })
    .join(",")}}`;
}

const domainHash = (suffix: string, body: string): string =>
  createHash("sha256").update(`${DOMAIN}${suffix}\0`, "utf8").update(body, "utf8").digest("hex");

export const hashApprovalSubject = (manifest: Record<string, unknown>): string => {
  const neutral = Object.fromEntries(
    Object.entries(manifest).filter(
      ([key]) => key !== "approvalSubjectSha256" && key !== "approvalEvidence",
    ),
  );
  return domainHash("approval-subject", canonicalizeJson(neutral));
};
export const hashManifestPayload = (manifest: unknown): string =>
  domainHash("payload", canonicalizeJson(manifest));
export const hashTargetRow = (row: Json): string => domainHash("target-row", canonicalizeJson(row));
export const hashRollbackReason = (reason: string): string => {
  assertUnicode(reason);
  return domainHash("rollback-reason", reason);
};
export const hashRollbackSubject = (input: {
  manifestId: string;
  claimId: string;
  environment: string;
  expiresAt: string;
  rollbackReasonSha256: string;
}): string => domainHash("rollback-subject", canonicalizeJson(input));

export type SourceLedger = {
  run: {
    run_id: string;
    environment: string;
    source_schema_revision: string;
    cutover_freeze_proof_sha256: string | null;
    status: string;
    finished_at: string;
  };
  sources: {
    source_database: string;
    snapshot_identifier_sha256: string;
    expected_database_name_sha256: string;
    expected_schema_fingerprint: string;
    actual_schema_fingerprint: string;
    status: string;
    row_count: number;
    checksum_sha256: string;
    source_snapshot_at: string;
  }[];
  tables: {
    source_database: string;
    source_schema: string;
    source_table: string;
    status: string;
    row_count: number;
    checksum_sha256: string;
  }[];
};

export function hashSourceLedger(ledger: SourceLedger): string {
  assertStrictOrder(ledger.sources, ({ source_database }) => source_database, "sources");
  assertStrictOrder(
    ledger.tables,
    ({ source_database, source_schema, source_table }) =>
      `${source_database}\0${source_schema}\0${source_table}`,
    "tables",
  );
  const projected: SourceLedger = {
    run: {
      run_id: ledger.run.run_id,
      environment: ledger.run.environment,
      source_schema_revision: ledger.run.source_schema_revision,
      cutover_freeze_proof_sha256: ledger.run.cutover_freeze_proof_sha256,
      status: ledger.run.status,
      finished_at: ledger.run.finished_at,
    },
    sources: ledger.sources.map((source) => ({
      source_database: source.source_database,
      snapshot_identifier_sha256: source.snapshot_identifier_sha256,
      expected_database_name_sha256: source.expected_database_name_sha256,
      expected_schema_fingerprint: source.expected_schema_fingerprint,
      actual_schema_fingerprint: source.actual_schema_fingerprint,
      status: source.status,
      row_count: source.row_count,
      checksum_sha256: source.checksum_sha256,
      source_snapshot_at: source.source_snapshot_at,
    })),
    tables: ledger.tables.map((table) => ({
      source_database: table.source_database,
      source_schema: table.source_schema,
      source_table: table.source_table,
      status: table.status,
      row_count: table.row_count,
      checksum_sha256: table.checksum_sha256,
    })),
  };
  return domainHash("source-ledger", canonicalizeJson(projected));
}

function assertStrictOrder<T>(rows: readonly T[], key: (row: T) => string, path: string): void {
  let previous: string | undefined;
  rows.forEach((row, index) => {
    const current = key(row);
    if (previous !== undefined && current <= previous)
      fail("INVALID_ROW_ORDER", `${path}.${index}`);
    previous = current;
  });
}
export const hashSnapshotIdentifier = (value: string): string => {
  assertUnicode(value);
  return domainHash("snapshot-identifier", value);
};
export const hashExpectedDatabaseName = (value: string): string => {
  assertUnicode(value);
  return domainHash("expected-database-name", value);
};

export type SourceAggregate =
  | "pms-channex-room-type-mappings"
  | "pms-channex-rate-plan-mappings"
  | "pms-channex-booking-mappings"
  | "pms-bookings";

export function hashOrderedSourceRows(kind: SourceAggregate, rows: readonly RowEvidence[]): string {
  let previous = 0;
  const body = rows
    .map((row, index) => {
      if (!Number.isSafeInteger(row.rowOrdinal) || row.rowOrdinal < 1)
        fail("INVALID_INTEGER", `rows.${index}.rowOrdinal`);
      if (!SHA256.test(row.rowChecksumSha256))
        fail("INVALID_VALUE", `rows.${index}.rowChecksumSha256`);
      if (row.rowOrdinal <= previous) fail("INVALID_ROW_ORDER", `rows.${index}`);
      previous = row.rowOrdinal;
      return `${row.rowOrdinal}|${row.rowChecksumSha256}\n`;
    })
    .join("");
  return domainHash(kind, body);
}

export function hashTargetBindingClaims(rows: readonly TargetRow[]): string {
  let previous = "";
  const body = rows
    .map((row, index) => {
      if (!UUID.test(row.id)) fail("INVALID_VALUE", `claims.${index}.id`);
      if (!SHA256.test(row.rowStateSha256)) fail("INVALID_VALUE", `claims.${index}.rowStateSha256`);
      if (row.id <= previous) fail("INVALID_ROW_ORDER", `claims.${index}`);
      previous = row.id;
      return `${row.id}|${row.rowStateSha256}\n`;
    })
    .join("");
  return domainHash("target-binding-claims", body);
}

export function classifyManifestConsumption(
  existing: { payloadSha256: string; outcome: "succeeded" | "failed" } | null,
  payloadSha256: string,
): "new" | "exact_replay" | "payload_drift" | "stored_failure" {
  if (!existing) return "new";
  if (existing.payloadSha256 !== payloadSha256) return "payload_drift";
  return existing.outcome === "failed" ? "stored_failure" : "exact_replay";
}
