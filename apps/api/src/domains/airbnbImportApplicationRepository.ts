import pg from "pg";
import { parsePreparedHotelImport, type ImportItemResult } from "@vayada/domain-hotels";
import type { PreparedImportSource } from "./preparedHotelImportRepository.js";

type Scope = { organizationId: string; actorUserId: string; propertyId: string; sourceId: string };
const parameters = (scope: Scope) => [
  scope.sourceId,
  scope.organizationId,
  scope.actorUserId,
  scope.propertyId,
];
const sourceSql = `SELECT source.id::text AS "sourceId", source.property_id::text AS "propertyId",
  source.prepared_data AS data, application.results
  FROM hotel_catalog.airbnb_import_sources source
  LEFT JOIN hotel_catalog.airbnb_import_applications application ON application.source_id=source.id
  WHERE source.id=$1::uuid AND source.organization_id=$2::uuid
    AND source.actor_user_id=$3::uuid AND source.property_id=$4::uuid
    AND source.completed_at IS NOT NULL`;

function sourceFromRow(row?: Record<string, unknown>): PreparedImportSource | null {
  const data = parsePreparedHotelImport(row?.data);
  return row && data
    ? {
        sourceId: String(row.sourceId),
        propertyId: String(row.propertyId),
        data,
        results: (row.results ?? {}) as Record<string, ImportItemResult>,
      }
    : null;
}

/** Internal port: the consumer must reauthorize access/binding and use replay-safe room commands. */
export function createPgAirbnbImportApplicationRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return {
    async find(scope: Scope): Promise<PreparedImportSource | null> {
      const result = await pool.query(sourceSql, parameters(scope));
      return sourceFromRow(result.rows[0]);
    },
    async apply(
      scope: Scope,
      execute: (source: PreparedImportSource) => Promise<ImportItemResult[]>,
    ): Promise<ImportItemResult[]> {
      const client = await pool.connect();
      let failed = false;
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1::uuid::text, 0))", [
          scope.sourceId,
        ]);
        const result = await client.query(sourceSql, parameters(scope));
        const source = sourceFromRow(result.rows[0]);
        if (!source) throw new Error("import_not_available");
        const items = await execute(source);
        const successes = Object.fromEntries(
          items.filter((item) => item.status === "applied").map((item) => [item.itemId, item]),
        );
        await client.query(
          `INSERT INTO hotel_catalog.airbnb_import_applications (source_id,results)
          VALUES ($1::uuid,$2::jsonb) ON CONFLICT (source_id) DO UPDATE
          SET results=EXCLUDED.results || hotel_catalog.airbnb_import_applications.results, updated_at=now()`,
          [scope.sourceId, JSON.stringify(successes)],
        );
        return items.map((item) => source.results[item.itemId] ?? item);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1::uuid::text, 0))", [
            scope.sourceId,
          ]);
          client.release();
        } catch (error) {
          client.release(true);
          if (!failed) throw error;
        }
      }
    },
    async close() {
      await pool.end();
    },
  };
}
