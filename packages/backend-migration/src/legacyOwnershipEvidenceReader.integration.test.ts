import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readLegacyOwnershipTargetRow } from "./channexAdoptionTargetRows.js";
import { readLegacyOwnershipDrift } from "./legacyOwnershipEvidenceReader.js";
import {
  LEGACY_OWNERSHIP_ROW_TABLES,
  type LegacyOwnershipFingerprint,
} from "./legacyOwnershipBeforeState.js";

const url = process.env["VAY2017_EVIDENCE_TEST_DATABASE_URL"];
describe.skipIf(!url)("ownership reader on disposable local PostgreSQL", () => {
  let client: pg.Client;
  const fingerprints: LegacyOwnershipFingerprint[] = [];
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_evidence_fixture" ||
      parsed.search
    )
      throw new Error("Only the dedicated loopback fixture database is allowed");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    // Fail rather than reusing any pre-existing schemas or fixture data.
    await client.query("CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog");
    for (const table of new Set(Object.values(LEGACY_OWNERSHIP_ROW_TABLES))) {
      await client.query(`CREATE TABLE ${table} (id uuid PRIMARY KEY, status text NOT NULL,
        updated_at timestamptz NOT NULL, revision bigint NOT NULL, metadata jsonb NOT NULL)`);
    }
    for (const [index, [kind, table]] of Object.entries(LEGACY_OWNERSHIP_ROW_TABLES).entries()) {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      await client.query(
        `INSERT INTO ${table} VALUES ($1, 'pending', '2026-09-14T00:00:00.123456Z', 9007199254740993, '{"proof":"synthetic"}')`,
        [id],
      );
      fingerprints.push({
        kind: kind as LegacyOwnershipFingerprint["kind"],
        table,
        ...(await readLegacyOwnershipTargetRow(client, table, id)),
      });
    }
  });
  afterAll(async () => {
    await client?.end();
  });

  it("compares real full-row fingerprints within a read-only transaction", async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      expect(await readLegacyOwnershipDrift(client, fingerprints)).toEqual({
        outcome: "unchanged",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it("detects microsecond timestamp drift that JavaScript Date would lose", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        "UPDATE identity.users SET updated_at = updated_at + interval '1 microsecond'",
      );
      expect(await readLegacyOwnershipDrift(client, fingerprints)).toEqual({
        outcome: "blocked",
        reason: "target_drift",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it("rejects missing ownership records", async () => {
    await client.query("BEGIN");
    try {
      await client.query("DELETE FROM identity.organization_memberships");
      await expect(readLegacyOwnershipDrift(client, fingerprints)).rejects.toMatchObject({
        code: "TARGET_ROW_MISMATCH",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
