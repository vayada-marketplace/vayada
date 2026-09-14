import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import { readSourceLedger } from "./channexAdoptionEvidence.js";
import { hashSourceLedger, hashSnapshotIdentifier } from "./channexAdoptionManifestCrypto.js";

export type OwnerSourceRequest = {
  sourceRunId: string;
  sourceEnvironment: string;
  sourceSchemaRevision: string;
  ledgerSha256: string;
  owners: {
    ownerId: string;
    hotelId: string;
    userOrdinal: number;
    hotelOrdinal: number;
    userSha256: string;
    hotelSha256: string;
  }[];
};
type ProjectedRow = {
  database: "auth" | "pms";
  id: string;
  email: string | null;
  status: string | null;
  type: string | null;
  ownerId: string | null;
  ordinal: string;
  sha: string;
  valid: boolean;
  snapshot: string;
};

/**
 * Historical snapshot association only, never current ownership or access.
 * Caller independently verifies environment, full visibility and an approved
 * request binding exact row hashes/ordinals + ledger hash to the eight pairs.
 * Output email is sensitive: consume in memory, never log/serialize to reports.
 */
export async function readLegacyOwnerBootstrapSources(
  client: AdoptionQueryClient,
  request: OwnerSourceRequest,
) {
  const expected = structuredClone(request);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const sha = /^[0-9a-f]{64}$/;
  const protectedIds = [
    "17621565-40b5-4ebc-8727-3a301ac947a2",
    "65f6b2fc-c783-4963-9d6b-a85f82319769",
  ];
  if (
    !/^vay1351-[0-9a-f]{24}$/.test(expected.sourceRunId) ||
    !sha.test(expected.ledgerSha256) ||
    !expected.sourceEnvironment?.trim() ||
    !expected.sourceSchemaRevision?.trim() ||
    !Array.isArray(expected.owners) ||
    expected.owners.length !== 8 ||
    new Set(expected.owners.map((o) => o.ownerId)).size !== 8 ||
    new Set(expected.owners.map((o) => o.hotelId)).size !== 8 ||
    expected.owners.some(
      (o) =>
        !uuid.test(o.ownerId) ||
        !uuid.test(o.hotelId) ||
        protectedIds.includes(o.hotelId) ||
        !sha.test(o.userSha256) ||
        !sha.test(o.hotelSha256) ||
        !Number.isSafeInteger(o.userOrdinal) ||
        o.userOrdinal < 1 ||
        !Number.isSafeInteger(o.hotelOrdinal) ||
        o.hotelOrdinal < 1,
    )
  )
    throw Error("INVALID_OWNER_SOURCE_SCOPE");
  try {
    const settings = (
      await client.query(`SELECT current_setting('transaction_read_only') AS readonly,
      current_setting('transaction_isolation') AS isolation`)
    ).rows[0];
    if (
      settings?.readonly !== "on" ||
      !["repeatable read", "serializable"].includes(settings.isolation)
    )
      throw Error();
    const ledger = await readSourceLedger(client, expected.sourceRunId);
    if (
      ledger.run.environment !== expected.sourceEnvironment ||
      ledger.run.source_schema_revision !== expected.sourceSchemaRevision ||
      hashSourceLedger(ledger) !== expected.ledgerSha256
    )
      throw Error();
    for (const database of ["auth", "pms"]) {
      const sources = ledger.sources.filter((source) => source.source_database === database);
      if (sources.length !== 1 || sources[0]!.status !== "completed") throw Error();
    }
    const { rows } = await client.query<ProjectedRow>(
      `SELECT * FROM (
      SELECT 'auth' AS database,row_data->>'id' AS id,row_data->>'email' AS email,
        row_data->>'status' AS status,row_data->>'type' AS type,NULL::text AS "ownerId",
        row_ordinal::text AS ordinal,row_checksum_sha256 AS sha,
        row_checksum_sha256=encode(sha256(convert_to(row_data::text,'UTF8')),'hex') AS valid,
        snapshot_identifier AS snapshot FROM migration_source_auth.snapshot_rows
      WHERE run_id=$1 AND source_schema='public' AND source_table='users' AND row_data->>'id'=ANY($2::text[])
      UNION ALL
      SELECT 'pms',row_data->>'id',NULL,NULL,NULL,row_data->>'user_id',row_ordinal::text,
        row_checksum_sha256,row_checksum_sha256=encode(sha256(convert_to(row_data::text,'UTF8')),'hex'),snapshot_identifier
      FROM migration_source_pms.snapshot_rows
      WHERE run_id=$1 AND source_schema='public' AND source_table='hotels' AND row_data->>'id'=ANY($3::text[])
      ) scoped ORDER BY database,id,ordinal LIMIT 17`,
      [
        expected.sourceRunId,
        expected.owners.map((o) => o.ownerId),
        expected.owners.map((o) => o.hotelId),
      ],
    );
    if (rows.length !== 16) throw Error();
    return expected.owners.map((owner) => {
      const users = rows.filter((row) => row.database === "auth" && row.id === owner.ownerId);
      const hotels = rows.filter((row) => row.database === "pms" && row.id === owner.hotelId);
      if (users.length !== 1 || hotels.length !== 1) throw Error();
      for (const [row, checksum, ordinal] of [
        [users[0]!, owner.userSha256, owner.userOrdinal],
        [hotels[0]!, owner.hotelSha256, owner.hotelOrdinal],
      ] as const) {
        const source = ledger.sources.find((source) => source.source_database === row.database)!;
        if (
          row.valid !== true ||
          row.sha !== checksum ||
          row.ordinal !== String(ordinal) ||
          hashSnapshotIdentifier(row.snapshot) !== source.snapshot_identifier_sha256
        )
          throw Error();
      }
      const user = users[0]!,
        hotel = hotels[0]!;
      if (typeof user.email !== "string" || !user.email.trim()) throw Error();
      return {
        ownerId: owner.ownerId,
        email: user.email,
        sourceStatus: user.status ?? "unknown",
        sourceOwnership:
          hotel.ownerId === owner.ownerId && user.type === "hotel"
            ? ("matched" as const)
            : ("conflict" as const),
      };
    });
  } catch {
    throw Error("OWNER_SOURCE_READ_FAILED");
  }
}
