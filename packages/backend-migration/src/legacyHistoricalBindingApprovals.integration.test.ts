import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import {
  LEGACY_OWNERSHIP_ROW_TABLES,
  type LegacyOwnershipFingerprint,
} from "./legacyOwnershipBeforeState.js";
import {
  hashLegacyHistoricalBindingApprovalEvidence,
  type LegacyHistoricalBindingApprovalEvidence,
} from "./legacyHistoricalBindingEnvelope.js";
import {
  hashLegacyHistoricalBindingEnvelope,
  lockAndVerifyLegacyHistoricalBindingApprovals as verify,
} from "./legacyHistoricalBindingApprovals.js";
import { runMigrations } from "./runner.js";

const url = process.env["VAY2017_BINDING_APPROVAL_TEST_DATABASE_URL"];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = "a".repeat(64);
const keys = generateKeyPairSync("ed25519");
const proof = {
  sourceRunId: `vay1351-${"a".repeat(24)}`,
  sourceEnvironment: "local" as const,
  sourceSchemaRevision: "b".repeat(40),
  sourceEvidenceSha256: sha,
};
const source = {
  id: id(20),
  hotelId: id(10),
  externalPropertyId: id(21),
  rowOrdinal: 1,
  rowChecksumSha256: sha,
};
const evidence: LegacyHistoricalBindingApprovalEvidence = {
  owner: {
    source: {
      ...proof,
      legacyHotelId: id(10),
      ownerUserId: id(1),
      hotelRowOrdinal: 1,
      userRowOrdinal: 1,
    },
    target: Object.entries(LEGACY_OWNERSHIP_ROW_TABLES).map(([kind, table], i) => ({
      kind,
      table,
      id: id(i + 1),
      rowStateSha256: sha,
    })) as LegacyOwnershipFingerprint[],
    identity: {
      userId: id(1),
      organizationId: id(3),
      externalIdentityId: id(11),
      externalIdentitySha256: sha,
      workosUserId: "user_fixture",
      workosOrgId: "org_fixture",
    },
  },
  binding: {
    sourceRequest: { ...proof, snapshotIdentifierSha256: sha, source },
    bindingExpected: {
      sourceRunId: proof.sourceRunId,
      source,
      propertyId: id(4),
      claim: { id: id(22), rowStateSha256: sha },
      connections: [{ id: id(23), rowStateSha256: sha }],
    },
    property: { id: id(4), rowStateSha256: sha },
  },
  sourceActive: true,
  targetBeforeSha256: sha,
  targetAfterSha256: "b".repeat(64),
};
const envelope = {
  contractVersion: "legacy-historical-binding-transition.v1",
  commandId: id(30),
  environment: "local",
  purpose: "prepare",
  originalPrepareCommandId: null,
  issuedAt: "2026-09-15T01:00:00.000Z",
  expiresAt: "2026-09-15T02:00:00.000Z",
  evidenceSha256: hashLegacyHistoricalBindingApprovalEvidence(evidence),
  migrationApprovalRecordId: id(31),
  securityApprovalRecordId: id(32),
  signingKeyId: "fixture",
};
const canonicalPayload = canonicalizeJson(envelope);
const input = {
  canonicalPayload,
  evidence,
  environment: "local" as const,
  verificationKeys: new Map([["fixture", keys.publicKey]]),
  detachedSignature: sign(
    null,
    Buffer.from(`vayada:legacy-historical-binding-transition:v1\0envelope\0${canonicalPayload}`),
    keys.privateKey,
  ).toString("base64url"),
};
const clock = () => new Date("2026-09-15T01:30:00.000Z");
const policy = () => ({
  executionPrincipal: "machine:executor",
  signingPrincipals: new Map([["fixture", "machine:signer"]]),
  actors: new Map(
    [1, 2].map((n) => [
      id(n),
      { principal: `human:${n}`, authorities: ["migration_owner", "security_owner"] as const },
    ]),
  ),
  singleHumanDualAuthority: { actorUserId: id(1), decisionId: "synthetic-decision" },
});
describe.skipIf(!url)("signed historical registry and retained row locks", () => {
  let client: pg.Client;
  let other: pg.Client;
  const records = "platform.legacy_owner_approval_records";
  const revocations = "platform.legacy_owner_approval_revocations";
  const begin = (db = client) =>
    db.query("BEGIN; SET LOCAL lock_timeout='150ms'; SET LOCAL statement_timeout='3s'");
  const seed = async (change: Record<string, unknown> = {}, offset = 0) => {
    for (const [n, authority] of [
      [31, "migration_owner"],
      [32, "security_owner"],
    ] as const) {
      const row = {
        approval_record_id: id(n + offset),
        command_id: envelope.commandId,
        contract_version: envelope.contractVersion,
        environment: "local",
        envelope_sha256: hashLegacyHistoricalBindingEnvelope(canonicalPayload),
        authority,
        actor_user_id: id(n === 31 ? 1 : 2),
        approved_at: "2026-09-15T01:10:00Z",
        expires_at: envelope.expiresAt,
        ...change,
      };
      await client.query(
        `INSERT INTO ${records} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
          .map((_, i) => `$${i + 1}`)
          .join(",")})`,
        Object.values(row),
      );
    }
  };
  const revoke = (db = client) =>
    db.query(
      `INSERT INTO ${revocations}
    (approval_record_id,revoked_by_user_id,revoked_at,reason_sha256) VALUES($1,$2,$3,$4)`,
      [id(31), id(1), clock().toISOString(), sha],
    );
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname !== "127.0.0.1" ||
      !["56636", "56637"].includes(parsed.port) ||
      parsed.pathname !== "/vay2017_binding_approval_fixture" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Dedicated loopback binding approval fixture required");
    client = new pg.Client({ connectionString: url });
    other = new pg.Client({ connectionString: url });
    await client.connect();
    await other.connect();
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    const result = await runMigrations({
      connectionString: url!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(result.failed).toBeNull();
    expect(result.applied).toContain("0215");
    await client.query(
      "INSERT INTO identity.users(id,email) VALUES($1,'binding-one@example.test'),($2,'binding-two@example.test')",
      [id(1), id(2)],
    );
    await seed();
  }, 120000);
  beforeEach(() => begin());
  afterEach(async () => {
    await other.query("ROLLBACK");
    await client.query("ROLLBACK");
  });
  afterAll(async () => {
    await other?.end();
    await client?.end();
  });
  it("verifies real signatures and retains locks against revocation", async () => {
    expect(await verify(client, input, policy(), clock)).toEqual({
      outcome: "approvals_locked_requires_eligibility",
      executable: false,
    });
    await begin(other);
    await expect(revoke(other)).rejects.toMatchObject({ code: "55P03" });
  });
  it("sees revocation committed before verification", async () => {
    await revoke();
    await expect(verify(client, input, policy(), clock)).rejects.toThrow("APPROVALS_INVALID");
  });
  it.each(["missing", "executor", "signer", "authority", "dual"])(
    "rejects invalid principal policy: %s",
    async (kind) => {
      const p = policy();
      if (kind === "missing") p.actors.clear();
      if (kind === "executor") p.executionPrincipal = "machine:signer";
      if (kind === "signer") p.signingPrincipals.set("fixture", "human:1");
      if (kind === "authority") p.actors.delete(id(2));
      if (kind === "dual") p.actors.get(id(2))!.principal = "human:1";
      await expect(verify(client, input, p, clock)).rejects.toThrow("APPROVALS_INVALID");
    },
  );
  it("rejects invalid signature and changed evidence", async () => {
    await expect(
      verify(client, { ...input, detachedSignature: "invalid" }, policy(), clock),
    ).rejects.toThrow();
    await expect(
      verify(
        client,
        { ...input, evidence: { ...evidence, targetAfterSha256: sha } },
        policy(),
        clock,
      ),
    ).rejects.toThrow();
  });
  it.each([
    { envelope_sha256: "b".repeat(64) },
    { contract_version: "legacy-pms-owner-evidence.v1" },
    { contract_version: "legacy-owner-internal-setup.v1" },
    { environment: "staging" },
  ])("rejects mismatched stored authority %j", async (change) => {
    const command = {
      ...envelope,
      commandId: id(40),
      migrationApprovalRecordId: id(41),
      securityApprovalRecordId: id(42),
    };
    const payload = canonicalizeJson(command);
    await seed(
      {
        command_id: command.commandId,
        envelope_sha256: hashLegacyHistoricalBindingEnvelope(payload),
        ...change,
      },
      10,
    );
    const signed = {
      ...input,
      canonicalPayload: payload,
      detachedSignature: sign(
        null,
        Buffer.from(`vayada:legacy-historical-binding-transition:v1\0envelope\0${payload}`),
        keys.privateKey,
      ).toString("base64url"),
    };
    await expect(verify(client, signed, policy(), clock)).rejects.toThrow("APPROVALS_INVALID");
  });
  it.each(["none", "records", "revocations"])(
    "restricted role RLS control: %s",
    async (restriction) => {
      await client.query(`CREATE ROLE historical_approval_fixture_role;
      GRANT USAGE ON SCHEMA platform TO historical_approval_fixture_role;
      GRANT SELECT, UPDATE ON ${records} TO historical_approval_fixture_role;
      GRANT SELECT ON ${revocations} TO historical_approval_fixture_role`);
      if (restriction !== "none") {
        await revoke();
        const table = restriction === "records" ? records : revocations;
        await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        CREATE POLICY fixture_hidden ON ${table} TO historical_approval_fixture_role USING (false)`);
      }
      await client.query("SET LOCAL ROLE historical_approval_fixture_role");
      if (restriction === "none") {
        expect(await verify(client, input, policy(), clock)).toEqual({
          outcome: "approvals_locked_requires_eligibility",
          executable: false,
        });
      } else {
        const table = restriction === "records" ? records : revocations;
        expect((await client.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
        await expect(verify(client, input, policy(), clock)).rejects.toThrow("APPROVALS_INVALID");
      }
    },
  );
  it.each(["REPEATABLE READ", "SERIALIZABLE"])("rejects isolation %s", async (isolation) => {
    await client.query(
      `ROLLBACK; BEGIN ISOLATION LEVEL ${isolation}; SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='3s'`,
    );
    await expect(verify(client, input, policy(), clock)).rejects.toThrow();
  });
  it.each(["lock_timeout", "statement_timeout"])("rejects unbounded %s", async (setting) => {
    await client.query(`SET LOCAL ${setting}='0'`);
    await expect(verify(client, input, policy(), clock)).rejects.toThrow();
  });
  it("rejects autocommit and expired authority", async () => {
    await client.query("ROLLBACK");
    await expect(verify(client, input, policy(), clock)).rejects.toThrow();
    await begin();
    await expect(
      verify(client, input, policy(), () => new Date(envelope.expiresAt)),
    ).rejects.toThrow();
  });
  // Last: deliberately commits a revocation in this disposable fixture.
  it("reads revocations afresh after waiting on their FK lock", async () => {
    await begin(other);
    await revoke(other);
    await client.query("SET LOCAL lock_timeout='2s'");
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    const pending = expect(verify(client, input, policy(), clock)).rejects.toThrow();
    let blocked = false;
    for (let attempt = 0; attempt < 50 && !blocked; attempt++) {
      blocked =
        (
          await other.query(
            "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",
            [pid],
          )
        ).rows[0]?.blocked === true;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await other.query("COMMIT");
    await pending;
  });
});
