import { createHash } from "node:crypto";
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
// Applicable SELECT/ALL policy inventory through 0468, including the native logo guard.
const TARGET_SELECT_POLICY_SHA256 =
  "864738a880ec3dbc172d8e9be0b98eeeeec2db5c21aa7e6a29597f983339d89b";

async function assertRestrictedReaderIdentity(client: pg.PoolClient): Promise<void> {
  const identity = await client.query<{ complete: boolean }>(
    `WITH matched AS (
       SELECT r.*,regexp_match(r.rolname,
         '^vay2017_preflight_(prepare|execute)_([0-9]{1,20})_([0-9]{1,3})$') AS parts
       FROM pg_roles r WHERE r.rolname=current_user
     ) SELECT count(*)=1 AND bool_and(
       current_user=session_user AND parts IS NOT NULL AND rolcanlogin
       AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolinherit
       AND NOT rolbypassrls AND NOT rolreplication AND rolconnlimit=2
       AND rolvaliduntil>statement_timestamp()
       AND shobj_description(matched.oid,'pg_authid')=
         'vayada:vay2017-preflight:'||parts[2]||'-'||parts[3]||':'||parts[1]
       AND NOT EXISTS(SELECT 1 FROM pg_roles granted
         WHERE granted.oid<>matched.oid AND pg_has_role(current_user,granted.oid,'MEMBER'))
     ) AS complete FROM matched`,
  );
  if (identity.rows[0]?.complete !== true)
    throw new Error("Historical binding target visibility is incomplete");
}

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
  let transactionOpen = false;
  let primaryError: unknown;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    // Hold relation definitions stable before checking privileges/RLS or hashing.
    await client.query(`LOCK TABLE hotel_catalog.properties, pms.channel_binding_claims,
      pms.channel_connections IN ACCESS SHARE MODE`);
    const access = await client.query<{ complete: boolean; activeRlsCount: number }>(
      `SELECT count(*) = 3 AND bool_and(has_table_privilege(c.oid, 'SELECT')
        AND c.relrowsecurity AND NOT c.relforcerowsecurity) AS complete,
        count(*) FILTER (WHERE row_security_active(c.oid))::int AS "activeRlsCount"
       FROM pg_class c WHERE c.oid = ANY(ARRAY[
         'hotel_catalog.properties'::regclass, 'pms.channel_binding_claims'::regclass,
         'pms.channel_connections'::regclass])`,
    );
    if (access.rows.length !== 1 || access.rows[0]?.complete !== true)
      throw new Error("Historical binding target visibility is incomplete");
    if (access.rows[0].activeRlsCount !== 0 && access.rows[0].activeRlsCount !== 3)
      throw new Error("Historical binding target visibility is incomplete");
    if (access.rows[0].activeRlsCount === 3) await assertRestrictedReaderIdentity(client);
    const policies =
      access.rows[0].activeRlsCount === 0
        ? null
        : await client.query(
            `SELECT p.polrelid::regclass::text AS relation,p.polname AS name,
         p.polpermissive AS permissive,p.polcmd AS command,
         ARRAY(SELECT CASE WHEN role_oid=0 THEN 'public' ELSE r.rolname END
           FROM unnest(p.polroles) role_oid LEFT JOIN pg_roles r ON r.oid=role_oid
           ORDER BY 1) AS roles,
         pg_get_expr(p.polqual,p.polrelid) AS qual,
         pg_get_expr(p.polwithcheck,p.polrelid) AS "withCheck"
       FROM pg_policy p WHERE p.polrelid=ANY(ARRAY[
         'hotel_catalog.properties'::regclass, 'pms.channel_binding_claims'::regclass,
         'pms.channel_connections'::regclass]) AND p.polcmd IN ('*','r')
         AND EXISTS(SELECT 1 FROM unnest(p.polroles) role_oid
           WHERE role_oid=0 OR pg_has_role(current_user,role_oid,'MEMBER'))
       ORDER BY p.polrelid::regclass::text,p.polname`,
          );
    if (
      policies !== null &&
      createHash("sha256").update(JSON.stringify(policies.rows)).digest("hex") !==
        TARGET_SELECT_POLICY_SHA256
    )
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
    // End the row snapshot so the role recheck sees concurrent catalog changes.
    if (access.rows[0].activeRlsCount === 3) {
      await client.query("COMMIT");
      transactionOpen = false;
      await assertRestrictedReaderIdentity(client);
    }
    return Object.freeze({
      property,
      claims: Object.freeze(claimRows),
      connections: Object.freeze(connectionRows),
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (transactionOpen) await client.query("ROLLBACK");
    } catch (error) {
      discard = true;
      if (primaryError === undefined) throw error;
    } finally {
      client.release(discard);
    }
  }
}
