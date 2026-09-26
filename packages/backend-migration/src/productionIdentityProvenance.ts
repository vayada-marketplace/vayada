import type pg from "pg";
import { readIdentityMigrationTargetRow } from "./channexAdoptionTargetRows.js";
import type { CoreIdentityWritePlan } from "./productionIdentityCoreWriter.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

type QueryClient = Pick<pg.ClientBase, "query">;
type Table =
  | "identity.users"
  | "identity.organizations"
  | "identity.organization_memberships"
  | "identity.organization_resource_links";
type Row = { table: Table; id: string; status: string; xmin: string; rowStateSha256: string };

export const identityMigrationXmin = (transactionId: string): bigint =>
  BigInt(transactionId) % 4_294_967_296n;

export function identityMigrationXidWithinHorizon(transactionId: string, currentXid: string) {
  const age = BigInt(currentXid) - BigInt(transactionId);
  return age >= 0n && age < 2_147_483_648n;
}

/** Only planned PMS-owner chains; no global identity history or retroactive attribution. */
export async function readProductionIdentityProvenance(
  client: QueryClient,
  plan: CoreIdentityWritePlan,
  sourceRows: IdentitySourceRow[],
): Promise<Row[]> {
  const sourceOwners = new Map(
    sourceRows
      .filter(
        (row) =>
          row.sourceDatabase === "pms" &&
          row.sourceTable === "hotels" &&
          typeof row.data["id"] === "string" &&
          typeof row.data["user_id"] === "string",
      )
      .map((row) => [
        (row.data["id"] as string).toLowerCase(),
        (row.data["user_id"] as string).toLowerCase(),
      ]),
  );
  const links = plan.resourceLinks.filter(
    (row) =>
      row.product === "pms" &&
      row.resourceType === "pms_hotel" &&
      row.relationship === "operator" &&
      sourceOwners.has(row.resourceId),
  );
  const organizations = [...new Set(links.map((row) => row.organizationId))];
  if (organizations.length === 0) return [];
  const ownerPairs = new Set(
    links.map((row) => `${row.organizationId}:${sourceOwners.get(row.resourceId)}`),
  );
  const memberships = plan.memberships.filter(
    (row) =>
      ownerPairs.has(`${row.organizationId}:${row.userId}`) &&
      row.roleKey === "hotel_owner" &&
      row.accessOrigin === "agency",
  );
  const users = [...new Set(memberships.map((row) => row.userId))];
  const scopes: [Table, string, unknown][] = [
    ["identity.users", "id = ANY($1::uuid[])", users],
    ["identity.organizations", "id = ANY($1::uuid[])", organizations],
    [
      "identity.organization_memberships",
      `(organization_id,user_id) IN (
      SELECT "organizationId","userId" FROM jsonb_to_recordset($1::jsonb)
      AS scope("organizationId" uuid,"userId" uuid))`,
      JSON.stringify(memberships),
    ],
    [
      "identity.organization_resource_links",
      `(organization_id,product,resource_type,resource_id,relationship) IN (
      SELECT "organizationId",product,"resourceType","resourceId",relationship
      FROM jsonb_to_recordset($1::jsonb)
      AS scope("organizationId" uuid,product text,"resourceType" text,"resourceId" text,relationship text))`,
      JSON.stringify(links),
    ],
  ];
  const rows: Row[] = [];
  for (const [table, predicate, keys] of scopes) {
    const result = await client.query<{ id: string; status: string; xmin: string }>(
      `SELECT id::text, status, xmin::text FROM ${table} WHERE ${predicate} ORDER BY id`,
      [keys],
    );
    for (const row of result.rows)
      rows.push({
        table,
        ...row,
        ...(await readIdentityMigrationTargetRow(client, table, row.id)),
      });
  }
  return rows;
}

/** Caller owns the identity migration's locks and transaction; call immediately before commit. */
export async function writeProductionIdentityProvenance(
  client: QueryClient,
  input: { sourceRunId: string; checksum: string; before: Row[]; after: Row[] },
): Promise<void> {
  const transaction = await client.query<{ id: string }>("SELECT pg_current_xact_id()::text AS id");
  const xid = identityMigrationXmin(transaction.rows[0]!.id);
  const previous = new Map(input.before.map((row) => [`${row.table}:${row.id}`, row]));
  for (const row of input.after) {
    const before = previous.get(`${row.table}:${row.id}`);
    // A no-op/replay or a newer target denial must never acquire migration provenance.
    if (BigInt(row.xmin) !== xid || before?.rowStateSha256 === row.rowStateSha256) continue;
    const result = await client.query(
      `INSERT INTO platform.identity_migration_provenance
       (source_run_id, plan_sha256, target_table, target_id,
        before_sha256, before_status, after_sha256, after_status)
       SELECT run_id, $2, $3, $4::uuid, $5, $6, $7, $8
       FROM platform.source_extraction_runs WHERE run_id = $1 AND status = 'completed'
       RETURNING target_id`,
      [
        input.sourceRunId,
        input.checksum,
        row.table,
        row.id,
        before?.rowStateSha256 ?? null,
        before?.status ?? null,
        row.rowStateSha256,
        row.status,
      ],
    );
    if (result.rowCount !== 1)
      throw new Error("Identity provenance requires a completed source run");
  }
}
