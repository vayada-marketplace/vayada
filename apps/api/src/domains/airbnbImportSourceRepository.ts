import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { parsePreparedHotelImport, type PreparedHotelImport } from "@vayada/domain-hotels";

type Scope = { actorUserId: string; organizationId: string; propertyId: string };
type Binding = {
  environment: "staging" | "production";
  groupId: string;
  externalPropertyId: string;
};
const predicate = `organization_id=$2::uuid AND actor_user_id=$3::uuid AND property_id=$4::uuid`;
const parameters = (key: string, scope: Scope) => [
  key,
  scope.organizationId,
  scope.actorUserId,
  scope.propertyId,
];
const digest = (state: string) => createHash("sha256").update(state).digest("hex");
const validState = (state: string) => /^[A-Za-z0-9_-]{43}$/.test(state);

/** Internal only: route policy must reauthorize membership and property access on every call. */
export function createPgAirbnbImportSourceRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return {
    async begin(scope: Scope, binding: Binding): Promise<{ sourceId: string; state: string }> {
      const sourceId = randomUUID();
      const state = randomBytes(32).toString("base64url");
      await pool.query(
        `INSERT INTO hotel_catalog.airbnb_import_sources
        (id,state_hash,organization_id,actor_user_id,property_id,environment,external_group_id,external_property_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          sourceId,
          digest(state),
          scope.organizationId,
          scope.actorUserId,
          scope.propertyId,
          binding.environment,
          binding.groupId,
          binding.externalPropertyId,
        ],
      );
      return { sourceId, state };
    },
    async pending(scope: Scope, state: string): Promise<(Binding & { sourceId: string }) | null> {
      if (!validState(state)) return null;
      const result = await pool.query(
        `SELECT id,environment,external_group_id,external_property_id FROM hotel_catalog.airbnb_import_sources
        WHERE state_hash=$1 AND ${predicate} AND completed_at IS NULL AND expires_at > now()`,
        parameters(digest(state), scope),
      );
      const row = result.rows[0];
      return row
        ? {
            sourceId: row.id,
            environment: row.environment,
            groupId: row.external_group_id,
            externalPropertyId: row.external_property_id,
          }
        : null;
    },
    // Call only after provider verification using pending()'s stored binding.
    async complete(
      scope: Scope,
      state: string,
      channelId: string,
      value: PreparedHotelImport,
    ): Promise<string | null> {
      if (!validState(state)) return null;
      const data = parsePreparedHotelImport(value);
      if (!data) throw new Error("invalid_airbnb_import_snapshot");
      try {
        const result = await pool.query(
          `UPDATE hotel_catalog.airbnb_import_sources SET channel_id=$5::uuid,prepared_data=$6::jsonb,completed_at=now()
          WHERE state_hash=$1 AND ${predicate} AND completed_at IS NULL AND expires_at > now() RETURNING id`,
          [...parameters(digest(state), scope), channelId, JSON.stringify(data)],
        );
        return result.rows[0]?.id ?? null;
      } catch (error) {
        if (error instanceof pg.DatabaseError && error.code === "23505")
          throw new Error("airbnb_source_already_bound");
        throw error;
      }
    },
    async find(
      scope: Scope,
      sourceId: string,
    ): Promise<
      (Binding & { sourceId: string; channelId: string; data: PreparedHotelImport }) | null
    > {
      const result = await pool.query(
        `SELECT id,channel_id,prepared_data,environment,external_group_id,external_property_id FROM hotel_catalog.airbnb_import_sources
        WHERE id=$1::uuid AND ${predicate} AND completed_at IS NOT NULL`,
        parameters(sourceId, scope),
      );
      const row = result.rows[0];
      const data = parsePreparedHotelImport(row?.prepared_data);
      return row && data
        ? {
            sourceId: row.id,
            channelId: row.channel_id,
            data,
            environment: row.environment,
            groupId: row.external_group_id,
            externalPropertyId: row.external_property_id,
          }
        : null;
    },
    async close() {
      await pool.end();
    },
  };
}
