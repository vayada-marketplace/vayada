import { hashTargetRow, type Json } from "./channexAdoptionManifestCrypto.js";
import {
  readOrganizationMappingRow,
  type AdoptionQueryClient,
} from "./channexAdoptionTargetRows.js";
import {
  identityMigrationXmin,
  identityMigrationXidWithinHorizon,
} from "./productionIdentityProvenance.js";

type MappingValues = {
  workos_org_id: string | null;
  workos_external_id: string | null;
  updated_at: string;
};
type State = { rowStateSha256: string; transactionId: string; values: MappingValues };
type Receipt = { after_sha256: string; after_status: string; before_status: string | null };
export type OrganizationMappingProof = {
  organizationId: string;
  sourceRunId: string;
  planSha256: string;
  before: State;
  after: State;
};
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const fullXid = (value: string) =>
  /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
function exactValues(values: MappingValues): boolean {
  return (
    values != null &&
    Object.keys(values).sort().join(",") === "updated_at,workos_external_id,workos_org_id" &&
    typeof values.updated_at === "string" &&
    timestamp.test(values.updated_at)
  );
}

/** Internal structural proof only, NOT an authorization decision. Caller must authenticate
 * the mapping receipt/approved provider ID, check live authorities and ownership, and own
 * a repeatable-read snapshot. No receipt persistence, provider calls or runtime export.
 * Contract: engineering/legacy-pms-workos-mapping-proof.md. */
export async function verifyOrganizationMappingProof(
  client: AdoptionQueryClient,
  input: OrganizationMappingProof,
  expectedWorkosOrgId: string,
): Promise<boolean> {
  const proof = structuredClone(input);
  const { before, after, organizationId } = proof;
  if (
    !exactValues(before.values) ||
    !exactValues(after.values) ||
    before.values.updated_at === after.values.updated_at ||
    !fullXid(before.transactionId) ||
    !fullXid(after.transactionId) ||
    BigInt(after.transactionId) <= BigInt(before.transactionId) ||
    !/^org_[A-Za-z0-9]+$/.test(expectedWorkosOrgId) ||
    after.values.workos_org_id !== expectedWorkosOrgId ||
    after.values.workos_external_id !== organizationId
  )
    return false;
  for (const field of ["workos_org_id", "workos_external_id"] as const)
    if (before.values[field] !== null && before.values[field] !== after.values[field]) return false;
  if (
    before.values.workos_org_id === after.values.workos_org_id &&
    before.values.workos_external_id === after.values.workos_external_id
  )
    return false;
  const metadata = await client.query<{ xmin: string; current_xid: string; isolation: string }>(
    `SELECT xmin::text, pg_snapshot_xmax(pg_current_snapshot())::text AS current_xid,
      current_setting('transaction_isolation') AS isolation
     FROM identity.organizations WHERE id = $1::uuid`,
    [organizationId],
  );
  const current = metadata.rows[0];
  if (
    !current ||
    !["repeatable read", "serializable"].includes(current.isolation) ||
    identityMigrationXmin(after.transactionId) !== BigInt(current.xmin) ||
    !identityMigrationXidWithinHorizon(before.transactionId, current.current_xid) ||
    !identityMigrationXidWithinHorizon(after.transactionId, current.current_xid)
  )
    return false;
  const original = await client.query<Receipt>(
    `SELECT after_sha256, after_status, before_status FROM platform.identity_migration_provenance
     WHERE source_run_id = $1 AND plan_sha256 = $2 AND target_table = 'identity.organizations'
       AND target_id = $3::uuid AND transaction_id = $4::xid8`,
    [proof.sourceRunId, proof.planSha256, organizationId, before.transactionId],
  );
  const receipt = original.rows[0];
  if (
    !receipt ||
    receipt.after_status !== "suspended" ||
    (receipt.before_status !== null && receipt.before_status !== "active") ||
    receipt.after_sha256 !== before.rowStateSha256
  )
    return false;
  const row = await readOrganizationMappingRow(client, organizationId);
  const hash = (value: Record<string, Json>) =>
    hashTargetRow({
      schema: "identity",
      table: "organizations",
      primaryKey: organizationId,
      row: value,
    });
  return (
    row["status"] === "suspended" &&
    row["kind"] === "hotel_group" &&
    Object.entries(after.values).every(([key, value]) => row[key] === value) &&
    hash(row) === after.rowStateSha256 &&
    hash({ ...row, ...before.values }) === before.rowStateSha256
  );
}
