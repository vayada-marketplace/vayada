import { createHash } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readProductionIdentitySnapshot,
  VAY_1350_ACTIVE_SOURCE_TABLES,
} from "./productionIdentitySnapshotReader.js";
import {
  parseProductionMigrationCohort,
  writeProductionMigrationCohort,
} from "./productionMigrationCohort.js";
import { VAY_1350_INVENTORY_REVISION } from "./sourceExtraction.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const RUN = `vay1351-${"c0".repeat(12)}`;
const TIME = "2026-10-01T00:00:00.000Z";
const HOTELS = {
  booking: ["booking_hotels", "aaaaaaaa-0000-4000-8000-000000000001"],
  pms: ["hotels", "bbbbbbbb-0000-4000-8000-000000000002"],
  marketplace: ["hotel_profiles", "cccccccc-0000-4000-8000-000000000003"],
} as const;
const cohort = (bookingHotelIds: string[]) =>
  parseProductionMigrationCohort({
    sourceRunId: RUN,
    bookingHotelIds,
    pmsHotelIds: [HOTELS.pms[1]],
    marketplaceHotelIds: [HOTELS.marketplace[1]],
    approvalProofSha256: "a".repeat(64),
  });

describe.skipIf(!URL)("production migration cohort (PostgreSQL)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    client = new pg.Client({ connectionString: URL });
    await client.connect();
    await client.query("BEGIN");
    await seedSource(client);
  });
  afterAll(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  const rejects = async (sql: string, values: unknown[], code: string) => {
    await client.query("SAVEPOINT attempt");
    await expect(client.query(sql, values)).rejects.toMatchObject({ code });
    await client.query("ROLLBACK TO SAVEPOINT attempt");
  };

  it("loads no cohort for an unscoped run", async () => {
    expect((await readProductionIdentitySnapshot(client, RUN)).cohort).toBeNull();
  });

  it("rejects a cohort hotel that is absent from the attested source", async () => {
    await client.query("SAVEPOINT absent");
    await writeProductionMigrationCohort(client, cohort(["dddddddd-0000-4000-8000-000000000004"]));
    await expect(readProductionIdentitySnapshot(client, RUN)).rejects.toMatchObject({
      code: "COHORT_HOTEL_NOT_IN_SOURCE",
    });
    await client.query("ROLLBACK TO SAVEPOINT absent");
  });

  it("enforces canonical, non-empty ID sets in the table", async () => {
    const insert = `INSERT INTO platform.production_migration_cohorts
      (source_run_id, cohort_sha256, booking_hotel_ids, pms_hotel_ids, marketplace_hotel_ids,
       approval_proof_sha256) VALUES ($1, $2, $3::uuid[], $4::uuid[], '{}', $2)`;
    const [low, high] = [HOTELS.booking[1], HOTELS.pms[1]];
    await rejects(insert, [RUN, "a".repeat(64), [], []], "23514");
    await rejects(insert, [RUN, "a".repeat(64), [high, low], []], "23514");
    await rejects(insert, [RUN, "a".repeat(64), [low], [low, low]], "23514");
    await rejects(insert, ["vay1351-latest", "a".repeat(64), [low], []], "23514");
    await rejects(insert, [RUN, "not-a-sha", [low], []], "23514");
  });

  it("writes once, is immutable and exposes the cohort on the snapshot", async () => {
    const approved = cohort([HOTELS.booking[1]]);
    await writeProductionMigrationCohort(client, approved);
    await writeProductionMigrationCohort(client, approved);
    await expect(
      writeProductionMigrationCohort(client, { ...approved, cohortSha256: "f".repeat(64) }),
    ).rejects.toMatchObject({ code: "COHORT_CONFLICT" });
    await rejects(
      "UPDATE platform.production_migration_cohorts SET pms_hotel_ids = '{}'",
      [],
      "55000",
    );
    await rejects("DELETE FROM platform.production_migration_cohorts", [], "55000");
    expect((await readProductionIdentitySnapshot(client, RUN)).cohort).toEqual(approved);
  });
});

async function seedSource(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO platform.source_extraction_runs
       (run_id, environment, source_schema_revision, status, started_at, finished_at, duration_ms)
     VALUES ($1, 'staging', $2, 'completed', $3, $3, 0)`,
    [RUN, VAY_1350_INVENTORY_REVISION, TIME],
  );
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  for (const [database, qualifiedTables] of Object.entries(VAY_1350_ACTIVE_SOURCE_TABLES)) {
    const hotel = HOTELS[database as keyof typeof HOTELS];
    const aggregate = createHash("sha256");
    let total = 0;
    const tables = qualifiedTables.map((qualified) => {
      const [schema, table] = qualified.split(".") as [string, string];
      // PostgreSQL's jsonb text form, which the reader re-hashes.
      const rowData = hotel?.[0] === table ? `{"id": "${hotel[1]}"}` : null;
      const checksum = rowData ? sha(`${sha(rowData)}\n`) : sha("");
      total += rowData ? 1 : 0;
      aggregate.update(`${qualified}|${rowData ? 1 : 0}|${checksum}\n`);
      return { schema, table, rowData, checksum };
    });
    await client.query(
      `INSERT INTO platform.source_extraction_sources
         (run_id, source_database, snapshot_identifier, expected_database_name,
          expected_schema_fingerprint, actual_schema_fingerprint, status, row_count,
          checksum_sha256, source_snapshot_at, started_at, finished_at, duration_ms)
       VALUES ($1, $2, 'snapshot-' || $2, $2, $3, $3, 'completed', $4, $5, $6, $6, $6, 0)`,
      [RUN, database, "f".repeat(32), total, aggregate.digest("hex"), TIME],
    );
    for (const { schema, table, rowData, checksum } of tables) {
      await client.query(
        `INSERT INTO platform.source_extraction_tables
           (run_id, source_database, source_schema, source_table, status, row_count,
            checksum_sha256, started_at, finished_at, duration_ms)
         VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, $7, 0)`,
        [RUN, database, schema, table, rowData ? 1 : 0, checksum, TIME],
      );
      if (rowData)
        await client.query(
          `INSERT INTO migration_source_${database}.snapshot_rows
             (run_id, snapshot_identifier, source_schema, source_table, row_ordinal,
              row_checksum_sha256, row_data)
           VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb)`,
          [RUN, `snapshot-${database}`, schema, table, sha(rowData), rowData],
        );
    }
  }
}
