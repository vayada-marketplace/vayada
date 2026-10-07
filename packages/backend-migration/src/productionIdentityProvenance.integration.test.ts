import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";
import {
  runProductionIdentityTransaction,
  type ProductionIdentityMigrationServices,
} from "./productionIdentityMigration.js";
import { buildProductionIdentityPlan } from "./productionIdentityPlan.js";
import { readProductionIdentityTargetState } from "./productionIdentityTargetReader.js";
import { writeProductionIdentityCore } from "./productionIdentityCoreWriter.js";
import { writeProductionIdentityPrivacyAudit } from "./productionIdentityPrivacyAuditWriter.js";
import {
  readProductionIdentityProvenance,
  writeProductionIdentityProvenance,
} from "./productionIdentityProvenance.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const url = process.env["VAY2017_PROVENANCE_TEST_DATABASE_URL"];
const RUN = "vay1351-0123456789abcdef01234567";
const USER = "11111111-1111-7111-8111-111111111111";
const HOTEL = "22222222-2222-4222-8222-222222222222";
const TIME = "2026-01-01T00:00:00.000Z";
const rows: IdentitySourceRow[] = [
  {
    sourceDatabase: "auth",
    sourceTable: "users",
    rowOrdinal: 1,
    data: {
      id: USER,
      email: "provenance@example.invalid",
      name: "Fixture Owner",
      type: "hotel",
      status: "pending",
      email_verified: false,
      is_superadmin: false,
      created_at: TIME,
      updated_at: TIME,
    },
  },
  {
    sourceDatabase: "pms",
    sourceTable: "hotels",
    rowOrdinal: 1,
    data: {
      id: HOTEL,
      user_id: USER,
      name: "Fixture Hotel",
      created_at: TIME,
      updated_at: TIME,
    },
  },
];
const services: ProductionIdentityMigrationServices = {
  // Synthetic source only. Production still verifies the immutable extraction before planning.
  readSnapshot: async () => ({ rows, sourceHorizonAt: TIME }),
  readTarget: readProductionIdentityTargetState,
  buildPlan: buildProductionIdentityPlan,
  writeCore: writeProductionIdentityCore,
  writePrivacyAudit: writeProductionIdentityPrivacyAudit,
  readProvenance: readProductionIdentityProvenance,
  writeProvenance: writeProductionIdentityProvenance,
};

describe.skipIf(!url)("identity migration provenance (real PostgreSQL)", () => {
  let client: pg.Client;
  const migrate = (overrides = {}) =>
    runProductionIdentityTransaction(
      client,
      { sourceRunId: RUN, mode: "apply" },
      { ...services, ...overrides },
    );
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_provenance_fixture" ||
      parsed.search
    )
      throw new Error("Dedicated loopback provenance fixture required");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    const result = await runMigrations({
      connectionString: url!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(result.failed).toBeNull();
    await client.query(
      `INSERT INTO platform.source_extraction_runs
      (run_id,environment,source_schema_revision,status,finished_at,duration_ms)
      VALUES ($1,'local',repeat('a',40),'completed',now(),0)`,
      [RUN],
    );
  }, 120_000);
  afterAll(async () => {
    await client?.end();
  });

  it("rolls back identity writes when provenance cannot be recorded", async () => {
    await expect(
      runProductionIdentityTransaction(
        client,
        { sourceRunId: "vay1351-ffffffffffffffffffffffff", mode: "apply" },
        services,
      ),
    ).rejects.toThrow("Identity provenance requires a completed source run");
    expect((await client.query("SELECT 1 FROM identity.users")).rowCount).toBe(0);
    expect(
      (await client.query("SELECT 1 FROM platform.identity_migration_provenance")).rowCount,
    ).toBe(0);
  });

  it("atomically records the source, plan, exact after hashes, and unchanged pending statuses", async () => {
    const result = await migrate();
    expect(result.applied).toBe(true);
    const receipts = (await client.query("SELECT * FROM platform.identity_migration_provenance"))
      .rows;
    expect(receipts).toHaveLength(4);
    const observed = await readProductionIdentityProvenance(
      client,
      buildProductionIdentityPlan(rows),
      rows,
    );
    for (const row of observed) {
      const receipt = receipts.find(
        (receipt) => receipt.target_table === row.table && receipt.target_id === row.id,
      );
      expect(receipt).toMatchObject({
        source_run_id: RUN,
        plan_sha256: result.checksum,
        before_sha256: null,
        before_status: null,
        after_sha256: row.rowStateSha256,
        after_status: row.status,
      });
      expect(BigInt(receipt.transaction_id) % 4_294_967_296n).toBe(BigInt(row.xmin));
    }
    expect(observed.find((row) => row.table === "identity.users")?.status).toBe("pending");
    expect((await client.query("SELECT 1 FROM identity.external_identities")).rowCount).toBe(0);
  });

  it("does not relabel identical replays or a newer genuine denial", async () => {
    await migrate();
    expect(
      (await client.query("SELECT 1 FROM platform.identity_migration_provenance")).rowCount,
    ).toBe(4);
    await client.query(
      "UPDATE identity.users SET status='suspended',updated_at='2026-09-01' WHERE id=$1",
      [USER],
    );
    await migrate();
    expect(
      (await client.query("SELECT status FROM identity.users WHERE id=$1", [USER])).rows[0].status,
    ).toBe("suspended");
    expect(
      (
        await client.query(
          "SELECT 1 FROM platform.identity_migration_provenance WHERE target_id=$1",
          [USER],
        )
      ).rowCount,
    ).toBe(1);
  });

  it("excludes other memberships and Marketplace links sharing the PMS owner's organization", async () => {
    const plan = buildProductionIdentityPlan(rows);
    const other = "33333333-3333-4333-8333-333333333333";
    const organization = plan.organizations[0]!.id;
    await client.query("INSERT INTO identity.users(id,email) VALUES($1,'other@example.invalid')", [
      other,
    ]);
    await client.query(
      `INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin)
      VALUES($1,$2,'hotel_owner','agency')`,
      [organization, other],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links
      (organization_id,product,resource_type,resource_id,relationship)
      VALUES($1,'marketplace','hotel_profile',$2,'owner')`,
      [organization, HOTEL],
    );
    plan.memberships.push({ ...plan.memberships[0]!, userId: other });
    plan.resourceLinks.push({
      ...plan.resourceLinks[0]!,
      product: "marketplace",
      resourceType: "hotel_profile",
      relationship: "owner",
    });
    const observed = await readProductionIdentityProvenance(client, plan, rows);
    expect(observed).toHaveLength(4);
    expect(
      observed.filter((row) => row.table === "identity.organization_memberships"),
    ).toHaveLength(1);
    expect(
      observed.filter((row) => row.table === "identity.organization_resource_links"),
    ).toHaveLength(1);
  });

  it("distinguishes an exact value/timestamp restoration from the original migrated version", async () => {
    await client.query("UPDATE identity.users SET status='pending',updated_at=$2 WHERE id=$1", [
      USER,
      TIME,
    ]);
    const observed = await readProductionIdentityProvenance(
      client,
      buildProductionIdentityPlan(rows),
      rows,
    );
    const current = observed.find((row) => row.table === "identity.users")!;
    const receipt = (
      await client.query(
        "SELECT * FROM platform.identity_migration_provenance WHERE target_id=$1",
        [USER],
      )
    ).rows[0];
    expect(current.rowStateSha256).toBe(receipt.after_sha256);
    expect(BigInt(current.xmin)).not.toBe(BigInt(receipt.transaction_id) % 4_294_967_296n);
  });

  it("preserves the exact before-state for real updates, including preexisting denials", async () => {
    await client.query(
      "UPDATE identity.users SET status='suspended',updated_at='2025-12-01' WHERE id=$1",
      [USER],
    );
    const before = (
      await readProductionIdentityProvenance(client, buildProductionIdentityPlan(rows), rows)
    ).find((row) => row.table === "identity.users")!;
    await migrate();
    const receipt = (
      await client.query(
        `SELECT * FROM platform.identity_migration_provenance
      WHERE target_id=$1 ORDER BY transaction_id DESC LIMIT 1`,
        [USER],
      )
    ).rows[0];
    expect(receipt).toMatchObject({
      before_sha256: before.rowStateSha256,
      before_status: "suspended",
      after_status: "pending",
    });
  });

  it("keeps receipts append-only and private to the migration authority", async () => {
    for (const sql of [
      "UPDATE platform.identity_migration_provenance SET after_status='active'",
      "DELETE FROM platform.identity_migration_provenance",
      "TRUNCATE platform.identity_migration_provenance",
    ])
      await expect(client.query(sql)).rejects.toThrow();
    const acl = await client.query(`SELECT count(*)::int AS n FROM pg_class c,
      aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid='platform.identity_migration_provenance'::regclass AND a.grantee=0`);
    expect(acl.rows[0].n).toBe(0);
    await client.query("CREATE ROLE vay2017_provenance_runtime NOLOGIN");
    try {
      await client.query("GRANT USAGE ON SCHEMA platform TO vay2017_provenance_runtime");
      await client.query("SET ROLE vay2017_provenance_runtime");
      expect(
        (
          await client.query(`SELECT current_user AS role,
        has_table_privilege(current_user,'platform.identity_migration_provenance','INSERT') AS can_insert`)
        ).rows,
      ).toEqual([{ role: "vay2017_provenance_runtime", can_insert: false }]);
      await expect(
        client.query("SELECT * FROM platform.identity_migration_provenance"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        client.query(
          `INSERT INTO platform.identity_migration_provenance
        (source_run_id,plan_sha256,target_table,target_id,after_sha256,after_status)
        VALUES ($1,repeat('a',64),'identity.users',$2,repeat('b',64),'pending')`,
          [RUN, USER],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("RESET ROLE");
      await client.query("DROP OWNED BY vay2017_provenance_runtime");
      await client.query("DROP ROLE vay2017_provenance_runtime");
    }
  });
});
