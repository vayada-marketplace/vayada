import type pg from "pg";
import { readLegacyHistoricalBindingTargetRow } from "./channexAdoptionTargetRows.js";
import type { LegacyHistoricalBindingObserved } from "./legacyHistoricalBindingPreflight.js";

type Claim = LegacyHistoricalBindingObserved["claims"][number];
type Connection = LegacyHistoricalBindingObserved["connections"][number];
export type LegacyHistoricalBindingTargetSnapshot = {
  readonly property: Readonly<{ id: string; profileStatus: string; rowStateSha256: string }>;
  readonly claims: readonly Readonly<Claim>[];
  readonly connections: readonly Readonly<Connection>[];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Owns one target-only read-only snapshot. No source proof, eligibility or execution. */
export async function readLegacyHistoricalBindingTargetSnapshot(
  pool: Pick<pg.Pool, "connect">,
  input: { propertyId: string; externalPropertyId: string },
): Promise<LegacyHistoricalBindingTargetSnapshot> {
  const { propertyId, externalPropertyId } = input;
  if (!UUID.test(propertyId) || !UUID.test(externalPropertyId))
    throw new Error("Invalid historical binding target identifiers");
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // Hold relation definitions stable before checking privileges/RLS or hashing.
    await client.query(`LOCK TABLE hotel_catalog.properties, pms.channel_binding_claims,
      pms.channel_connections IN ACCESS SHARE MODE`);
    const access = await client.query<{ complete: boolean }>(
      `SELECT count(*) = 3 AND bool_and(NOT c.relrowsecurity
        AND has_table_privilege(c.oid, 'SELECT')) AS complete
       FROM pg_class c WHERE c.oid = ANY(ARRAY[
         'hotel_catalog.properties'::regclass, 'pms.channel_binding_claims'::regclass,
         'pms.channel_connections'::regclass])`,
    );
    if (access.rows.length !== 1 || access.rows[0]?.complete !== true)
      throw new Error("Historical binding target visibility is incomplete");
    const properties = await client.query<{ id: string; profileStatus: string }>(
      `SELECT id::text, profile_status AS "profileStatus"
       FROM hotel_catalog.properties WHERE id = $1::uuid`,
      [propertyId],
    );
    if (properties.rows.length !== 1) throw new Error("Historical binding property missing");
    const claims = await client.query<Omit<Claim, "rowStateSha256">>(
      `SELECT id::text, property_id::text AS "propertyId", provider,
         external_property_id AS "externalPropertyId", claim_state AS "claimState",
         claim_source AS "claimSource" FROM pms.channel_binding_claims
       WHERE provider = 'channex' AND (property_id = $1::uuid OR external_property_id = $2)
       ORDER BY id`,
      [propertyId, externalPropertyId],
    );
    const connections = await client.query<Omit<Connection, "rowStateSha256">>(
      `SELECT id::text, property_id::text AS "propertyId", provider,
         connection_status AS "connectionStatus", external_property_id AS "externalPropertyId",
         connection_metadata->>'legacyExternalPropertyId' AS "legacyExternalPropertyId",
         connection_metadata->>'migrationRunId' AS "migrationRunId"
       FROM pms.channel_connections WHERE provider = 'channex' AND
         (property_id = $1::uuid OR external_property_id = $2
          OR connection_metadata->>'legacyExternalPropertyId' = $2) ORDER BY id`,
      [propertyId, externalPropertyId],
    );
    // Malformed retained metadata must not become free-text report output.
    if (
      claims.rows.some((row) => !UUID.test(row.externalPropertyId)) ||
      connections.rows.some(
        (row) =>
          (row.externalPropertyId !== null && !UUID.test(row.externalPropertyId)) ||
          (row.legacyExternalPropertyId !== null && !UUID.test(row.legacyExternalPropertyId)) ||
          (row.migrationRunId !== null && !/^vay1351-[0-9a-f]{24}$/.test(row.migrationRunId)),
      )
    )
      throw new Error("Historical binding target metadata invalid");
    const property = Object.freeze({
      ...properties.rows[0]!,
      ...(await readLegacyHistoricalBindingTargetRow(
        client,
        "hotel_catalog.properties",
        propertyId,
      )),
    });
    const claimRows: Readonly<Claim>[] = [];
    for (const row of claims.rows)
      claimRows.push(
        Object.freeze({
          ...row,
          ...(await readLegacyHistoricalBindingTargetRow(
            client,
            "pms.channel_binding_claims",
            row.id,
          )),
        }),
      );
    const connectionRows: Readonly<Connection>[] = [];
    for (const row of connections.rows)
      connectionRows.push(
        Object.freeze({
          ...row,
          ...(await readLegacyHistoricalBindingTargetRow(
            client,
            "pms.channel_connections",
            row.id,
          )),
        }),
      );
    return Object.freeze({
      property,
      claims: Object.freeze(claimRows),
      connections: Object.freeze(connectionRows),
    });
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      discard = true;
      throw error;
    } finally {
      client.release(discard);
    }
  }
}
