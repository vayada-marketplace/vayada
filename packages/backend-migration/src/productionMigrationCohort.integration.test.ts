import { createHash } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeProductionIdentityCore } from "./productionIdentityCoreWriter.js";
import { writeProductionIdentityPrivacyAudit } from "./productionIdentityPrivacyAuditWriter.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { buildProductionIdentityPlan } from "./productionIdentityPlan.js";
import { readProductionIdentityTargetState } from "./productionIdentityTargetReader.js";
import {
  readProductionIdentitySnapshot,
  VAY_1350_ACTIVE_SOURCE_TABLES,
} from "./productionIdentitySnapshotReader.js";
import {
  parseProductionMigrationCohort,
  writeProductionMigrationCohort,
} from "./productionMigrationCohort.js";
import { bindProductionMigrationCohort } from "./productionMigrationCohortBinding.js";
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
const OWNER = "eeeeeeee-0000-4000-8000-000000000005";
// The owner holds the Booking hotel and the profile; the PMS hotel's owner has no Booking hotel.
const ROWS: Record<string, object> = {
  "auth.users": { id: OWNER, type: "hotel", status: "verified" },
  "booking.booking_hotels": { user_id: OWNER, slug: "alpha", platform_status: "live" },
  "pms.hotels": { user_id: "ffffffff-0000-4000-8000-000000000006", slug: "beta" },
  "marketplace.hotel_profiles": { user_id: OWNER, status: "verified" },
};
const cohort = (bookingHotelIds: string[], pmsHotelIds: string[] = [HOTELS.pms[1]]) =>
  parseProductionMigrationCohort({
    sourceRunId: RUN,
    bookingHotelIds,
    pmsHotelIds,
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

  it("refuses to bind a cohort whose hotel the catalog cannot resolve", async () => {
    const stored = async () =>
      (await client.query("SELECT cohort_sha256 FROM platform.production_migration_cohorts")).rows;
    await expect(
      bindProductionMigrationCohort(client, cohort([HOTELS.booking[1]])),
    ).rejects.toMatchObject({ code: "COHORT_HOTEL_UNRESOLVED" });
    expect(await stored()).toEqual([]);
    await client.query("SAVEPOINT bind");
    const corrected = cohort([HOTELS.booking[1]], []);
    await bindProductionMigrationCohort(client, corrected);
    expect(await stored()).toEqual([{ cohort_sha256: corrected.cohortSha256 }]);
    await client.query("ROLLBACK TO SAVEPOINT bind");
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

  it("writes non-cohort owners to archived quarantine and verifies on replan", async () => {
    await client.query("SAVEPOINT identity");
    const [mixed, outside, kept, dropped, alone] = ["1", "2", "a", "b", "c"].map(
      (c) => `${c.repeat(8)}-1362-4000-8000-000000000000`,
    );
    const at = { created_at: TIME, updated_at: TIME };
    const row = (sourceDatabase: "auth" | "booking", sourceTable: string, data: object) =>
      ({
        sourceDatabase,
        sourceTable,
        rowOrdinal: 1,
        data: { ...data, ...at },
      }) as IdentitySourceRow;
    const rows = [
      ...[mixed!, outside!].map((id) =>
        row("auth", "users", {
          id,
          email: `${id}@example.invalid`,
          name: "Owner",
          type: "hotel",
          status: "verified",
          email_verified: true,
          is_superadmin: false,
        }),
      ),
      ...[kept, dropped, alone].map((id) =>
        row("booking", "booking_hotels", {
          id,
          user_id: id === alone ? outside : mixed,
          name: `Hotel ${id}`,
          platform_status: "live",
        }),
      ),
    ];
    const scope = { bookingHotelIds: [kept!], pmsHotelIds: [], marketplaceHotelIds: [] };
    const plan = buildProductionIdentityPlan(rows, undefined, TIME, scope);
    expect(plan.blockers).toEqual([]);
    await writeProductionIdentityCore(client, plan);
    await writeProductionIdentityPrivacyAudit(client, plan);
    const target = await readProductionIdentityTargetState(client, rows);
    const replanned = buildProductionIdentityPlan(rows, target, TIME, scope);
    expect(replanned.blockers).toEqual([]);
    expect(replanned.counts.pendingTargetWrites).toBe(0);
    expect(replanned.checksum).toBe(plan.checksum);

    const access = await client.query(
      `SELECT concat_ws(' ', link.resource_id, link.status, organization.status, entitlement.status,
                (SELECT string_agg(member.status || ':' || member.property_access_mode, ',')
                   FROM identity.organization_memberships member
                  WHERE member.organization_id = link.organization_id)) AS state
         FROM identity.organization_resource_links link
         JOIN identity.organizations organization ON organization.id = link.organization_id
         JOIN identity.product_entitlements entitlement
           ON entitlement.organization_id = link.organization_id
          AND entitlement.resource_id = link.resource_id
        WHERE link.resource_id = ANY($1::text[]) ORDER BY link.resource_id`,
      [[kept, dropped, alone]],
    );
    // resource, link, organization, entitlement, memberships of the owning organization
    expect(access.rows.map((row) => row.state)).toEqual([
      `${kept} active active active active:all`,
      `${dropped} archived archived expired`,
      `${alone} archived archived expired`,
    ]);
    const users = await client.query(
      "SELECT status FROM identity.users WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[mixed, outside]],
    );
    expect(users.rows).toEqual([{ status: "active" }, { status: "suspended" }]);
    await client.query("ROLLBACK TO SAVEPOINT identity");
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
    const tables = [];
    for (const qualified of qualifiedTables) {
      const [schema, table] = qualified.split(".") as [string, string];
      const extra = ROWS[`${database}.${table}`];
      const id = hotel?.[0] === table ? hotel[1] : database === "auth" && extra ? OWNER : null;
      // PostgreSQL's jsonb text form, which the reader re-hashes.
      const data = { id, name: `Hotel ${table}`, created_at: TIME, ...extra };
      const rowData: string | null = id
        ? (await client.query("SELECT $1::jsonb::text AS t", [JSON.stringify(data)])).rows[0].t
        : null;
      const checksum = rowData ? sha(`${sha(rowData)}\n`) : sha("");
      total += rowData ? 1 : 0;
      aggregate.update(`${qualified}|${rowData ? 1 : 0}|${checksum}\n`);
      tables.push({ schema, table, rowData, checksum });
    }
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
