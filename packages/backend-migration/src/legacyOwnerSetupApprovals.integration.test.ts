import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { lockAndVerifyLegacyOwnerSetupApprovals } from "./legacyOwnerSetupApprovalLocks.js";
import {
  hashLegacyOwnerSetupEnvelope,
  verifyLegacyOwnerSetupApprovals,
} from "./legacyOwnerSetupApprovals.js";

const url = process.env["VAY2017_SETUP_APPROVAL_TEST_DATABASE_URL"];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const keys = generateKeyPairSync("ed25519");
const envelope = {
  contractVersion: "legacy-owner-internal-setup.v1",
  commandId: id(10),
  environment: "local",
  issuedAt: "2026-09-15T00:00:00.000Z",
  expiresAt: "2026-09-15T02:00:00.000Z",
  commandSha256: "a".repeat(64),
  migrationApprovalRecordId: id(11),
  securityApprovalRecordId: id(12),
  signingKeyId: "synthetic-only",
};
const canonicalPayload = canonicalizeJson(envelope);
const input = {
  canonicalPayload,
  detachedSignature: sign(
    null,
    Buffer.from(`vayada:legacy-owner-internal-setup:v1\0envelope\0${canonicalPayload}`),
    keys.privateKey,
  ).toString("base64url"),
  expectedCommandSha256: envelope.commandSha256,
  verificationKeys: new Map([[envelope.signingKeyId, keys.publicKey]]),
  environment: "local" as const,
};
const clock = () => new Date("2026-09-15T01:00:00.000Z");
const policy = () => ({
  executionPrincipal: "machine:executor",
  signingPrincipals: new Map([[envelope.signingKeyId, "machine:signer"]]),
  actors: new Map([
    [
      id(1),
      { principal: "human:fixture", authorities: ["migration_owner", "security_owner"] as const },
    ],
  ]),
  singleHumanDualAuthority: { actorUserId: id(1), decisionId: "synthetic-dual-authority" },
});

describe.skipIf(!url)("setup approvals on a fresh dedicated local database", () => {
  let client: pg.Client;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname !== "127.0.0.1" ||
      !["56624", "56625"].includes(parsed.port) ||
      parsed.pathname !== "/vay2017_setup_approval_test" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Dedicated loopback setup approval fixture required");
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
    expect(result.applied).toContain("0213");
    await client.query(
      "INSERT INTO identity.users(id,email) VALUES($1,'approval@example.invalid')",
      [id(1)],
    );
  }, 120_000);
  beforeEach(async () => {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });
  afterAll(async () => {
    await client?.end();
  });

  const seed = async (overrides: Record<string, string> = {}, missing = false) => {
    for (const [index, authority] of ["migration_owner", "security_owner"].entries()) {
      if (missing && index === 1) continue;
      const row = {
        commandId: envelope.commandId,
        version: envelope.contractVersion,
        environment: "local",
        hash: hashLegacyOwnerSetupEnvelope(canonicalPayload),
        actor: id(1),
        approvedAt: "2026-09-15T00:30:00.000Z",
        expiresAt: envelope.expiresAt,
        ...overrides,
      };
      await client.query(
        `INSERT INTO platform.legacy_owner_approval_records
        (approval_record_id,command_id,contract_version,environment,envelope_sha256,authority,actor_user_id,approved_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id(11 + index),
          row.commandId,
          row.version,
          row.environment,
          row.hash,
          authority,
          index === 1 && overrides.securityActor ? overrides.securityActor : row.actor,
          row.approvedAt,
          row.expiresAt,
        ],
      );
    }
  };
  it("accepts distinct setup authority rows without granting execution", async () => {
    await seed();
    expect(await verifyLegacyOwnerSetupApprovals(client, input, policy(), clock)).toEqual({
      outcome: "approvals_match_requires_command_validation",
      executable: false,
    });
  });
  it("also accepts two independent authorized humans", async () => {
    await client.query("INSERT INTO identity.users(id,email) VALUES($1,'second@example.invalid')", [
      id(2),
    ]);
    await seed({ securityActor: id(2) });
    const config = policy();
    config.actors.set(id(2), {
      principal: "human:second",
      authorities: ["migration_owner", "security_owner"],
    });
    config.singleHumanDualAuthority.decisionId = "";
    await expect(
      verifyLegacyOwnerSetupApprovals(client, input, config, clock),
    ).resolves.toMatchObject({ executable: false });
  });
  it("sanitizes missing registry storage", async () => {
    await client.query(
      "ALTER TABLE platform.legacy_owner_approval_records RENAME TO hidden_approvals",
    );
    await expect(verifyLegacyOwnerSetupApprovals(client, input, policy(), clock)).rejects.toThrow(
      /^LEGACY_OWNER_SETUP_APPROVALS_INVALID$/,
    );
  });
  it("preserves command/authority uniqueness across operation versions", async () => {
    await seed();
    await expect(
      client.query(
        `INSERT INTO platform.legacy_owner_approval_records
      SELECT $1,command_id,'legacy-pms-owner-evidence.v1',environment,envelope_sha256,authority,
        actor_user_id,approved_at,expires_at,recorded_at
      FROM platform.legacy_owner_approval_records WHERE approval_record_id=$2`,
        [id(99), id(11)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
  it.each([
    ["version", "legacy-pms-owner-evidence.v1"],
    ["commandId", id(99)],
    ["environment", "production"],
    ["hash", "b".repeat(64)],
    ["approvedAt", "2026-09-14T23:59:00.000Z"],
    ["approvedAt", "2026-09-15T01:01:00.000Z"],
    ["expiresAt", "2026-09-15T03:00:00.000Z"],
  ])("rejects mismatched stored %s", async (field, value) => {
    await seed({ [field!]: value! });
    await expect(verifyLegacyOwnerSetupApprovals(client, input, policy(), clock)).rejects.toThrow(
      "LEGACY_OWNER_SETUP_APPROVALS_INVALID",
    );
  });
  it("rejects a missing authority", async () => {
    await seed({}, true);
    await expect(verifyLegacyOwnerSetupApprovals(client, input, policy(), clock)).rejects.toThrow();
  });
  it("rejects revoked setup approval and retains both records", async () => {
    await seed();
    await client.query(
      "INSERT INTO platform.legacy_owner_approval_revocations VALUES($1,$2,$3,$4,now())",
      [id(11), id(1), clock(), "f".repeat(64)],
    );
    await expect(verifyLegacyOwnerSetupApprovals(client, input, policy(), clock)).rejects.toThrow();
    expect(
      (await client.query("SELECT count(*)::int AS n FROM platform.legacy_owner_approval_records"))
        .rows[0].n,
    ).toBe(2);
  });
  it("rejects a revocation hidden by row security", async () => {
    await seed();
    await client.query(
      "INSERT INTO platform.legacy_owner_approval_revocations VALUES($1,$2,$3,$4,now())",
      [id(11), id(1), clock(), "f".repeat(64)],
    );
    await client.query("CREATE ROLE vay2017_setup_rls_probe");
    await client.query("GRANT USAGE ON SCHEMA platform TO vay2017_setup_rls_probe");
    await client.query(
      "GRANT SELECT ON platform.legacy_owner_approval_records, platform.legacy_owner_approval_revocations TO vay2017_setup_rls_probe",
    );
    await client.query(
      "ALTER TABLE platform.legacy_owner_approval_revocations ENABLE ROW LEVEL SECURITY",
    );
    await client.query("SET LOCAL ROLE vay2017_setup_rls_probe");
    try {
      expect(
        (await client.query("SELECT * FROM platform.legacy_owner_approval_revocations")).rows,
      ).toEqual([]);
      await expect(verifyLegacyOwnerSetupApprovals(client, input, policy(), clock)).rejects.toThrow(
        "LEGACY_OWNER_SETUP_APPROVALS_INVALID",
      );
    } finally {
      await client.query("RESET ROLE");
    }
  });
  it.each([
    "dual authority",
    "executor signer",
    "executor actor",
    "signer actor",
    "actor permission",
  ])("rejects invalid %s separation", async (change) => {
    await seed();
    const config = policy();
    if (change === "dual authority") config.singleHumanDualAuthority.decisionId = "";
    if (change === "executor signer") config.executionPrincipal = "machine:signer";
    if (change === "executor actor") config.executionPrincipal = "human:fixture";
    if (change === "signer actor")
      config.signingPrincipals.set(envelope.signingKeyId, "human:fixture");
    if (change === "actor permission") config.actors.clear();
    await expect(verifyLegacyOwnerSetupApprovals(client, input, config, clock)).rejects.toThrow();
  });
  it("rechecks expiry after the registry read", async () => {
    await seed();
    let calls = 0;
    await expect(
      verifyLegacyOwnerSetupApprovals(client, input, policy(), () =>
        ++calls === 1 ? clock() : new Date(envelope.expiresAt),
      ),
    ).rejects.toThrow();
  });
  it("rejects unknown operation versions at storage", async () => {
    await expect(seed({ version: "arbitrary-operation.v1" })).rejects.toMatchObject({
      code: "23514",
    });
  });
  it.each(["UPDATE", "DELETE", "TRUNCATE"])(
    "preserves append-only protection for setup: %s",
    async (action) => {
      await seed();
      const sql =
        action === "UPDATE"
          ? "UPDATE platform.legacy_owner_approval_records SET authority=authority"
          : `${action === "DELETE" ? "DELETE FROM" : "TRUNCATE"} platform.legacy_owner_approval_records`;
      await expect(
        client.query(sql + (action === "TRUNCATE" ? " CASCADE" : "")),
      ).rejects.toMatchObject({ code: "55000" });
    },
  );
  it.each([
    "ROLLBACK",
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
    "SET LOCAL lock_timeout = '0'",
    "SET LOCAL statement_timeout = '0'",
    "SET TRANSACTION READ ONLY",
  ])("rejects an unsafe caller transaction: %s", async (sql) => {
    await client.query(sql);
    await expect(
      lockAndVerifyLegacyOwnerSetupApprovals(client, input, policy(), clock),
    ).rejects.toThrow(/^LEGACY_OWNER_SETUP_APPROVAL_LOCKS_INVALID$/);
  });
  it("rejects absent records and an expired signature without write authority", async () => {
    await expect(
      lockAndVerifyLegacyOwnerSetupApprovals(client, input, policy(), clock),
    ).rejects.toThrow(/^LEGACY_OWNER_SETUP_APPROVAL_LOCKS_INVALID$/);
    await expect(
      lockAndVerifyLegacyOwnerSetupApprovals(
        client,
        input,
        policy(),
        () => new Date(envelope.expiresAt),
      ),
    ).rejects.toThrow(/^LEGACY_OWNER_SETUP_APPROVAL_LOCKS_INVALID$/);
  });
  // Last test deliberately commits synthetic approvals so other connections
  // can see them. The entire dedicated fixture database is disposable.
  it("serializes both revocation orders using actual PostgreSQL blockers", async () => {
    await seed();
    await client.query("COMMIT");
    const revoker = new pg.Client({ connectionString: url });
    const observer = new pg.Client({ connectionString: url });
    const connected: pg.Client[] = [];
    let pending: Promise<unknown> | undefined;
    try {
      for (const connection of [revoker, observer]) {
        await connection.connect();
        connected.push(connection);
      }
      for (const connection of [client, revoker]) {
        await connection.query("BEGIN");
        await connection.query("SET LOCAL lock_timeout = '5s'");
        await connection.query("SET LOCAL statement_timeout = '10s'");
      }
      const firstPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const secondPid = (await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const blocked = async (holder: number, waiter: number) => {
        await expect
          .poll(
            async () =>
              (
                await observer.query("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
                  holder,
                  waiter,
                ])
              ).rows[0].blocked,
            { timeout: 2_000 },
          )
          .toBe(true);
      };
      expect(await lockAndVerifyLegacyOwnerSetupApprovals(client, input, policy(), clock)).toEqual({
        outcome: "approvals_locked_requires_command_validation",
        executable: false,
      });
      pending = revoker
        .query("INSERT INTO platform.legacy_owner_approval_revocations VALUES($1,$2,$3,$4,now())", [
          id(11),
          id(1),
          clock(),
          "f".repeat(64),
        ])
        .then(
          () => "inserted",
          () => "failed",
        );
      await blocked(firstPid, secondPid);
      expect(
        (await observer.query("SELECT * FROM platform.legacy_owner_approval_revocations")).rows,
      ).toEqual([]);
      await client.query("ROLLBACK");
      expect(await pending).toBe("inserted");

      // The uncommitted revocation now holds FK KEY SHARE. Setup must wait,
      // then see the committed revocation in a fresh statement and reject.
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      pending = lockAndVerifyLegacyOwnerSetupApprovals(client, input, policy(), clock).then(
        () => "accepted",
        (error: Error) => error.message,
      );
      await blocked(secondPid, firstPid);
      await revoker.query("COMMIT");
      expect(await pending).toBe("LEGACY_OWNER_SETUP_APPROVAL_LOCKS_INVALID");
      await client.query("ROLLBACK");
      expect(
        (await observer.query("SELECT count(*)::int AS n FROM identity.users")).rows[0].n,
      ).toBe(1);
      expect(
        (await observer.query("SELECT * FROM platform.legacy_owner_bootstrap_receipts")).rows,
      ).toEqual([]);
    } finally {
      await Promise.allSettled(
        [client, ...connected].map((connection) => connection.query("ROLLBACK")),
      );
      await pending;
      await Promise.allSettled(connected.map((connection) => connection.end()));
    }
  }, 20_000);
});
