import pg from "pg";
import {
  parsePreparedHotelImport,
  type PreparedHotelImport,
  type ImportItemResult,
} from "@vayada/domain-hotels";

export type ImportScope = { organizationId: string; actorUserId: string };
export type PreparedImportSource = {
  sourceId: string;
  data: PreparedHotelImport;
  propertyId: string | null;
  results: Record<string, ImportItemResult>;
};
export type PreparedImportRepository = {
  find(scope: ImportScope): Promise<PreparedImportSource | null>;
  apply(
    scope: ImportScope & { sourceId: string; propertyId: string },
    execute: (source: PreparedImportSource) => Promise<ImportItemResult[]>,
  ): Promise<ImportItemResult[]>;
  close(): Promise<void>;
};

export function createPgPreparedImportRepository(
  connectionString: string,
): PreparedImportRepository {
  const pool = new pg.Pool({ connectionString });
  return {
    async find(scope) {
      const result = await pool.query(SOURCE_SQL, [scope.organizationId, scope.actorUserId]);
      return sourceFromRow(result.rows[0]);
    },
    async apply(scope, execute) {
      const client = await pool.connect();
      try {
        // Serialize both the first binding and retries for this source.
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [scope.sourceId]);
        const result = await client.query(SOURCE_SQL, [scope.organizationId, scope.actorUserId]);
        const source = sourceFromRow(result.rows[0]);
        if (!source || source.sourceId !== scope.sourceId) throw new Error("import_not_available");
        if (source.propertyId && source.propertyId !== scope.propertyId)
          throw new Error("import_property_conflict");
        await client.query(
          `INSERT INTO hotel_catalog.prepared_import_applications
          (invite_id, organization_id, property_id) VALUES ($1::uuid, $2::uuid, $3::uuid)
          ON CONFLICT (invite_id) DO NOTHING`,
          [scope.sourceId, scope.organizationId, scope.propertyId],
        );
        const items = await execute(source);
        const successes = Object.fromEntries(
          items.filter((item) => item.status === "applied").map((item) => [item.itemId, item]),
        );
        await client.query(
          `UPDATE hotel_catalog.prepared_import_applications
          SET results = results || $2::jsonb, updated_at = now() WHERE invite_id = $1::uuid`,
          [scope.sourceId, JSON.stringify(successes)],
        );
        return items;
      } finally {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
            scope.sourceId,
          ]);
        } catch (error) {
          client.release(true);
          throw error;
        }
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

function sourceFromRow(row: Record<string, unknown> | undefined): PreparedImportSource | null {
  if (!row) return null;
  const data = parsePreparedHotelImport(row.data);
  if (!data) return null;
  return {
    sourceId: String(row.sourceId),
    data,
    propertyId: row.propertyId ? String(row.propertyId) : null,
    results: (row.results ?? {}) as Record<string, ImportItemResult>,
  };
}

const SOURCE_SQL = `SELECT invite.id::text AS "sourceId", invite.payload->'preparedData' AS data,
  application.property_id::text AS "propertyId", application.results
  FROM marketplace.invite_codes invite
  JOIN identity.organizations organization ON organization.id = $1::uuid
    AND organization.kind = 'hotel_group' AND organization.status = 'active'
    AND organization.workos_external_id = 'vayada-signup:marketplace-web:hotel:invite:' || invite.id::text
  LEFT JOIN hotel_catalog.prepared_import_applications application ON application.invite_id = invite.id
  WHERE invite.invite_type = 'hotel' AND invite.status = 'redeemed'
    AND invite.payload->>'contractVersion' = 'hotel-account-invite.v1'
    AND invite.redeemed_by_user_id = $2::uuid
    AND invite.payload->'redemption'->>'organizationId' = $1::text
  LIMIT 1`;
