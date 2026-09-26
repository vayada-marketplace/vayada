import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";
import { runProductionIdentityTransaction } from "./productionIdentityMigration.js";
import { buildProductionIdentityPlan } from "./productionIdentityPlan.js";
import { readProductionIdentityTargetState } from "./productionIdentityTargetReader.js";
import { writeProductionIdentityCore } from "./productionIdentityCoreWriter.js";
import { writeProductionIdentityPrivacyAudit } from "./productionIdentityPrivacyAuditWriter.js";
import {
  readProductionIdentityProvenance,
  writeProductionIdentityProvenance,
  identityMigrationXidWithinHorizon,
} from "./productionIdentityProvenance.js";
import {
  readIdentityMigrationTargetRow,
  readOrganizationMappingRow,
} from "./channexAdoptionTargetRows.js";
import {
  verifyOrganizationMappingProof,
  type OrganizationMappingProof,
} from "./legacyOrganizationMappingProof.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const url = process.env["VAY2017_MAPPING_PROOF_TEST_DATABASE_URL"];
const RUN = "vay1351-0123456789abcdef01234567";
const TIME = "2026-01-01T00:00:00.123Z";
describe.skipIf(!url)("internal organization mapping proof (real PostgreSQL receipts)", () => {
  let client: pg.Client;
  let proof: OrganizationMappingProof;
  let provider: string;
  async function state(transactionId: string): Promise<OrganizationMappingProof["before"]> {
    const row = await readOrganizationMappingRow(client, proof.organizationId);
    return {
      transactionId,
      rowStateSha256: (
        await readIdentityMigrationTargetRow(client, "identity.organizations", proof.organizationId)
      ).rowStateSha256,
      values: {
        workos_org_id: row["workos_org_id"] as string | null,
        workos_external_id: row["workos_external_id"] as string | null,
        updated_at: row["updated_at"] as string,
      },
    };
  }
  async function verify() {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      return await verifyOrganizationMappingProof(client, proof, provider);
    } finally {
      await client.query("ROLLBACK");
    }
  }
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_mapping_proof_fixture" ||
      parsed.search
    )
      throw new Error("Dedicated loopback mapping-proof fixture required");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    const migration = await runMigrations({
      connectionString: url!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(migration.failed).toBeNull();
    await client.query(
      `INSERT INTO platform.source_extraction_runs
      (run_id,environment,source_schema_revision,status,finished_at,duration_ms)
      VALUES ($1,'local',repeat('a',40),'completed',now(),0)`,
      [RUN],
    );
    await client.query(
      "ALTER TABLE identity.organizations ADD COLUMN proof_future text DEFAULT 'retained'",
    );
  }, 120_000);
  afterAll(async () => {
    await client?.end();
  });
  beforeEach(async () => {
    const user = randomUUID(),
      hotel = randomUUID();
    const common = { name: "Fixture", created_at: TIME, updated_at: TIME };
    const rows: IdentitySourceRow[] = [
      {
        sourceDatabase: "auth",
        sourceTable: "users",
        rowOrdinal: 1,
        data: {
          ...common,
          id: user,
          email: `${user}@example.invalid`,
          type: "hotel",
          status: "pending",
          email_verified: false,
          is_superadmin: false,
        },
      },
      {
        sourceDatabase: "pms",
        sourceTable: "hotels",
        rowOrdinal: 1,
        data: { ...common, id: hotel, user_id: user },
      },
    ];
    const result = await runProductionIdentityTransaction(
      client,
      { sourceRunId: RUN, mode: "apply" },
      {
        readSnapshot: async () => ({ rows, sourceHorizonAt: TIME }),
        readTarget: readProductionIdentityTargetState,
        buildPlan: buildProductionIdentityPlan,
        writeCore: writeProductionIdentityCore,
        writePrivacyAudit: writeProductionIdentityPrivacyAudit,
        readProvenance: readProductionIdentityProvenance,
        writeProvenance: writeProductionIdentityProvenance,
      },
    );
    expect(result.applied).toBe(true);
    const organizationId = buildProductionIdentityPlan(rows).organizations[0]!.id;
    const {
      rows: [receipt],
    } = await client.query(
      `SELECT transaction_id::text, after_sha256
      FROM platform.identity_migration_provenance WHERE target_table='identity.organizations'
      AND target_id=$1`,
      [organizationId],
    );
    proof = {
      organizationId,
      sourceRunId: RUN,
      planSha256: result.checksum,
    } as OrganizationMappingProof;
    proof.before = await state(receipt.transaction_id);
    expect(proof.before.rowStateSha256).toBe(receipt.after_sha256);
    provider = `org_${user.replaceAll("-", "")}`;
    // Synthetic transition only: no executor, persisted mapping receipt or provider operation.
    await client.query("BEGIN");
    await client.query(
      `UPDATE identity.organizations SET workos_org_id=$2,
      workos_external_id=id::text,updated_at=transaction_timestamp() WHERE id=$1`,
      [organizationId, provider],
    );
    proof.after = await state(
      (await client.query("SELECT pg_current_xact_id()::text AS id")).rows[0].id,
    );
    await client.query("COMMIT");
  });
  it("reconstructs original canonical hashes and preserves native timestamp precision", async () => {
    expect(proof.before.values.updated_at).toBe("2026-01-01T00:00:00.123000Z");
    expect(proof.after.values.updated_at).toMatch(/\.\d{6}Z$/);
    expect(await verify()).toBe(true);
  });
  it.each([
    [0n, true],
    [2_147_483_647n, true],
    [2_147_483_648n, false],
    [-1n, false],
  ] as const)("checks full-XID age %s", async (age, allowed) => {
    const xid = proof.before.transactionId;
    expect(identityMigrationXidWithinHorizon(xid, String(BigInt(xid) + age))).toBe(allowed);
  });
  it.each(["sourceRunId", "planSha256", "organizationId"] as const)(
    "rejects a different original receipt %s",
    async (field) => {
      proof[field] = field === "organizationId" ? randomUUID() : "f".repeat(64);
      expect(await verify()).toBe(false);
    },
  );
  it.each([
    "before hash",
    "after hash",
    "before xid",
    "after xid",
    "negative xid",
    "overflow xid",
    "missing value",
    "extra value",
    "timestamp truncation",
    "timestamp tamper",
    "changed old provider",
    "changed old external",
    "changed after external",
    "wrong provider",
    "no-op",
  ])("rejects %s", async (change) => {
    if (change === "before hash") proof.before.rowStateSha256 = "0".repeat(64);
    if (change === "after hash") proof.after.rowStateSha256 = "0".repeat(64);
    if (change === "before xid")
      proof.before.transactionId = String(BigInt(proof.before.transactionId) - 1n);
    if (change === "after xid")
      proof.after.transactionId = String(BigInt(proof.after.transactionId) + 4_294_967_296n);
    if (change === "negative xid") proof.before.transactionId = "-1";
    if (change === "overflow xid") proof.after.transactionId = "18446744073709551616";
    if (change === "missing value")
      delete (proof.before.values as Partial<typeof proof.before.values>).workos_org_id;
    if (change === "extra value") Object.assign(proof.before.values, { status: "active" });
    if (change === "timestamp truncation")
      proof.before.values.updated_at = new Date(proof.before.values.updated_at).toISOString();
    if (change === "timestamp tamper")
      proof.before.values.updated_at = "2026-01-01T00:00:00.123001Z";
    if (change === "changed old provider") proof.before.values.workos_org_id = "org_other";
    if (change === "changed old external") proof.before.values.workos_external_id = randomUUID();
    if (change === "changed after external") proof.after.values.workos_external_id = randomUUID();
    if (change === "wrong provider") provider = "org_other";
    if (change === "no-op") proof.before.values = { ...proof.after.values };
    expect(await verify()).toBe(false);
  });
  it.each([
    "status='active'",
    "name='changed'",
    "proof_future='changed'",
    "workos_org_id='org_other'",
  ])("rejects even a refreshed after hash for %s", async (delta) => {
    await client.query("BEGIN");
    await client.query(`UPDATE identity.organizations SET ${delta} WHERE id=$1`, [
      proof.organizationId,
    ]);
    proof.after = await state(
      (await client.query("SELECT pg_current_xact_id()::text AS id")).rows[0].id,
    );
    await client.query("COMMIT");
    expect(await verify()).toBe(false);
  });
  it("rejects a later one-microsecond timestamp change", async () => {
    await client.query(
      "UPDATE identity.organizations SET updated_at=updated_at+interval '1 microsecond' WHERE id=$1",
      [proof.organizationId],
    );
    expect(await verify()).toBe(false);
  });
  it("rejects unchanged updated_at with actual after hashes and XIDs", async () => {
    await client.query("BEGIN");
    await client.query("UPDATE identity.organizations SET updated_at=$2 WHERE id=$1", [
      proof.organizationId,
      proof.before.values.updated_at,
    ]);
    proof.after = await state(
      (await client.query("SELECT pg_current_xact_id()::text AS id")).rows[0].id,
    );
    await client.query("COMMIT");
    expect(proof.after.values.updated_at).toBe(proof.before.values.updated_at);
    expect(await verify()).toBe(false);
  });
  it("rejects ABA even when every value and the full row hash return to the mapped state", async () => {
    await client.query("UPDATE identity.organizations SET name='temporary' WHERE id=$1", [
      proof.organizationId,
    ]);
    await client.query("UPDATE identity.organizations SET name='Fixture' WHERE id=$1", [
      proof.organizationId,
    ]);
    expect((await state(proof.after.transactionId)).rowStateSha256).toBe(
      proof.after.rowStateSha256,
    );
    expect(await verify()).toBe(false);
  });
  it("requires a stable snapshot instead of accepting independently read row versions", async () => {
    expect(await verifyOrganizationMappingProof(client, proof, provider)).toBe(false);
  });
});
