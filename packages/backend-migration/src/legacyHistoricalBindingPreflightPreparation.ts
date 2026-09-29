import type pg from "pg";

import { readSourceLedger } from "./channexAdoptionEvidence.js";
import { canonicalizeJson, hashSourceLedger } from "./channexAdoptionManifestCrypto.js";
import { readLegacyHistoricalBindingTargetSnapshot } from "./legacyHistoricalBindingTargetReader.js";
import {
  APPROVED_PAIRS,
  APPROVED_SOURCE_RUN_ID,
} from "./legacyHistoricalBindingPreflightRunner.js";
import { readProductionPmsSnapshot } from "./productionPmsSnapshotReader.js";

type SourceRow = {
  id: string;
  hotelId: string;
  externalPropertyId: string;
  rowOrdinal: number;
  rowChecksumSha256: string;
  active: boolean;
};

export async function prepareLegacyHistoricalBindingPreflightInput(
  pools: { source: Pick<pg.Pool, "connect">; target: Pick<pg.Pool, "connect"> },
  signingKeyId: string,
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(signingKeyId))
    throw new Error("Invalid preflight signing key id");

  const client = await pools.source.connect();
  let discard = false;
  let primaryError: unknown;
  try {
    await client.query("ROLLBACK");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query(
      "SET LOCAL search_path=pg_catalog; SET LOCAL row_security=off; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'",
    );
    const tables = [
      "platform.source_extraction_runs",
      "platform.source_extraction_sources",
      "platform.source_extraction_tables",
      ...["auth", "booking", "marketplace", "pms"].map(
        (database) => `migration_source_${database}.snapshot_rows`,
      ),
    ];
    await client.query(`LOCK TABLE ${tables.join(", ")} IN ACCESS SHARE MODE`);
    const access = await client.query<{ complete: boolean }>(
      `SELECT count(*) = 7 AND bool_and(relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
        AND has_table_privilege(oid, 'SELECT')) AS complete
       FROM pg_catalog.pg_class c WHERE oid = ANY($1::regclass[])`,
      [tables],
    );
    if (access.rows.length !== 1 || access.rows[0]?.complete !== true)
      throw new Error("Historical connection preparation visibility incomplete");

    const ledger = await readSourceLedger(client, APPROVED_SOURCE_RUN_ID);
    await readProductionPmsSnapshot(client, APPROVED_SOURCE_RUN_ID);
    if (ledger.run.environment !== "production")
      throw new Error("Historical connection preparation source is not production");
    const pmsSources = ledger.sources.filter((source) => source.source_database === "pms");
    if (pmsSources.length !== 1)
      throw new Error("Historical connection preparation PMS source mismatch");
    const tableKey = (row: (typeof ledger.tables)[number]) =>
      `${row.source_database}\0${row.source_schema}\0${row.source_table}`;
    ledger.tables.sort((a, b) =>
      tableKey(a) < tableKey(b) ? -1 : tableKey(a) > tableKey(b) ? 1 : 0,
    );
    const sourceEvidenceSha256 = hashSourceLedger(ledger);

    const requests = [];
    for (const [propertyId, externalPropertyId] of APPROVED_PAIRS) {
      const sourceResult = await client.query<SourceRow>(
        `SELECT row_data->>'id' AS id, row_data->>'hotel_id' AS "hotelId",
           row_data->>'channex_property_id' AS "externalPropertyId",
           row_ordinal::int AS "rowOrdinal", row_checksum_sha256 AS "rowChecksumSha256",
           row_data->'is_active' AS active
         FROM migration_source_pms.snapshot_rows
         WHERE run_id = $1 AND source_schema = 'public' AND source_table = 'channex_connections'
           AND (row_data->>'hotel_id' = $2 OR row_data->>'channex_property_id' = $3)
         ORDER BY row_ordinal`,
        [APPROVED_SOURCE_RUN_ID, propertyId, externalPropertyId],
      );
      const source = sourceResult.rows[0];
      if (
        sourceResult.rows.length !== 1 ||
        !source ||
        source.hotelId !== propertyId ||
        source.externalPropertyId !== externalPropertyId ||
        typeof source.active !== "boolean"
      )
        throw new Error("Historical connection preparation source pair mismatch");

      const target = await readLegacyHistoricalBindingTargetSnapshot(pools.target, {
        propertyId,
        externalPropertyId,
      });
      if (target.claims.length !== 1 || target.connections.length === 0)
        throw new Error("Historical connection preparation target pair mismatch");
      const expectedSource = {
        id: source.id,
        hotelId: source.hotelId,
        externalPropertyId: source.externalPropertyId,
        rowOrdinal: source.rowOrdinal,
        rowChecksumSha256: source.rowChecksumSha256,
      };
      requests.push({
        sourceRequest: {
          sourceRunId: APPROVED_SOURCE_RUN_ID,
          sourceEnvironment: "production" as const,
          sourceSchemaRevision: ledger.run.source_schema_revision,
          sourceEvidenceSha256,
          snapshotIdentifierSha256: pmsSources[0]!.snapshot_identifier_sha256,
          source: expectedSource,
        },
        bindingExpected: {
          sourceRunId: APPROVED_SOURCE_RUN_ID,
          source: expectedSource,
          propertyId,
          claim: {
            id: target.claims[0]!.id,
            rowStateSha256: target.claims[0]!.rowStateSha256,
          },
          connections: target.connections.map(({ id, rowStateSha256 }) => ({
            id,
            rowStateSha256,
          })),
        },
        property: { id: target.property.id, rowStateSha256: target.property.rowStateSha256 },
      });
    }
    return canonicalizeJson({
      version: "vay2017-historical-binding-preflight.v1",
      environment: "production",
      signingKeyId,
      requests,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      discard = true;
      if (primaryError === undefined) throw error;
    } finally {
      client.release(discard);
    }
  }
}
