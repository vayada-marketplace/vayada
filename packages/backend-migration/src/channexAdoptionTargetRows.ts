import type pg from "pg";

import { hashTargetRow, type Json } from "./channexAdoptionManifestCrypto.js";
import { rejectAdoption } from "./channexAdoptionConsumptionError.js";
import { LEGACY_OWNERSHIP_ROW_TABLES } from "./legacyOwnershipBeforeState.js";

export type AdoptionQueryClient = Pick<pg.ClientBase, "query">;
export type AdoptionTargetTable =
  | "hotel_catalog.properties"
  | "hotel_catalog.property_source_links"
  | "identity.organization_resource_links"
  | "identity.organizations"
  | "pms.channel_binding_claims";

type Column = { columnName: string; dataType: string; udtName: string };
const TARGET_TABLES = new Set<AdoptionTargetTable>([
  "hotel_catalog.properties",
  "hotel_catalog.property_source_links",
  "identity.organization_resource_links",
  "identity.organizations",
  "pms.channel_binding_claims",
]);

export async function readAdoptionTargetRow(
  client: AdoptionQueryClient,
  table: AdoptionTargetTable,
  id: string,
): Promise<{ id: string; rowStateSha256: string }> {
  if (!TARGET_TABLES.has(table))
    rejectAdoption("UNSUPPORTED_TARGET_TABLE", "Target table is not allowlisted");
  return readTargetRow(client, table, id);
}

/** Separate ownership boundary; the clean-adoption allowlist remains unchanged. */
export async function readLegacyOwnershipTargetRow(
  client: AdoptionQueryClient,
  table:
    | (typeof LEGACY_OWNERSHIP_ROW_TABLES)[keyof typeof LEGACY_OWNERSHIP_ROW_TABLES]
    | "identity.external_identities",
  id: string,
): Promise<{ id: string; rowStateSha256: string }> {
  if (
    table !== "identity.external_identities" &&
    !(Object.values(LEGACY_OWNERSHIP_ROW_TABLES) as readonly string[]).includes(table)
  )
    rejectAdoption("UNSUPPORTED_TARGET_TABLE");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
    rejectAdoption("TARGET_ROW_MISMATCH");
  return readTargetRow(client, table, id);
}

/** Migration accepts the same UUID versions as its planner; other proof boundaries stay unchanged. */
export async function readIdentityMigrationTargetRow(
  client: AdoptionQueryClient,
  table:
    | "identity.users"
    | "identity.organizations"
    | "identity.organization_memberships"
    | "identity.organization_resource_links",
  id: string,
): Promise<{ id: string; rowStateSha256: string }> {
  if (
    ![
      "identity.users",
      "identity.organizations",
      "identity.organization_memberships",
      "identity.organization_resource_links",
    ].includes(table)
  )
    rejectAdoption("UNSUPPORTED_TARGET_TABLE");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
    rejectAdoption("TARGET_ROW_MISMATCH");
  return readTargetRow(client, table, id);
}

async function readTargetRow(
  client: AdoptionQueryClient,
  table: string,
  id: string,
): Promise<{ id: string; rowStateSha256: string }> {
  const row = await readCanonicalTargetRow(client, table, id);
  const [schema, relation] = table.split(".") as [string, string];
  const normalizedId = id.toLowerCase();
  return {
    id: normalizedId,
    rowStateSha256: hashTargetRow({ schema, table: relation, primaryKey: normalizedId, row }),
  };
}

/** Package-internal proof input, deliberately absent from the package exports. */
export async function readOrganizationMappingRow(client: AdoptionQueryClient, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
    rejectAdoption("TARGET_ROW_MISMATCH");
  return readCanonicalTargetRow(client, "identity.organizations", id);
}

async function readCanonicalTargetRow(
  client: AdoptionQueryClient,
  table: string,
  id: string,
): Promise<Record<string, Json>> {
  const [schema, relation] = table.split(".") as [string, string];
  const columns = await client.query<Column>(
    `SELECT column_name AS "columnName", data_type AS "dataType", udt_name AS "udtName"
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 AND is_generated = 'NEVER'
     ORDER BY ordinal_position`,
    [schema, relation],
  );
  if (columns.rows.length === 0)
    rejectAdoption("TARGET_SCHEMA_MISMATCH", `Target table ${table} is missing`);
  const expressions = columns.rows.map((column) => columnExpression(column)).join(", ");
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${expressions} FROM ${quote(schema)}.${quote(relation)} WHERE id = $1::uuid`,
    [id],
  );
  if (result.rows.length !== 1)
    rejectAdoption("TARGET_ROW_MISMATCH", `Target row ${table}:${id} is not unique`);
  return normalizeJsonColumns(result.rows[0]!, columns.rows) as Record<string, Json>;
}

function normalizeJsonColumns(
  source: Record<string, unknown>,
  columns: readonly Column[],
): Record<string, unknown> {
  const row = { ...source };
  for (const column of columns) {
    if (column.dataType !== "json" && column.dataType !== "jsonb") continue;
    const value = row[column.columnName];
    if (value === null) continue;
    if (typeof value !== "string") rejectAdoption("TARGET_JSON_NOT_IJSON");
    assertLosslessJsonNumbers(value);
    try {
      row[column.columnName] = JSON.parse(value) as Json;
    } catch {
      rejectAdoption("TARGET_JSON_NOT_IJSON");
    }
  }
  return row;
}

function assertLosslessJsonNumbers(serialized: string): void {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character !== "-" && (character < "0" || character > "9")) continue;
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(serialized.slice(index))?.[0];
    if (!token) continue;
    const parsed = Number(token);
    if (
      !Number.isFinite(parsed) ||
      (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) ||
      normalizedDecimal(token) !== normalizedDecimal(String(parsed))
    )
      rejectAdoption("TARGET_JSON_NOT_IJSON");
    index += token.length - 1;
  }
}

function normalizedDecimal(value: string): string {
  const [coefficient, rawExponent = "0"] = value.toLowerCase().split("e");
  const negative = coefficient!.startsWith("-");
  const unsigned = negative ? coefficient!.slice(1) : coefficient!;
  const [integer, fraction = ""] = unsigned.split(".");
  let digits = `${integer}${fraction}`.replace(/^0+/, "");
  let exponent = Number(rawExponent) - fraction.length;
  if (!digits) return "0";
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exponent += 1;
  }
  return `${negative ? "-" : ""}${digits}e${exponent}`;
}

function columnExpression(column: Column): string {
  const name = quote(column.columnName);
  const alias = ` AS ${name}`;
  if (column.dataType === "timestamp with time zone")
    return `CASE WHEN ${name} IS NULL THEN NULL ELSE to_char(${name} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END${alias}`;
  if (column.dataType === "timestamp without time zone")
    return `CASE WHEN ${name} IS NULL THEN NULL ELSE to_char(${name}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END${alias}`;
  if (column.dataType === "date")
    return `CASE WHEN ${name} IS NULL THEN NULL ELSE to_char(${name}, 'YYYY-MM-DD') END${alias}`;
  if (["smallint", "integer", "bigint", "numeric", "decimal"].includes(column.dataType))
    return `CASE WHEN ${name} IS NULL THEN NULL ELSE ${name}::text END${alias}`;
  if (["json", "jsonb"].includes(column.dataType))
    return `CASE WHEN ${name} IS NULL THEN NULL ELSE ${name}::text END${alias}`;
  if (["uuid", "text", "character", "character varying", "boolean"].includes(column.dataType))
    return `${name}${alias}`;
  if (
    column.dataType === "ARRAY" &&
    ["_text", "_varchar", "_bpchar", "_uuid", "_bool"].includes(column.udtName)
  )
    return `${name}${alias}`;
  return rejectAdoption(
    "UNSUPPORTED_TARGET_COLUMN",
    `Unsupported target column ${column.columnName}:${column.dataType}`,
  );
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
