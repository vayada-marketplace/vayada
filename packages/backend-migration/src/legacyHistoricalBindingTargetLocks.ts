import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import { readLegacyHistoricalBindingTargetRow as fingerprint } from "./channexAdoptionTargetRows.js";
import {
  evaluateLegacyHistoricalBinding,
  type LegacyHistoricalBindingObserved,
} from "./legacyHistoricalBindingPreflight.js";
import type { LegacyHistoricalBindingApprovalEvidence } from "./legacyHistoricalBindingEnvelope.js";

/** Internal prepare-only prerequisite, not authority or eligibility. Caller owns a
 * bounded READ COMMITTED transaction, verifies approvals first, then independently
 * validates current owner/source evidence and expiry before any atomic mutation.
 * Success retains all locks until outer transaction end. No provider/claim writes.
 * Connection SHARE NOWAIT fences retained-ID phantoms outside advisory protocol.
 * Failure releases this helper's partial locks; caller must abort the command. */
export async function lockLegacyHistoricalBindingTarget(
  client: AdoptionQueryClient,
  evidence: {
    binding: Pick<
      LegacyHistoricalBindingApprovalEvidence["binding"],
      "bindingExpected" | "property"
    >;
    sourceActive: boolean;
  },
): Promise<{ outcome: "target_locked_requires_owner_and_source"; executable: false }> {
  const expected = structuredClone(evidence);
  const binding = expected.binding.bindingExpected;
  const source = {
    sourceRunId: binding.sourceRunId,
    sourceConnections: [{ ...binding.source, active: expected.sourceActive }],
  };
  const empty = evaluateLegacyHistoricalBinding(binding, {
    ...source,
    claims: [],
    connections: [],
  });
  if (empty.outcome !== "blocked" || empty.reason !== "claim_mismatch")
    throw new Error("HISTORICAL_TARGET_INVALID_EXPECTATION");
  await client.query("SAVEPOINT vay2017_historical_target");
  try {
    await client.query("SET LOCAL search_path=pg_catalog");
    const settings = await client.query<{ valid: boolean }>(`SELECT
      current_setting('transaction_isolation')='read committed'
      AND current_setting('lock_timeout')<>'0' AND current_setting('statement_timeout')<>'0' AS valid`);
    if (settings.rows.length !== 1 || settings.rows[0]?.valid !== true) throw new Error();
    await client.query("LOCK TABLE pms.channel_connections IN SHARE MODE NOWAIT");
    for (const key of [
      `channex.management:${binding.propertyId}`,
      `channex.external-property:${binding.source.externalPropertyId}`,
    ].sort()) {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
        [key],
      );
      if (lock.rows[0]?.acquired !== true) throw new Error();
    }
    const tables = [
      "hotel_catalog.properties",
      "pms.channel_binding_claims",
      "pms.channel_connections",
    ] as const;
    await client.query(
      "LOCK TABLE hotel_catalog.properties,pms.channel_binding_claims IN ACCESS SHARE MODE NOWAIT",
    );
    const access = await client.query<{ complete: boolean }>(
      `SELECT count(*)=3
      AND bool_and(NOT relrowsecurity AND has_table_privilege(oid,'SELECT')) AS complete
      FROM pg_class WHERE oid=ANY($1::regclass[])`,
      [tables],
    );
    if (access.rows.length !== 1 || access.rows[0]?.complete !== true) throw new Error();
    const property = await client.query<{ id: string }>(
      "SELECT id::text FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE NOWAIT",
      [binding.propertyId],
    );
    if (property.rows.length !== 1 || expected.binding.property.id !== binding.propertyId)
      throw new Error();
    if (
      (await fingerprint(client, tables[0], binding.propertyId)).rowStateSha256 !==
      expected.binding.property.rowStateSha256
    )
      throw new Error();
    const claims = await client.query<
      Omit<LegacyHistoricalBindingObserved["claims"][number], "rowStateSha256">
    >(
      `SELECT id::text,property_id::text AS "propertyId",provider,external_property_id AS "externalPropertyId",
       claim_state AS "claimState",claim_source AS "claimSource" FROM pms.channel_binding_claims
       WHERE provider='channex' AND (property_id=$1::uuid OR external_property_id=$2)
       ORDER BY id FOR UPDATE NOWAIT`,
      [binding.propertyId, binding.source.externalPropertyId],
    );
    const connections = await client.query<
      Omit<LegacyHistoricalBindingObserved["connections"][number], "rowStateSha256">
    >(
      `SELECT id::text,property_id::text AS "propertyId",provider,connection_status AS "connectionStatus",
       external_property_id AS "externalPropertyId",connection_metadata->>'legacyExternalPropertyId' AS "legacyExternalPropertyId",
       connection_metadata->>'migrationRunId' AS "migrationRunId" FROM pms.channel_connections
       WHERE provider='channex' AND (property_id=$1::uuid OR external_property_id=$2
       OR connection_metadata->>'legacyExternalPropertyId'=$2) ORDER BY id`,
      [binding.propertyId, binding.source.externalPropertyId],
    );
    const observed: LegacyHistoricalBindingObserved = { ...source, claims: [], connections: [] };
    observed.claims = await Promise.all(
      claims.rows.map(async (row) => ({
        ...row,
        ...(await fingerprint(client, tables[1], row.id)),
      })),
    );
    observed.connections = await Promise.all(
      connections.rows.map(async (row) => ({
        ...row,
        ...(await fingerprint(client, tables[2], row.id)),
      })),
    );
    if (
      evaluateLegacyHistoricalBinding(binding, observed).outcome !==
      "supplied_binding_matches_requires_owner_eligibility"
    )
      throw new Error();
    await client.query("RELEASE SAVEPOINT vay2017_historical_target");
    return { outcome: "target_locked_requires_owner_and_source", executable: false };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT vay2017_historical_target");
    await client.query("RELEASE SAVEPOINT vay2017_historical_target");
    throw new Error("HISTORICAL_TARGET_LOCK_OR_EVIDENCE_FAILED", { cause: error });
  }
}
