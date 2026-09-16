import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import {
  compareLegacyOwnershipBeforeState,
  LEGACY_OWNERSHIP_ROW_TABLES,
} from "./legacyOwnershipBeforeState.js";
import type { LegacyOwnerEvidenceRequest } from "./legacyOwnerEvidenceSnapshot.js";
import { readLegacyOwnershipTargetEvidence } from "./legacyOwnershipRelationships.js";
import {
  verifyLegacyCurrentOwnerIdentity,
  type VerifiedLegacyOwnerSession,
} from "./legacyCurrentOwnerIdentity.js";

/** Internal target-only prerequisite, never eligibility or mutation authority.
 * Call after approval/binding locks in a bounded READ COMMITTED transaction.
 * Session must already be backend-auth verified, never constructed from JSON.
 * SHARE NOWAIT fences ownership/identity phantoms from ordinary writers that do
 * not use migration advisory locks. Success retains locks until outer completion;
 * failure rolls back this helper's locks and requires aborting the command.
 */
export async function lockLegacyHistoricalBindingOwner(
  client: AdoptionQueryClient,
  request: LegacyOwnerEvidenceRequest,
  verifiedSession: VerifiedLegacyOwnerSession,
) {
  const expected = structuredClone(request);
  const session = structuredClone(verifiedSession);
  if (compareLegacyOwnershipBeforeState(expected.target, expected.target).outcome !== "unchanged")
    throw new Error("HISTORICAL_OWNER_INVALID_EXPECTATION");
  const id = (kind: keyof typeof LEGACY_OWNERSHIP_ROW_TABLES) =>
    expected.target.find((row) => row.kind === kind)!.id;
  if (
    expected.source.ownerUserId !== id("user") ||
    expected.identity.userId !== id("user") ||
    expected.identity.organizationId !== id("organization") ||
    [id("property"), expected.source.legacyHotelId].some((value) =>
      ["17621565-40b5-4ebc-8727-3a301ac947a2", "65f6b2fc-c783-4963-9d6b-a85f82319769"].includes(
        value,
      ),
    )
  )
    throw new Error("HISTORICAL_OWNER_INVALID_EXPECTATION");
  await client.query("SAVEPOINT vay2017_historical_owner");
  try {
    await client.query("SET LOCAL search_path=pg_catalog,pg_temp; SET LOCAL row_security=off");
    const settings = await client.query<{ valid: boolean }>(`SELECT
      current_setting('transaction_isolation')='read committed'
      AND current_setting('lock_timeout')<>'0' AND current_setting('statement_timeout')<>'0' AS valid`);
    if (settings.rows.length !== 1 || settings.rows[0]?.valid !== true) throw new Error();
    const tables = [
      ...new Set([...Object.values(LEGACY_OWNERSHIP_ROW_TABLES), "identity.external_identities"]),
    ].sort();
    // Fixed code-owned identifiers only. NOWAIT fails rather than pausing live writers.
    await client.query(`LOCK TABLE ${tables.join(",")} IN SHARE MODE NOWAIT`);
    const access = await client.query<{ complete: boolean }>(
      `SELECT count(*)=$2 AND bool_and(relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
        AND has_table_privilege(c.oid,'SELECT')) AS complete
       FROM pg_catalog.pg_class c WHERE c.oid=ANY($1::regclass[])`,
      [tables, tables.length],
    );
    if (access.rows.length !== 1 || access.rows[0]?.complete !== true) throw new Error();
    const relationships = await readLegacyOwnershipTargetEvidence(
      client,
      expected.target,
      expected.source.legacyHotelId,
    );
    if (relationships.outcome !== "target_matches") throw new Error();
    const identity = await verifyLegacyCurrentOwnerIdentity(client, expected.identity, session);
    if (identity.outcome !== "identity_matches") throw new Error();
    await client.query("RELEASE SAVEPOINT vay2017_historical_owner");
    return Object.freeze({
      outcome: "owner_locked_requires_source_and_disposition" as const,
      executable: false as const,
      userStatus: identity.userStatus,
      organizationStatus: identity.organizationStatus,
    });
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT vay2017_historical_owner");
    await client.query("RELEASE SAVEPOINT vay2017_historical_owner");
    throw new Error("HISTORICAL_OWNER_LOCK_OR_EVIDENCE_FAILED");
  }
}
