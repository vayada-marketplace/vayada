import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { planLegacyOwnerEmailIndex } from "./legacyOwnerEmailIndexPlan.js";
import { writeLegacyOwnerSetupCheckpoint } from "./legacyOwnerSetupCheckpoint.js";
import { lockAndCheckLegacyOwnerSetupTargets } from "./legacyOwnerSetupTargetLocks.js";
import { inspectLegacyOwnerSetupReplay } from "./legacyOwnerSetupReplay.js";
import { parseLegacyOwnerSetupCommand } from "./legacyOwnerSetupCommand.js";
import { hashLegacyOwnerSetupEnvelope } from "./legacyOwnerSetupApprovals.js";
import { hashLegacyOwnerSetupValue } from "./legacyOwnerSetupReceiptHashes.js";
import { runMigrations } from "./runner.js";

const url = process.env["VAY2017_CHECKPOINT_TEST_DATABASE_URL"];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = "a".repeat(64),
  now = new Date("2026-09-15T01:05:00.000Z");
const expected = {
  environment: "local" as const,
  targetDatabaseSha256: sha,
  source: {
    sourceRunId: `vay1351-${"a".repeat(24)}`,
    ledgerSha256: sha,
    sourceEnvironment: "local",
    sourceSchemaRevision: "synthetic",
    owners: Array.from({ length: 8 }, (_, i) => ({
      ownerId: id(i + 1),
      hotelId: id(i + 11),
      userOrdinal: i + 1,
      hotelOrdinal: i + 1,
      userSha256: sha,
      hotelSha256: sha,
    })),
  },
};
const command = () => ({
  contractVersion: "legacy-owner-internal-setup.v1",
  commandId: id(99),
  environment: "local",
  issuedAt: "2026-09-15T01:01:00.000Z",
  expiresAt: "2026-09-15T01:15:00.000Z",
  targetDatabaseSha256: sha,
  sourceRunId: expected.source.sourceRunId,
  sourceLedgerSha256: sha,
  owners: expected.source.owners.map((source, i) => ({
    ...source,
    email: `checkpoint${i}@example.invalid`,
    name: null,
    status: "pending",
    expectedTarget: "absent",
    targetBeforeSha256: sha,
    currentEvidenceSha256: sha,
    observedAt: "2026-09-15T01:00:00.000Z",
  })),
});
const audit = { approvalEnvelopeSha256: sha, executorPrincipalSha256: sha };
const signingKeys = generateKeyPairSync("ed25519");
const policy = {
  executionPrincipal: "machine:executor",
  signingPrincipals: new Map([["synthetic", "machine:signer"]]),
  actors: new Map([
    [
      id(90),
      { principal: "human:fixture", authorities: ["migration_owner", "security_owner"] as const },
    ],
  ]),
  singleHumanDualAuthority: { actorUserId: id(90), decisionId: "synthetic-only" },
};
const signedRequest = () => {
  const commandPayload = canonicalizeJson(command());
  const envelopePayload = canonicalizeJson({
    contractVersion: command().contractVersion,
    commandId: command().commandId,
    environment: "local",
    issuedAt: command().issuedAt,
    expiresAt: command().expiresAt,
    commandSha256: parseLegacyOwnerSetupCommand(commandPayload, expected, now).commandSha256,
    migrationApprovalRecordId: id(91),
    securityApprovalRecordId: id(92),
    signingKeyId: "synthetic",
  });
  return {
    commandPayload,
    envelopePayload,
    verificationKeys: new Map([["synthetic", signingKeys.publicKey]]),
    detachedSignature: sign(
      null,
      Buffer.from(`vayada:legacy-owner-internal-setup:v1\0envelope\0${envelopePayload}`),
      signingKeys.privateKey,
    ).toString("base64url"),
  };
};

// Actual storage-stage calls with synthetic input, NOT an approved executor.
describe.skipIf(!url)("atomic pending-owner checkpoint on fresh local PostgreSQL", () => {
  let client: pg.Client, observer: pg.Client;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname !== "127.0.0.1" ||
      !["56624", "56625"].includes(parsed.port) ||
      parsed.pathname !== "/vay2017_checkpoint_test" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Dedicated checkpoint fixture required");
    client = new pg.Client({ connectionString: url });
    observer = new pg.Client({ connectionString: url });
    await client.connect();
    await observer.connect();
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    expect(
      (
        await runMigrations({
          connectionString: url!,
          migrationsDir: join(import.meta.dirname, "../migrations"),
          environment: "local",
        })
      ).failed,
    ).toBeNull();
    await client.query(
      planLegacyOwnerEmailIndex(
        command().owners.map((owner) => createHash("sha256").update(owner.email).digest("hex")),
      ).sql,
    );
  }, 120_000);
  beforeEach(async () => {
    await client.query("BEGIN");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await client.query("ROLLBACK");
  });
  afterAll(async () => {
    await Promise.allSettled([client?.end(), observer?.end()]);
  });
  const write = (value = command()) =>
    writeLegacyOwnerSetupCheckpoint(client, canonicalizeJson(value), expected, audit, now);
  const scope = () =>
    command().owners.map((o) => createHash("sha256").update(o.email).digest("hex"));
  const guard = (value = command(), hashes = scope(), clock = () => now) =>
    lockAndCheckLegacyOwnerSetupTargets(client, canonicalizeJson(value), expected, hashes, clock);
  const configureGuard = () =>
    client.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
  const seedApprovals = async (request: ReturnType<typeof signedRequest>) => {
    await configureGuard();
    await client.query(
      "INSERT INTO identity.users(id,email) VALUES($1,'approver@example.invalid')",
      [id(90)],
    );
    for (const [i, authority] of ["migration_owner", "security_owner"].entries())
      await client.query(
        `INSERT INTO platform.legacy_owner_approval_records
        (approval_record_id,command_id,contract_version,environment,envelope_sha256,authority,actor_user_id,approved_at,expires_at)
        VALUES($1,$2,'legacy-owner-internal-setup.v1','local',$3,$4,$5,$6,$7)`,
        [
          id(91 + i),
          id(99),
          hashLegacyOwnerSetupEnvelope(request.envelopePayload),
          authority,
          id(90),
          command().issuedAt,
          command().expiresAt,
        ],
      );
  };
  const inspect = (request = signedRequest(), clock = () => now) =>
    inspectLegacyOwnerSetupReplay(client, request, expected, policy, clock);
  const prepareReceipt = async () => {
    const request = signedRequest();
    await seedApprovals(request);
    const inspection = await inspect(request);
    await guard();
    await writeLegacyOwnerSetupCheckpoint(
      client,
      request.commandPayload,
      expected,
      inspection.audit,
      now,
    );
    return request;
  };
  const counts = async (connection = client) =>
    (
      await connection.query(`SELECT
    (SELECT count(*)::int FROM identity.users) AS users,
    (SELECT count(*)::int FROM platform.legacy_owner_bootstrap_receipts) AS receipts`)
    ).rows[0];

  it("composes signed approval checks, target guard, checkpoint and exact receipt lookup", async () => {
    const request = signedRequest();
    await seedApprovals(request);
    expect(await inspect(request)).toMatchObject({
      outcome: "no_receipt_requires_evidence_and_target_checks",
      executable: false,
      receipt: null,
    });
    const approvedAudit = {
      approvalEnvelopeSha256: hashLegacyOwnerSetupEnvelope(request.envelopePayload),
      executorPrincipalSha256: hashLegacyOwnerSetupValue(
        "executor-principal",
        policy.executionPrincipal,
      ),
    };
    await guard();
    await writeLegacyOwnerSetupCheckpoint(
      client,
      request.commandPayload,
      expected,
      approvedAudit,
      now,
    );
    expect(await inspect(request)).toMatchObject({
      outcome: "matching_receipt_found",
      executable: false,
      audit: approvedAudit,
      receipt: { commandId: id(99), checkpoint: "internal_users_prepared" },
    });
    expect(await counts()).toEqual({ users: 9, receipts: 1 });
    expect(await counts(observer)).toEqual({ users: 0, receipts: 0 });
  });
  it.each(["signature", "missing", "revoked", "expired", "payload"])(
    "rejects %s before receipt lookup",
    async (mode) => {
      const request = signedRequest();
      if (mode !== "missing") await seedApprovals(request);
      else await configureGuard();
      if (mode === "signature") request.detachedSignature = "invalid";
      if (mode === "payload")
        request.commandPayload = canonicalizeJson({ ...command(), commandId: id(88) });
      if (mode === "revoked")
        await client.query(
          "INSERT INTO platform.legacy_owner_approval_revocations VALUES($1,$2,$3,$4,now())",
          [id(91), id(90), now, sha],
        );
      const spy = vi.spyOn(client, "query");
      await expect(
        inspect(request, () => (mode === "expired" ? new Date(command().expiresAt) : now)),
      ).rejects.toThrow("LEGACY_OWNER_SETUP_REPLAY_INVALID");
      expect(
        spy.mock.calls.some(([sql]) => String(sql).includes("legacy_owner_bootstrap_receipts")),
      ).toBe(false);
    },
  );
  it.each([
    "payload_sha256",
    "source_evidence_sha256",
    "target_before_sha256",
    "target_after_sha256",
    "approval_envelope_sha256",
    "executor_principal_sha256",
  ])("rejects inconsistent receipt %s", async (field) => {
    const request = await prepareReceipt();
    // Synthetic corrupt-storage fixture only; production append-only guard stays unchanged.
    await client.query("ALTER TABLE platform.legacy_owner_bootstrap_receipts DISABLE TRIGGER USER");
    await client.query(`UPDATE platform.legacy_owner_bootstrap_receipts SET ${field}=$1`, [
      "b".repeat(64),
    ]);
    await client.query("ALTER TABLE platform.legacy_owner_bootstrap_receipts ENABLE TRIGGER USER");
    await expect(inspect(request)).rejects.toThrow("LEGACY_OWNER_SETUP_REPLAY_INVALID");
    expect(await counts()).toEqual({ users: 9, receipts: 1 });
  });
  it("rejects expiry after receipt lookup without modifying existing results", async () => {
    const request = await prepareReceipt();
    let calls = 0;
    await expect(
      inspect(request, () => (++calls >= 5 ? new Date(command().expiresAt) : now)),
    ).rejects.toThrow("LEGACY_OWNER_SETUP_REPLAY_INVALID");
    expect(await counts()).toEqual({ users: 9, receipts: 1 });
  });
  it("does not treat RLS-hidden receipts as absent, with a full-visibility control", async () => {
    const request = await prepareReceipt();
    await client.query(`CREATE ROLE vay2017_replay_reader NOLOGIN;
      GRANT USAGE ON SCHEMA platform TO vay2017_replay_reader;
      GRANT SELECT, UPDATE ON platform.legacy_owner_approval_records TO vay2017_replay_reader;
      GRANT SELECT ON platform.legacy_owner_approval_revocations, platform.legacy_owner_bootstrap_receipts TO vay2017_replay_reader;
      SET LOCAL ROLE vay2017_replay_reader`);
    expect(await inspect(request)).toMatchObject({ outcome: "matching_receipt_found" });
    await client.query(
      "RESET ROLE; ALTER TABLE platform.legacy_owner_bootstrap_receipts ENABLE ROW LEVEL SECURITY; SET LOCAL ROLE vay2017_replay_reader",
    );
    await expect(inspect(request)).rejects.toThrow("LEGACY_OWNER_SETUP_REPLAY_INVALID");
    await client.query("RESET ROLE");
    expect(await counts()).toEqual({ users: 9, receipts: 1 });
  });

  it("writes exact pending users and one receipt, invisible outside until commit", async () => {
    expect(await write()).toEqual({ outcome: "checkpoint_written_uncommitted", commandId: id(99) });
    expect(await counts()).toEqual({ users: 8, receipts: 1 });
    expect(await counts(observer)).toEqual({ users: 0, receipts: 0 });
    const users = (
      await client.query(
        "SELECT id,email,name,status,created_at,updated_at FROM identity.users ORDER BY id",
      )
    ).rows;
    for (const [i, user] of users.entries())
      expect(user).toEqual({
        id: id(i + 1),
        email: command().owners[i]!.email,
        name: null,
        status: "pending",
        created_at: new Date(command().issuedAt),
        updated_at: new Date(command().issuedAt),
      });
    const receipt = (
      await client.query(
        "SELECT owner_user_ids,checkpoint,target_after_sha256 FROM platform.legacy_owner_bootstrap_receipts",
      )
    ).rows[0];
    expect(receipt.owner_user_ids).toEqual(expected.source.owners.map((o) => o.ownerId));
    expect(receipt.checkpoint).toBe("internal_users_prepared");
    expect(receipt.target_after_sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const table of [
      "identity.organizations",
      "identity.organization_memberships",
      "identity.external_identities",
    ])
      expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    await client.query("ROLLBACK");
    expect(await counts(observer)).toEqual({ users: 0, receipts: 0 });
  });
  it("composes the absence guard and atomic checkpoint in one transaction", async () => {
    await configureGuard();
    expect(await guard()).toEqual({
      outcome: "targets_absent_locked_requires_authorized_write",
      executable: false,
    });
    await write();
    expect(await counts()).toEqual({ users: 8, receipts: 1 });
    expect(await counts(observer)).toEqual({ users: 0, receipts: 0 });
  });
  it.each(["owner ID", "normalized email", "external email"])(
    "rejects existing %s without overwriting",
    async (kind) => {
      await configureGuard();
      await client.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'suspended')", [
        kind === "owner ID" ? id(1) : id(80),
        kind === "normalized email"
          ? `\u00a0${command().owners[0]!.email.toUpperCase()}\t`
          : "unrelated@example.invalid",
      ]);
      if (kind === "external email")
        await client.query(
          "INSERT INTO identity.external_identities(user_id,provider,provider_email) VALUES($1,'workos',$2)",
          [id(80), ` ${command().owners[0]!.email.toUpperCase()} `],
        );
      await expect(guard()).rejects.toThrow("LEGACY_OWNER_SETUP_TARGET_LOCKS_INVALID");
      expect(await counts()).toEqual({ users: 1, receipts: 0 });
    },
  );
  it.each([
    "missing index",
    "wrong scope",
    "collation drift",
    "expired after wait",
    "normalized duplicate",
    "unbounded transaction",
  ])("rejects %s", async (mode) => {
    if (mode !== "unbounded transaction") await configureGuard();
    if (mode === "missing index")
      await client.query(`DROP INDEX identity.${planLegacyOwnerEmailIndex(scope()).indexName}`);
    if (mode === "collation drift")
      await client.query(
        'ALTER TABLE identity.external_identities ALTER COLUMN provider_email TYPE text COLLATE "C"',
      );
    const value = command();
    if (mode === "normalized duplicate")
      value.owners[1]!.email = value.owners[0]!.email.toUpperCase();
    let calls = 0;
    await expect(
      guard(value, mode === "wrong scope" ? scope().map(() => sha) : scope(), () =>
        mode === "expired after wait" && calls++ > 0 ? new Date("2026-09-15T01:16:00.000Z") : now,
      ),
    ).rejects.toThrow("LEGACY_OWNER_SETUP_TARGET_LOCKS_INVALID");
    expect(await counts()).toEqual({ users: 0, receipts: 0 });
  });
  it("requires an explicit transaction", async () => {
    await client.query("ROLLBACK");
    await expect(guard()).rejects.toThrow("LEGACY_OWNER_SETUP_TARGET_LOCKS_INVALID");
    expect(await counts()).toEqual({ users: 0, receipts: 0 });
  });
  it.each(["users", "external_identities", "none"])("checks RLS visibility: %s", async (table) => {
    await configureGuard();
    await client.query(`CREATE ROLE vay2017_target_reader NOLOGIN;
      GRANT USAGE ON SCHEMA identity TO vay2017_target_reader;
      GRANT SELECT, UPDATE ON identity.users, identity.external_identities TO vay2017_target_reader`);
    if (table !== "none")
      await client.query(`ALTER TABLE identity.${table} ENABLE ROW LEVEL SECURITY`);
    await client.query("SET LOCAL ROLE vay2017_target_reader");
    if (table === "none") await expect(guard()).resolves.toHaveProperty("executable", false);
    else await expect(guard()).rejects.toThrow("LEGACY_OWNER_SETUP_TARGET_LOCKS_INVALID");
  });
  it("backs off and releases partial locks so an ordinary user-first identity write can finish", async () => {
    await configureGuard();
    await observer.query(
      "BEGIN; SET LOCAL lock_timeout = '500ms'; SET LOCAL statement_timeout = '1s'",
    );
    await observer.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'pending')", [
      id(80),
      command().owners[0]!.email,
    ]);
    try {
      await expect(guard()).rejects.toThrow("LEGACY_OWNER_SETUP_TARGET_LOCKS_INVALID");
      // Guard's outer transaction remains open: partial locks must already be gone.
      await observer.query(
        "INSERT INTO identity.external_identities(user_id,provider) VALUES($1,'workos')",
        [id(80)],
      );
      await observer.query("COMMIT");
      await expect(guard()).rejects.toThrow("LEGACY_OWNER_SETUP_TARGET_LOCKS_INVALID");
      expect(await counts()).toEqual({ users: 1, receipts: 0 });
    } finally {
      await observer.query("ROLLBACK");
      await client.query("ROLLBACK");
      await observer.query("DELETE FROM identity.external_identities WHERE user_id=$1", [id(80)]);
      await observer.query("DELETE FROM identity.users WHERE id=$1", [id(80)]);
    }
  });
  it.each(["users", "external_identities"])(
    "retains %s locks through the checkpoint until outer rollback",
    async (table) => {
      await configureGuard();
      await guard();
      await write();
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const observerPid = (await observer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await observer.query(
        "BEGIN; SET LOCAL lock_timeout = '3s'; SET LOCAL statement_timeout = '4s'",
      );
      const waiting = observer.query(`LOCK TABLE identity.${table} IN ROW EXCLUSIVE MODE`).then(
        () => true,
        () => false,
      );
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          blocked = (
            await client.query("SELECT $1::int = ANY(pg_blocking_pids($2)) AS blocked", [
              pid,
              observerPid,
            ])
          ).rows[0].blocked;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await client.query("ROLLBACK");
        expect(await waiting).toBe(true);
      } finally {
        await client.query("ROLLBACK");
        await waiting;
        await observer.query("ROLLBACK");
      }
      expect(await counts()).toEqual({ users: 0, receipts: 0 });
    },
  );
  it.each(["id", "email"])("does not overwrite an existing %s conflict", async (kind) => {
    await client.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'suspended')", [
      kind === "id" ? id(8) : id(80),
      command().owners[7]!.email,
    ]);
    await expect(write()).rejects.toThrow(/^LEGACY_OWNER_SETUP_CHECKPOINT_FAILED$/);
    expect(await counts()).toEqual({ users: 1, receipts: 0 });
    expect((await client.query("SELECT status FROM identity.users")).rows[0].status).toBe(
      "suspended",
    );
  });
  it.each(["skip", "alter", "receipt failure", "receipt drift"])(
    "rolls back every inserted account on %s",
    async (mode) => {
      const table = mode.startsWith("receipt")
        ? "platform.legacy_owner_bootstrap_receipts"
        : "identity.users";
      const body =
        mode === "skip"
          ? "RETURN NULL;"
          : mode === "alter"
            ? "NEW.status := 'active'; RETURN NEW;"
            : mode === "receipt drift"
              ? "NEW.owner_user_ids := NEW.owner_user_ids[1:1]; RETURN NEW;"
              : "RAISE EXCEPTION 'synthetic receipt failure';";
      await client.query(
        `CREATE FUNCTION public.checkpoint_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`,
      );
      await client.query(
        `CREATE TRIGGER checkpoint_fixture BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.checkpoint_fixture()`,
      );
      await expect(write()).rejects.toThrow(/^LEGACY_OWNER_SETUP_CHECKPOINT_FAILED$/);
      expect(await counts()).toEqual({ users: 0, receipts: 0 });
    },
  );
  it("rejects duplicate invocation without treating rows as replay evidence", async () => {
    await write();
    await expect(write()).rejects.toThrow(/^LEGACY_OWNER_SETUP_CHECKPOINT_FAILED$/);
    expect(await counts()).toEqual({ users: 8, receipts: 1 });
  });
  it("rolls back new rows when the command receipt already exists", async () => {
    const first = command();
    first.owners = [first.owners[0]!];
    await write(first);
    const drift = command();
    drift.owners = [drift.owners[1]!];
    await expect(write(drift)).rejects.toThrow(/^LEGACY_OWNER_SETUP_CHECKPOINT_FAILED$/);
    expect(await counts()).toEqual({ users: 1, receipts: 1 });
    expect((await client.query("SELECT id FROM identity.users")).rows[0].id).toBe(id(1));
  });
  it("rejects autocommit before any row write", async () => {
    await client.query("ROLLBACK");
    await expect(write()).rejects.toThrow(/^LEGACY_OWNER_SETUP_CHECKPOINT_FAILED$/);
    expect(await counts()).toEqual({ users: 0, receipts: 0 });
  });
  it("fingerprints actual returned rows independently of session timezone", async () => {
    const hashes: string[] = [];
    for (const zone of ["UTC", "Asia/Taipei"]) {
      await client.query("SAVEPOINT timezone_test");
      await client.query("SELECT set_config('TimeZone',$1,true)", [zone]);
      await write();
      hashes.push(
        (
          await client.query(
            "SELECT target_after_sha256 FROM platform.legacy_owner_bootstrap_receipts",
          )
        ).rows[0].target_after_sha256,
      );
      await client.query("ROLLBACK TO SAVEPOINT timezone_test");
    }
    expect(hashes[0]).toBe(hashes[1]);
  });
  it("rejects invalid audit inputs and active-user intent", async () => {
    await expect(
      writeLegacyOwnerSetupCheckpoint(
        client,
        canonicalizeJson(command()),
        expected,
        { ...audit, approvalEnvelopeSha256: "bad" },
        now,
      ),
    ).rejects.toThrow(/^LEGACY_OWNER_SETUP_CHECKPOINT_FAILED$/);
    const invalid = command();
    invalid.owners[0]!.status = "active";
    await expect(write(invalid)).rejects.toThrow(/^LEGACY_OWNER_SETUP_CHECKPOINT_FAILED$/);
    expect(await counts()).toEqual({ users: 0, receipts: 0 });
  });
  // Last: committed synthetic state remains only in this disposable database.
  it("serializes same-command callers and returns the first committed receipt to the waiter", async () => {
    const request = signedRequest();
    await seedApprovals(request);
    await client.query("COMMIT; BEGIN");
    await configureGuard();
    const first = await inspect(request);
    const holder = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const waiter = (await observer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await observer.query(
      "BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '6s'",
    );
    const pending = inspectLegacyOwnerSetupReplay(
      observer,
      request,
      expected,
      policy,
      () => now,
    ).then(
      (result) => result.outcome,
      (error: Error) => error.message,
    );
    try {
      await expect
        .poll(
          async () =>
            (
              await client.query("SELECT $1::int = ANY(pg_blocking_pids($2)) AS blocked", [
                holder,
                waiter,
              ])
            ).rows[0].blocked,
          { timeout: 2_000 },
        )
        .toBe(true);
      await guard();
      await writeLegacyOwnerSetupCheckpoint(
        client,
        request.commandPayload,
        expected,
        first.audit,
        now,
      );
      await client.query("COMMIT");
      expect(await pending).toBe("matching_receipt_found");
      expect(await counts()).toEqual({ users: 9, receipts: 1 });
    } finally {
      await client.query("ROLLBACK");
      await pending;
      await observer.query("ROLLBACK");
    }
  });
});
