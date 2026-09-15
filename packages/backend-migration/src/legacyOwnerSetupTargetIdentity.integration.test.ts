import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashLegacyOwnerSetupValue } from "./legacyOwnerSetupReceiptHashes.js";
import {
  verifyLegacyOwnerSetupTargetIdentity,
  type LegacyOwnerSetupTargetIdentity,
} from "./legacyOwnerSetupTargetIdentity.js";

const url = process.env.VAY2017_TARGET_IDENTITY_TEST_DATABASE_URL;
const digest = (value: unknown) => hashLegacyOwnerSetupValue("target-database-identity", value);
describe.skipIf(!url)("protected target identity on dedicated PostgreSQL", () => {
  let admin: pg.Client, reader: pg.Client, artifact: LegacyOwnerSetupTargetIdentity;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname !== "127.0.0.1" ||
      !["56634", "56635"].includes(parsed.port) ||
      parsed.pathname !== "/vay2017_target_identity_test" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Dedicated target identity fixture required");
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE ROLE vayada_migration_attestor NOLOGIN;
      CREATE ROLE vay2017_identity_reader LOGIN;
      CREATE SCHEMA vayada_migration_evidence AUTHORIZATION vayada_migration_attestor;
      SET ROLE vayada_migration_attestor;
      CREATE TABLE vayada_migration_evidence.database_attestations (
        attestation_key text PRIMARY KEY, attestation_value text NOT NULL,
        attested_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO vayada_migration_evidence.database_attestations VALUES
        ('vayada.target_environment','local',now()),
        ('vayada.target_identity_sha256',repeat('a',64),now());
      GRANT USAGE ON SCHEMA vayada_migration_evidence TO vay2017_identity_reader;
      GRANT SELECT ON vayada_migration_evidence.database_attestations TO vay2017_identity_reader;
      RESET ROLE`);
    const rows = await admin.query(
      "SELECT current_database() AS name, oid::int FROM pg_database WHERE datname=current_database()",
    );
    artifact = {
      contractVersion: "legacy-owner-setup-target-identity.v1",
      environment: "local",
      targetIdentitySha256: "a".repeat(64),
      databaseName: rows.rows[0].name,
      databaseOid: rows.rows[0].oid,
    };
    parsed.username = "vay2017_identity_reader";
    reader = new pg.Client({ connectionString: parsed.toString() });
    await reader.connect();
  });
  afterAll(async () => {
    await reader?.end();
    await admin?.end();
  });
  async function verify(value: unknown = artifact, expected = digest(value)) {
    await reader.query("BEGIN");
    try {
      return await verifyLegacyOwnerSetupTargetIdentity(reader, value, expected);
    } finally {
      await reader.query("ROLLBACK");
    }
  }
  it("matches protected evidence and the actual connected database as restricted reader", async () => {
    expect(await verify()).toEqual({
      outcome: "target_identity_matches_requires_authorized_runner",
      targetDatabaseSha256: digest(artifact),
      executable: false,
    });
  });
  it.each(["databaseName", "databaseOid", "environment", "targetIdentitySha256"] as const)(
    "rejects wrong %s despite matching supplied digest",
    async (field) => {
      const changed = {
        ...artifact,
        [field]:
          field === "databaseOid"
            ? artifact.databaseOid + 1
            : field === "environment"
              ? "production"
              : field === "targetIdentitySha256"
                ? "b".repeat(64)
                : "another_database",
      };
      await expect(verify(changed)).rejects.toThrow("LEGACY_OWNER_TARGET_IDENTITY_INVALID");
    },
  );
  it("rejects an independently expected digest mismatch", async () => {
    await expect(verify(artifact, "b".repeat(64))).rejects.toThrow(
      "LEGACY_OWNER_TARGET_IDENTITY_INVALID",
    );
  });
  it.each([null, [], {}, { extra: true }, { databaseOid: -1 }, { databaseOid: 4294967296 }])(
    "rejects malformed artifacts",
    async (change) => {
      const value =
        change === null || Array.isArray(change)
          ? change
          : {
              ...artifact,
              ...change,
              ...(Object.keys(change).length ? {} : { contractVersion: "wrong" }),
            };
      await expect(verify(value)).rejects.toThrow("LEGACY_OWNER_TARGET_IDENTITY_INVALID");
    },
  );
  it("requires a caller transaction", async () => {
    await expect(
      verifyLegacyOwnerSetupTargetIdentity(reader, artifact, digest(artifact)),
    ).rejects.toThrow("LEGACY_OWNER_TARGET_IDENTITY_INVALID");
  });
  it("requires the protected table even with database-scoped settings", async () => {
    await admin.query(
      "ALTER DATABASE vay2017_target_identity_test SET vayada.target_environment = 'local'",
    );
    await admin.query(
      "ALTER TABLE vayada_migration_evidence.database_attestations RENAME TO temporarily_missing",
    );
    try {
      await expect(verify()).rejects.toThrow("LEGACY_OWNER_TARGET_IDENTITY_INVALID");
    } finally {
      await admin.query(
        "ALTER TABLE vayada_migration_evidence.temporarily_missing RENAME TO database_attestations",
      );
    }
  });
  it("rejects executor-writable attestation storage", async () => {
    await admin.query(
      "GRANT UPDATE ON vayada_migration_evidence.database_attestations TO vay2017_identity_reader",
    );
    try {
      await expect(verify()).rejects.toThrow("LEGACY_OWNER_TARGET_IDENTITY_INVALID");
    } finally {
      await admin.query(
        "REVOKE UPDATE ON vayada_migration_evidence.database_attestations FROM vay2017_identity_reader",
      );
    }
  });
  it("rejects hidden evidence", async () => {
    await admin.query(
      "ALTER TABLE vayada_migration_evidence.database_attestations ENABLE ROW LEVEL SECURITY",
    );
    try {
      await expect(verify()).rejects.toThrow("LEGACY_OWNER_TARGET_IDENTITY_INVALID");
    } finally {
      await admin.query(
        "ALTER TABLE vayada_migration_evidence.database_attestations DISABLE ROW LEVEL SECURITY",
      );
    }
  });
  it("rejects a protected attestation copied into a different actual database", async () => {
    await admin.query("CREATE DATABASE vay2017_target_identity_copy");
    const parsed = new URL(url!);
    parsed.pathname = "/vay2017_target_identity_copy";
    const copiedAdmin = new pg.Client({ connectionString: parsed.toString() });
    parsed.username = "vay2017_identity_reader";
    const copiedReader = new pg.Client({ connectionString: parsed.toString() });
    try {
      await copiedAdmin.connect();
      await copiedAdmin.query(`CREATE SCHEMA vayada_migration_evidence AUTHORIZATION vayada_migration_attestor;
        SET ROLE vayada_migration_attestor;
        CREATE TABLE vayada_migration_evidence.database_attestations (
          attestation_key text PRIMARY KEY, attestation_value text NOT NULL,
          attested_at timestamptz NOT NULL DEFAULT now());
        INSERT INTO vayada_migration_evidence.database_attestations VALUES
          ('vayada.target_environment','local',now()),
          ('vayada.target_identity_sha256',repeat('a',64),now());
        GRANT USAGE ON SCHEMA vayada_migration_evidence TO vay2017_identity_reader;
        GRANT SELECT ON vayada_migration_evidence.database_attestations TO vay2017_identity_reader;
        RESET ROLE`);
      await copiedReader.connect();
      await copiedReader.query("BEGIN");
      await expect(
        verifyLegacyOwnerSetupTargetIdentity(copiedReader, artifact, digest(artifact)),
      ).rejects.toThrow("LEGACY_OWNER_TARGET_IDENTITY_INVALID");
      await copiedReader.query("ROLLBACK");
    } finally {
      await copiedReader.end();
      await copiedAdmin.end();
    }
  });
  it("pins the exact relation against replacement until caller rollback", async () => {
    await reader.query("BEGIN");
    try {
      await verifyLegacyOwnerSetupTargetIdentity(reader, artifact, digest(artifact));
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "LOCK TABLE vayada_migration_evidence.database_attestations IN ACCESS EXCLUSIVE MODE NOWAIT",
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await admin.query("ROLLBACK");
    } finally {
      await reader.query("ROLLBACK");
      await admin.query("ROLLBACK");
    }
  });
  it("restores caller search_path and usable transaction on rejection", async () => {
    await reader.query("BEGIN");
    await reader.query("SET LOCAL search_path = public");
    try {
      await expect(
        verifyLegacyOwnerSetupTargetIdentity(
          reader,
          { ...artifact, databaseOid: artifact.databaseOid + 1 },
          digest({ ...artifact, databaseOid: artifact.databaseOid + 1 }),
        ),
      ).rejects.toThrow("LEGACY_OWNER_TARGET_IDENTITY_INVALID");
      expect((await reader.query("SHOW search_path")).rows[0].search_path).toBe("public");
    } finally {
      await reader.query("ROLLBACK");
    }
  });
});
