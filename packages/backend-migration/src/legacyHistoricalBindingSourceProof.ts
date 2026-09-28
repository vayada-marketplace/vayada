import type pg from "pg";
import { readSourceLedger } from "./channexAdoptionEvidence.js";
import { hashSourceLedger } from "./channexAdoptionManifestCrypto.js";
import { readProductionPmsSnapshot } from "./productionPmsSnapshotReader.js";
import type {
  LegacyHistoricalBindingExpected,
  LegacyHistoricalBindingObserved,
} from "./legacyHistoricalBindingPreflight.js";

export type LegacyHistoricalBindingSourceRequest = {
  sourceRunId: string;
  sourceEnvironment: "local" | "staging" | "preprod" | "production";
  sourceSchemaRevision: string;
  sourceEvidenceSha256: string;
  snapshotIdentifierSha256: string;
  source: LegacyHistoricalBindingExpected["source"];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

/**
 * Recomputes immutable source evidence in one owned snapshot. Expected evidence
 * needs independent authentication; this helper does not authenticate its caller,
 * grant ownership, inspect current target state or authorize a transition.
 */
export async function readLegacyHistoricalBindingSourceProof(
  pool: Pick<pg.Pool, "connect">,
  request: LegacyHistoricalBindingSourceRequest,
): Promise<Readonly<Pick<LegacyHistoricalBindingObserved, "sourceRunId" | "sourceConnections">>> {
  const expected = structuredClone(request);
  const source = expected.source;
  if (
    !/^vay1351-[0-9a-f]{24}$/.test(expected.sourceRunId) ||
    !["local", "staging", "preprod", "production"].includes(expected.sourceEnvironment) ||
    !/^[0-9a-f]{40}$/.test(expected.sourceSchemaRevision) ||
    ![
      expected.sourceEvidenceSha256,
      expected.snapshotIdentifierSha256,
      source.rowChecksumSha256,
    ].every((hash) => SHA.test(hash)) ||
    ![source.id, source.hotelId, source.externalPropertyId].every((id) => UUID.test(id)) ||
    !Number.isSafeInteger(source.rowOrdinal) ||
    source.rowOrdinal < 1
  )
    throw new Error("Invalid historical connection source request");
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = [
      "platform.source_extraction_runs",
      "platform.source_extraction_sources",
      "platform.source_extraction_tables",
      ...["auth", "booking", "marketplace", "pms"].map(
        (db) => `migration_source_${db}.snapshot_rows`,
      ),
    ];
    await client.query(`LOCK TABLE ${tables.join(", ")} IN ACCESS SHARE MODE`);
    const access = await client.query<{ complete: boolean }>(
      `SELECT count(*) = 7 AND bool_and(NOT relrowsecurity AND has_table_privilege(oid, 'SELECT')) AS complete
       FROM pg_class WHERE oid = ANY($1::regclass[])`,
      [tables],
    );
    if (access.rows.length !== 1 || access.rows[0]?.complete !== true)
      throw new Error("Historical connection source visibility incomplete");
    const ledger = await readSourceLedger(client, expected.sourceRunId);
    // The signed hash uses code-unit order, not the database's locale collation.
    const key = (row: (typeof ledger.tables)[number]) =>
      `${row.source_database}\0${row.source_schema}\0${row.source_table}`;
    ledger.tables.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const pmsSources = ledger.sources.filter((row) => row.source_database === "pms");
    if (
      ledger.run.run_id !== expected.sourceRunId ||
      ledger.run.environment !== expected.sourceEnvironment ||
      ledger.run.source_schema_revision !== expected.sourceSchemaRevision ||
      hashSourceLedger(ledger) !== expected.sourceEvidenceSha256 ||
      pmsSources.length !== 1 ||
      pmsSources[0]?.snapshot_identifier_sha256 !== expected.snapshotIdentifierSha256
    )
      throw new Error("Historical connection source ledger mismatch");
    // Use the real default inventory/identity validator; no injected bypass.
    await readProductionPmsSnapshot(client, expected.sourceRunId);
    const result = await client.query<LegacyHistoricalBindingObserved["sourceConnections"][number]>(
      `SELECT row_data->>'id' AS id, row_data->>'hotel_id' AS "hotelId",
         row_data->>'channex_property_id' AS "externalPropertyId", row_ordinal::int AS "rowOrdinal",
         row_checksum_sha256 AS "rowChecksumSha256", row_data->'is_active' AS active
       FROM migration_source_pms.snapshot_rows
       WHERE run_id = $1 AND source_schema = 'public' AND source_table = 'channex_connections'
         AND (row_data->>'hotel_id' = $2 OR row_data->>'channex_property_id' = $3)
       ORDER BY row_ordinal`,
      [expected.sourceRunId, source.hotelId, source.externalPropertyId],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      row.id !== source.id ||
      row.hotelId !== source.hotelId ||
      row.externalPropertyId !== source.externalPropertyId ||
      row.rowOrdinal !== source.rowOrdinal ||
      row.rowChecksumSha256 !== source.rowChecksumSha256 ||
      typeof row.active !== "boolean"
    )
      throw new Error("Historical connection source rows mismatch");
    return Object.freeze({
      sourceRunId: expected.sourceRunId,
      sourceConnections: Object.freeze([Object.freeze(row)]),
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
