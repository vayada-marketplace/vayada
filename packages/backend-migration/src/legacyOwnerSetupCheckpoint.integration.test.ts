import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { planLegacyOwnerEmailIndex } from "./legacyOwnerEmailIndexPlan.js";
import { writeLegacyOwnerSetupCheckpoint } from "./legacyOwnerSetupCheckpoint.js";
import { lockAndCheckLegacyOwnerSetupTargets } from "./legacyOwnerSetupTargetLocks.js";
import { inspectLegacyOwnerSetupReplay } from "./legacyOwnerSetupReplay.js";
import { prepareLegacyOwnerSetupTransaction } from "./legacyOwnerSetupTransaction.js";
import { prepareLegacyOwnerSetupVerifiedTargetTransaction } from "./legacyOwnerSetupVerifiedTargetTransaction.js";
import type { LegacyOwnerSetupTargetIdentity } from "./legacyOwnerSetupTargetIdentity.js";
import { verifyLegacyOwnerTargetAbsence } from "./legacyOwnerTargetAbsence.js";
import { parseLegacyOwnerSetupCommand } from "./legacyOwnerSetupCommand.js";
import { hashLegacyOwnerSetupEnvelope } from "./legacyOwnerSetupApprovals.js";
import { hashLegacyOwnerSetupValue } from "./legacyOwnerSetupReceiptHashes.js";
import { runMigrations } from "./runner.js";
import { collectLegacyOwnerCurrentSourceEvidence } from "./legacyOwnerCurrentSourceCollector.js";
import { inspectLegacyOwnerSetupRecovery } from "./legacyOwnerSetupRecovery.js";
import { commitLegacyOwnerSetup } from "./legacyOwnerSetupCommit.js";
import { verifyLegacyOwnerCurrentSourceEvidence } from "./legacyOwnerCurrentSourceEvidence.js";

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
  targetDatabaseSha256: expected.targetDatabaseSha256,
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
const signedRequest = (value = command()) => {
  const commandPayload = canonicalizeJson(value);
  const envelopePayload = canonicalizeJson({
    contractVersion: value.contractVersion,
    commandId: value.commandId,
    environment: "local",
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
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
const sourceKeys = generateKeyPairSync("ed25519");
const transactionFixture = (alter?: (row: Record<string, unknown>, i: number) => void) => {
  const value = command();
  const emailHashes = value.owners.map((o) => createHash("sha256").update(o.email).digest("hex"));
  const targetArtifacts = value.owners.map((owner, i) => {
    const row = {
      contractVersion: "legacy-owner-target-absence.v1",
      normalizationVersion: "legacy-owner-email-index.v1",
      environment: value.environment,
      targetDatabaseSha256: value.targetDatabaseSha256,
      ownerId: owner.ownerId,
      normalizedEmailSha256: emailHashes[i],
      emailScopeSha256: planLegacyOwnerEmailIndex(emailHashes).scopeSha256,
      observedAt: owner.observedAt,
      userIdPresent: false,
      userEmailPresent: false,
      externalUserIdPresent: false,
      externalEmailPresent: false,
    };
    alter?.(row, i);
    owner.targetBeforeSha256 = hashLegacyOwnerSetupValue("target-absence-evidence", row);
    return canonicalizeJson(row);
  });
  const artifacts = value.owners.map((owner) => {
    const row = {
      contractVersion: "legacy-owner-current-source.v1",
      environment: "local",
      sourceRunId: value.sourceRunId,
      sourceLedgerSha256: value.sourceLedgerSha256,
      ownerId: owner.ownerId,
      hotelId: owner.hotelId,
      authDatabaseSha256: sha,
      pmsDatabaseSha256: sha,
      authObservedAt: owner.observedAt,
      pmsObservedAt: owner.observedAt,
      sourceStatus: "pending",
      email: owner.email,
      name: owner.name,
      signingKeyId: "source-fixture",
    };
    owner.currentEvidenceSha256 = hashLegacyOwnerSetupValue("current-source-evidence", row);
    const canonicalPayload = canonicalizeJson(row);
    return {
      canonicalPayload,
      detachedSignature: sign(
        null,
        Buffer.from(
          `vayada:legacy-owner-internal-setup:v1\0current-source-attestation\0${canonicalPayload}`,
        ),
        sourceKeys.privateKey,
      ).toString("base64url"),
    };
  });
  return {
    request: signedRequest(value),
    targetArtifacts,
    artifacts,
    trust: {
      environment: "local",
      authDatabaseSha256: sha,
      pmsDatabaseSha256: sha,
      verificationKeys: new Map([["source-fixture", sourceKeys.publicKey]]),
    },
  };
};

const verifiedUrl = process.env.VAY2017_VERIFIED_TARGET_TEST_DATABASE_URL;
const recoveryUrl = process.env.VAY2017_RECOVERY_TEST_DATABASE_URL;
const commitUrl = process.env.VAY2017_COMMIT_TEST_DATABASE_URL;
const fixtureUrl = verifiedUrl ?? recoveryUrl ?? commitUrl;
describe.skipIf(!fixtureUrl)("same-client verified target transaction as restricted LOGIN", () => {
  let admin: pg.Client, executor: pg.Client, identity: LegacyOwnerSetupTargetIdentity;
  let executorConfig: pg.ClientConfig, recoveryPool: pg.Pool | undefined;
  let fixture: ReturnType<typeof transactionFixture>;
  const sourceAdmins: pg.Client[] = [],
    sourcePools: pg.Pool[] = [];
  let collectSources: () => ReturnType<typeof collectLegacyOwnerCurrentSourceEvidence>;
  const hashes = () =>
    command().owners.map((o) => createHash("sha256").update(o.email).digest("hex"));
  beforeAll(async () => {
    const parsed = new URL(fixtureUrl!);
    if (
      [verifiedUrl, recoveryUrl, commitUrl].filter(Boolean).length !== 1 ||
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname !== "127.0.0.1" ||
      !(
        commitUrl ? ["56644", "56645"] : recoveryUrl ? ["56636", "56637"] : ["56634", "56635"]
      ).includes(parsed.port) ||
      parsed.pathname !==
        (commitUrl
          ? "/vay2017_commit_test"
          : recoveryUrl
            ? "/vay2017_recovery_test"
            : "/vay2017_verified_target_test") ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Dedicated verified target fixture required");
    admin = new pg.Client({ connectionString: fixtureUrl });
    await admin.connect();
    expect(
      (await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    expect(
      (
        await runMigrations({
          connectionString: fixtureUrl!,
          migrationsDir: join(import.meta.dirname, "../migrations"),
          environment: "local",
        })
      ).failed,
    ).toBeNull();
    await admin.query(planLegacyOwnerEmailIndex(hashes()).sql);
    await admin.query(`CREATE ROLE vayada_migration_attestor NOLOGIN;
      CREATE ROLE vay2017_setup_executor LOGIN;
      CREATE SCHEMA vayada_migration_evidence AUTHORIZATION vayada_migration_attestor;
      SET ROLE vayada_migration_attestor;
      CREATE TABLE vayada_migration_evidence.database_attestations (
        attestation_key text PRIMARY KEY, attestation_value text NOT NULL,
        attested_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO vayada_migration_evidence.database_attestations VALUES
        ('vayada.target_environment','local',now()),
        ('vayada.target_identity_sha256',repeat('a',64),now());
      GRANT USAGE ON SCHEMA vayada_migration_evidence TO vay2017_setup_executor;
      GRANT SELECT ON vayada_migration_evidence.database_attestations TO vay2017_setup_executor;
      RESET ROLE;
      GRANT USAGE ON SCHEMA identity,platform TO vay2017_setup_executor;
      GRANT SELECT,INSERT,UPDATE ON identity.users TO vay2017_setup_executor;
      GRANT SELECT,UPDATE ON identity.external_identities TO vay2017_setup_executor;
      GRANT SELECT ON identity.organizations,identity.organization_memberships TO vay2017_setup_executor;
      GRANT SELECT,UPDATE ON platform.legacy_owner_approval_records TO vay2017_setup_executor;
      GRANT SELECT ON platform.legacy_owner_approval_revocations TO vay2017_setup_executor;
      GRANT SELECT,INSERT ON platform.legacy_owner_bootstrap_receipts TO vay2017_setup_executor`);
    const row = (
      await admin.query(
        "SELECT current_database() AS name, oid::int FROM pg_database WHERE datname=current_database()",
      )
    ).rows[0];
    identity = {
      contractVersion: "legacy-owner-setup-target-identity.v1",
      environment: "local",
      targetIdentitySha256: sha,
      databaseName: row.name,
      databaseOid: row.oid,
    };
    expected.targetDatabaseSha256 = hashLegacyOwnerSetupValue("target-database-identity", identity);
    fixture = transactionFixture();
    // Separate synthetic source databases; no target executor can read source contacts.
    const pins: { databaseName: string; databaseOid: number }[] = [];
    for (const kind of ["auth", "pms"] as const) {
      const sourceUrl = new URL(fixtureUrl!);
      sourceUrl.pathname = `/vay2017_pipeline_${kind}`;
      const sourceAdmin = new pg.Client({ connectionString: sourceUrl.toString() });
      sourceAdmins.push(sourceAdmin);
      await sourceAdmin.connect();
      if (kind === "auth") {
        await sourceAdmin.query(`CREATE ROLE vay2017_pipeline_reader LOGIN;
          CREATE TABLE public.users(id uuid PRIMARY KEY,email text,name text,type text,status text);
          GRANT SELECT(id,email,name,type,status) ON public.users TO vay2017_pipeline_reader`);
        for (const owner of command().owners)
          await sourceAdmin.query("INSERT INTO public.users VALUES($1,$2,$3,'hotel','pending')", [
            owner.ownerId,
            owner.email,
            owner.name,
          ]);
      } else {
        await sourceAdmin.query(`CREATE TABLE public.hotels(id uuid PRIMARY KEY,user_id uuid);
          GRANT SELECT(id,user_id) ON public.hotels TO vay2017_pipeline_reader`);
        for (const owner of command().owners)
          await sourceAdmin.query("INSERT INTO public.hotels VALUES($1,$2)", [
            owner.hotelId,
            owner.ownerId,
          ]);
      }
      pins.push(
        (
          await sourceAdmin.query(`SELECT current_database() AS "databaseName",
        oid::int AS "databaseOid" FROM pg_database WHERE datname=current_database()`)
        ).rows[0],
      );
      sourceUrl.username = "vay2017_pipeline_reader";
      sourceUrl.password = "";
      sourcePools.push(
        new pg.Pool({
          connectionString: sourceUrl.toString(),
          max: 1,
          connectionTimeoutMillis: 2000,
        }),
      );
    }
    collectSources = () =>
      collectLegacyOwnerCurrentSourceEvidence(
        sourcePools[0]!,
        sourcePools[1]!,
        {
          pairs: expected.source.owners.map(({ ownerId, hotelId }) => ({ ownerId, hotelId })),
          auth: pins[0]!,
          pms: pins[1]!,
        },
        {
          environment: "local",
          sourceRunId: expected.source.sourceRunId,
          sourceLedgerSha256: sha,
          authDatabaseSha256: sha,
          pmsDatabaseSha256: sha,
          signingKeyId: "source-fixture",
        },
        sourceKeys,
        () => new Date(command().owners[0]!.observedAt),
      );
    const collected = await collectSources();
    // These bytes now originate in actual SELECTs, not the fixture's constructed rows.
    expect(collected).toEqual(fixture.artifacts);
    fixture.artifacts = collected;
    await admin.query(
      "INSERT INTO identity.users(id,email) VALUES($1,'approver@example.invalid')",
      [id(90)],
    );
    for (const [i, authority] of ["migration_owner", "security_owner"].entries())
      await admin.query(
        `INSERT INTO platform.legacy_owner_approval_records
        (approval_record_id,command_id,contract_version,environment,envelope_sha256,authority,actor_user_id,approved_at,expires_at)
        VALUES($1,$2,'legacy-owner-internal-setup.v1','local',$3,$4,$5,$6,$7)`,
        [
          id(91 + i),
          id(99),
          hashLegacyOwnerSetupEnvelope(fixture.request.envelopePayload),
          authority,
          id(90),
          command().issuedAt,
          command().expiresAt,
        ],
      );
    parsed.username = "vay2017_setup_executor";
    executorConfig = { connectionString: parsed.toString(), connectionTimeoutMillis: 2000 };
    executor = new pg.Client(executorConfig);
    await executor.connect();
    if (recoveryUrl || commitUrl) recoveryPool = new pg.Pool({ ...executorConfig, max: 1 });
  }, 120_000);
  beforeEach(async () => {
    await executor.query("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await executor.query("ROLLBACK");
  });
  afterAll(async () => {
    await recoveryPool?.end();
    await Promise.allSettled(sourcePools.map((pool) => pool.end()));
    await Promise.allSettled(sourceAdmins.map((client) => client.end()));
    await executor?.end();
    await admin?.end();
    expected.targetDatabaseSha256 = sha;
  });
  const prepare = (
    artifact: unknown = identity,
    chosen = fixture,
    context = expected,
    clock = () => now,
  ) =>
    prepareLegacyOwnerSetupVerifiedTargetTransaction(
      artifact,
      executor,
      chosen.request,
      context,
      chosen.artifacts,
      chosen.trust,
      policy,
      hashes(),
      chosen.targetArtifacts,
      clock,
    );
  const counts = async () =>
    (
      await executor.query(`SELECT
      (SELECT count(*)::int FROM identity.users WHERE id<> '${id(90)}') AS owners,
      (SELECT count(*)::int FROM platform.legacy_owner_bootstrap_receipts) AS receipts`)
    ).rows[0];
  if (commitUrl) {
    it("owns commit, rolls back pre-dispatch failures and never retries uncertain acknowledgement", async () => {
      const writerPool = new pg.Pool({ ...executorConfig, max: 1 });
      let expired = false;
      const run = (chosen = fixture, target: unknown = identity) =>
        commitLegacyOwnerSetup(
          writerPool,
          target,
          chosen.request,
          expected,
          chosen.artifacts,
          chosen.trust,
          policy,
          hashes(),
          chosen.targetArtifacts,
          () => (expired ? new Date(command().expiresAt) : now),
        );
      const fault = async (mode: "expiry" | "rollback-tag" | "lost-ack" | "cleanup") => {
        const client = await writerPool.connect(),
          query = client.query.bind(client);
        vi.spyOn(writerPool, "connect").mockImplementationOnce(
          (async () => client) as pg.Pool["connect"],
        );
        let rollbacks = 0;
        vi.spyOn(client, "query").mockImplementation((async (sql: string, values?: unknown[]) => {
          if (mode === "cleanup" && sql === "ROLLBACK" && ++rollbacks === 2)
            throw Error("private cleanup");
          if (sql === "COMMIT" && mode === "rollback-tag") return query("ROLLBACK");
          const result = await query(sql, values);
          if (sql === "RELEASE SAVEPOINT vay2017_verified_target" && mode === "expiry")
            expired = true;
          if (sql === "COMMIT" && mode === "lost-ack") throw Error("private lost acknowledgement");
          return result;
        }) as typeof client.query);
        return vi.spyOn(client, "release");
      };
      try {
        await expect(run(fixture, { ...identity, databaseOid: 1 })).rejects.toThrow(
          /^LEGACY_OWNER_SETUP_NOT_COMMITTED$/,
        );
        expect(await counts()).toEqual({ owners: 0, receipts: 0 });
        let released = await fault("expiry");
        await expect(run()).rejects.toThrow(/^LEGACY_OWNER_SETUP_NOT_COMMITTED$/);
        expect(released).toHaveBeenCalledWith(true);
        expired = false;
        vi.restoreAllMocks();
        expect(await counts()).toEqual({ owners: 0, receipts: 0 });
        released = await fault("cleanup");
        await expect(run(fixture, { ...identity, databaseOid: 1 })).rejects.toThrow(
          /^LEGACY_OWNER_SETUP_NOT_COMMITTED$/,
        );
        expect(released).toHaveBeenCalledWith(true);
        vi.restoreAllMocks();
        released = await fault("rollback-tag");
        await expect(run()).rejects.toThrow(/^LEGACY_OWNER_SETUP_COMMIT_INDETERMINATE$/);
        expect(released).toHaveBeenCalledWith(true);
        vi.restoreAllMocks();
        expect(await counts()).toEqual({ owners: 0, receipts: 0 });
        const copied = {
          ...fixture,
          request: {
            ...fixture.request,
            verificationKeys: new Map(fixture.request.verificationKeys),
          },
          artifacts: structuredClone(fixture.artifacts),
        };
        const captured = await writerPool.connect();
        vi.spyOn(writerPool, "connect").mockImplementationOnce((async () => {
          copied.request.verificationKeys.clear();
          copied.artifacts.length = 0;
          return captured;
        }) as pg.Pool["connect"]);
        expect(await run(copied)).toMatchObject({
          outcome: "commit_acknowledged",
          executable: false,
        });
        vi.restoreAllMocks();
        expect(await counts()).toEqual({ owners: 8, receipts: 1 });
        released = await fault("lost-ack");
        await expect(run()).rejects.toThrow(/^LEGACY_OWNER_SETUP_COMMIT_INDETERMINATE$/);
        expect(released).toHaveBeenCalledWith(true);
        vi.restoreAllMocks();
        expect(
          await inspectLegacyOwnerSetupRecovery(
            recoveryPool!,
            identity,
            fixture.request,
            expected,
            fixture.artifacts,
            fixture.trust,
            policy,
            () => now,
          ),
        ).toHaveProperty("outcome", "matching_receipt_found");
        expect(await counts()).toEqual({ owners: 8, receipts: 1 });
        for (const table of ["organizations", "organization_memberships", "external_identities"])
          expect(
            (await executor.query(`SELECT count(*)::int n FROM identity.${table}`)).rows[0].n,
          ).toBe(0);
        expect(
          (
            await executor.query("SELECT DISTINCT status FROM identity.users WHERE id<>$1", [
              id(90),
            ])
          ).rows,
        ).toEqual([{ status: "pending" }]);
      } finally {
        vi.restoreAllMocks();
        await writerPool.end();
      }
    }, 20_000);
    return;
  }
  if (recoveryUrl) {
    it("recovers only durable exact receipts after an indeterminate commit, never retries writes", async () => {
      const recover = (chosen = fixture, target: unknown = identity, clock = () => now) =>
        inspectLegacyOwnerSetupRecovery(
          recoveryPool!,
          target,
          chosen.request,
          expected,
          chosen.artifacts,
          chosen.trust,
          policy,
          clock,
        );
      expect(await recover()).toEqual({
        outcome: "no_receipt_observed",
        executable: false,
        receipt: null,
      });
      expect(await counts()).toEqual({ owners: 0, receipts: 0 });
      await prepare();
      // Original approval locks are still held: recovery cannot report absence yet.
      await expect(recover()).rejects.toThrow("LEGACY_OWNER_SETUP_RECOVERY_FAILED");
      expect(await counts()).toEqual({ owners: 8, receipts: 1 });
      await executor.end(); // Real disconnect before COMMIT rolls back the first attempt.
      executor = new pg.Client(executorConfig);
      await executor.connect();
      expect(await recover()).toHaveProperty("outcome", "no_receipt_observed");
      expect(await counts()).toEqual({ owners: 0, receipts: 0 });
      await executor.query(
        "BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL synchronous_commit='on'",
      );
      await prepare();
      verifyLegacyOwnerCurrentSourceEvidence(
        fixture.request,
        expected,
        fixture.artifacts,
        fixture.trust,
        now,
      );
      // Real database commit, synthetic lost acknowledgement (not a network proxy).
      await expect(
        (async () => {
          await executor.query("COMMIT");
          throw new Error("synthetic lost acknowledgement");
        })(),
      ).rejects.toThrow("synthetic lost acknowledgement");
      await executor.end();
      executor = new pg.Client(executorConfig);
      await executor.connect();
      const recovered = await recover();
      expect(recovered).toMatchObject({
        outcome: "matching_receipt_found",
        executable: false,
        receipt: { commandId: id(99), checkpoint: "internal_users_prepared" },
      });
      expect(await recover()).toEqual(recovered);
      expect(await counts()).toEqual({ owners: 8, receipts: 1 });
      const copied = {
        ...fixture,
        request: {
          ...fixture.request,
          verificationKeys: new Map(fixture.request.verificationKeys),
        },
        artifacts: structuredClone(fixture.artifacts),
      };
      const capturedClient = await recoveryPool!.connect();
      vi.spyOn(recoveryPool!, "connect").mockImplementationOnce((async () => {
        copied.request.detachedSignature = "changed during acquisition";
        copied.request.verificationKeys.clear();
        copied.artifacts.length = 0;
        return capturedClient;
      }) as pg.Pool["connect"]);
      expect(await recover(copied)).toEqual(recovered);
      vi.restoreAllMocks();
      const failedClient = await recoveryPool!.connect();
      const query = failedClient.query.bind(failedClient);
      let rollbacks = 0;
      vi.spyOn(recoveryPool!, "connect").mockImplementationOnce(
        (async () => failedClient) as pg.Pool["connect"],
      );
      vi.spyOn(failedClient, "query").mockImplementation((async (
        sql: string,
        values?: unknown[],
      ) => {
        if (sql === "ROLLBACK" && ++rollbacks === 2)
          throw new Error("synthetic private cleanup detail");
        return query(sql, values);
      }) as typeof failedClient.query);
      const release = vi.spyOn(failedClient, "release");
      await expect(recover()).rejects.toThrow(/^LEGACY_OWNER_SETUP_RECOVERY_FAILED$/);
      expect(release).toHaveBeenCalledWith(true);
      vi.restoreAllMocks();
      expect(await recover()).toEqual(recovered);
      expect(
        (await executor.query("SELECT DISTINCT status FROM identity.users WHERE id<>$1", [id(90)]))
          .rows,
      ).toEqual([{ status: "pending" }]);
      for (const table of ["organizations", "organization_memberships", "external_identities"])
        expect(
          (await executor.query(`SELECT count(*)::int n FROM identity.${table}`)).rows[0].n,
        ).toBe(0);
      await expect(
        recover(fixture, { ...identity, databaseOid: identity.databaseOid + 1 }),
      ).rejects.toThrow("LEGACY_OWNER_SETUP_RECOVERY_FAILED");
      await expect(recover(fixture, identity, () => new Date(command().expiresAt))).rejects.toThrow(
        "LEGACY_OWNER_SETUP_RECOVERY_FAILED",
      );
      const changed = transactionFixture();
      changed.request.detachedSignature = "invalid";
      await expect(recover(changed)).rejects.toThrow("LEGACY_OWNER_SETUP_RECOVERY_FAILED");
      await admin.query(
        `INSERT INTO platform.legacy_owner_approval_revocations
        (approval_record_id,revoked_by_user_id,revoked_at,reason_sha256) VALUES($1,$2,$3,$4)`,
        [id(91), id(90), now, sha],
      );
      await expect(recover()).rejects.toThrow("LEGACY_OWNER_SETUP_RECOVERY_FAILED");
      expect(await counts()).toEqual({ owners: 8, receipts: 1 });
    }, 15_000);
    return;
  }
  it("rereads both sources, prepares eight pending users, rolls back and retries without duplication", async () => {
    const fromReads = { ...fixture, artifacts: await collectSources() };
    expect(await prepare(identity, fromReads)).toHaveProperty(
      "outcome",
      "checkpoint_written_uncommitted",
    );
    expect(await counts()).toEqual({ owners: 8, receipts: 1 });
    await executor.query("ROLLBACK");
    expect(await counts()).toEqual({ owners: 0, receipts: 0 });
    await executor.query("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
    expect(await prepare(identity, fromReads)).toHaveProperty(
      "outcome",
      "checkpoint_written_uncommitted",
    );
    expect(await prepare(identity, fromReads)).toHaveProperty("outcome", "matching_receipt_found");
    expect(await counts()).toEqual({ owners: 8, receipts: 1 });
    expect(
      (await admin.query("SELECT count(*)::int n FROM platform.legacy_owner_bootstrap_receipts"))
        .rows[0].n,
    ).toBe(0);
    for (const table of ["organizations", "organization_memberships", "external_identities"])
      expect(
        (await executor.query(`SELECT count(*)::int n FROM identity.${table}`)).rows[0].n,
      ).toBe(0);
  });
  it.each(["suspended", "rejected", "ownerChanged", "missingGrant"])(
    "stops a new read-to-prepare attempt for %s without writes",
    async (mode) => {
      const a = sourceAdmins[0]!,
        p = sourceAdmins[1]!;
      if (mode === "suspended" || mode === "rejected")
        await a.query("UPDATE public.users SET status=$1", [mode]);
      if (mode === "ownerChanged")
        await p.query("UPDATE public.hotels SET user_id=$1 WHERE id=$2", [id(88), id(11)]);
      if (mode === "missingGrant")
        await p.query("REVOKE SELECT(user_id) ON public.hotels FROM vay2017_pipeline_reader");
      try {
        await expect(
          (async () => prepare(identity, { ...fixture, artifacts: await collectSources() }))(),
        ).rejects.toThrow("LEGACY_OWNER_CURRENT_SOURCE_COLLECTION_FAILED");
        expect(await counts()).toEqual({ owners: 0, receipts: 0 });
      } finally {
        await a.query("UPDATE public.users SET status='pending'");
        await p.query("UPDATE public.hotels SET user_id=$1 WHERE id=$2", [id(1), id(11)]);
        await p.query("GRANT SELECT(user_id) ON public.hotels TO vay2017_pipeline_reader");
      }
    },
  );
  it("uses actual restricted login through identity, signed approvals, absence and atomic checkpoint/replay", async () => {
    expect(
      (
        await executor.query(
          "SELECT session_user=current_user AS same, rolsuper FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0],
    ).toEqual({ same: true, rolsuper: false });
    expect(await prepare()).toHaveProperty("outcome", "checkpoint_written_uncommitted");
    expect(await counts()).toEqual({ owners: 8, receipts: 1 });
    expect(
      (await executor.query("SELECT DISTINCT status FROM identity.users WHERE id<>$1", [id(90)]))
        .rows,
    ).toEqual([{ status: "pending" }]);
    expect(await prepare()).toHaveProperty("outcome", "matching_receipt_found");
    expect(await counts()).toEqual({ owners: 8, receipts: 1 });
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM platform.legacy_owner_bootstrap_receipts"))
        .rows[0].n,
    ).toBe(0);
    await expect(
      admin.query(
        "BEGIN; LOCK TABLE vayada_migration_evidence.database_attestations IN ACCESS EXCLUSIVE MODE NOWAIT",
      ),
    ).rejects.toHaveProperty("code", "55P03");
    await admin.query("ROLLBACK");
  });
  it.each(["databaseName", "databaseOid", "targetIdentitySha256", "environment"])(
    "denies changed target %s before approval locks",
    async (field) => {
      const changed = {
        ...identity,
        [field]: field === "databaseOid" ? identity.databaseOid + 1 : "wrong",
      };
      const spy = vi.spyOn(executor, "query");
      await expect(prepare(changed)).rejects.toThrow("LEGACY_OWNER_VERIFIED_TARGET_INVALID");
      expect(spy.mock.calls.some(([sql]) => String(sql).includes("FOR UPDATE"))).toBe(false);
      expect(await counts()).toEqual({ owners: 0, receipts: 0 });
    },
  );
  it("rejects independent digest drift rather than accepting the artifact's own hash", async () => {
    await expect(
      prepare(identity, fixture, { ...expected, targetDatabaseSha256: sha }),
    ).rejects.toThrow("LEGACY_OWNER_VERIFIED_TARGET_INVALID");
    expect(await counts()).toEqual({ owners: 0, receipts: 0 });
  });
  it("denies invalid source, signature, target artifact and approval without writes", async () => {
    for (const mode of ["source", "signature", "absence", "approval"]) {
      const changed = transactionFixture();
      if (mode === "source") changed.artifacts[0]!.detachedSignature = "invalid";
      if (mode === "signature") changed.request.detachedSignature = "invalid";
      if (mode === "absence") changed.targetArtifacts[0] += " ";
      if (mode === "approval") {
        const value = JSON.parse(changed.request.commandPayload);
        value.commandId = id(98);
        changed.request = signedRequest(value);
      }
      await expect(prepare(identity, changed)).rejects.toThrow(
        "LEGACY_OWNER_VERIFIED_TARGET_INVALID",
      );
      expect(await counts()).toEqual({ owners: 0, receipts: 0 });
    }
  });
  it("rejects executor-writable protected attestation", async () => {
    await admin.query(
      "GRANT UPDATE ON vayada_migration_evidence.database_attestations TO vay2017_setup_executor",
    );
    try {
      await expect(prepare()).rejects.toThrow("LEGACY_OWNER_VERIFIED_TARGET_INVALID");
    } finally {
      await admin.query(
        "REVOKE UPDATE ON vayada_migration_evidence.database_attestations FROM vay2017_setup_executor",
      );
    }
    expect(await counts()).toEqual({ owners: 0, receipts: 0 });
  });
  it("captures submitted identity before asynchronous work", async () => {
    const submitted = { ...identity };
    const original = executor.query.bind(executor);
    vi.spyOn(executor, "query").mockImplementation((async (sql: string, values?: unknown[]) => {
      if (sql === "SAVEPOINT vay2017_verified_target") submitted.databaseOid++;
      return original(sql, values);
    }) as typeof executor.query);
    expect(await prepare(submitted)).toHaveProperty("outcome", "checkpoint_written_uncommitted");
  });
  it("rolls back a write-time failure and rechecks identity even on exact replay", async () => {
    await executor.query(
      `INSERT INTO identity.users(id,email,status) VALUES('${id(1)}','new-conflict@example.invalid','suspended')`,
    );
    await expect(prepare()).rejects.toThrow("LEGACY_OWNER_VERIFIED_TARGET_INVALID");
    expect(await counts()).toEqual({ owners: 1, receipts: 0 });
    await executor.query(
      "ROLLBACK; BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'",
    );
    expect(await prepare()).toHaveProperty("outcome", "checkpoint_written_uncommitted");
    await expect(prepare({ ...identity, databaseOid: identity.databaseOid + 1 })).rejects.toThrow(
      "LEGACY_OWNER_VERIFIED_TARGET_INVALID",
    );
    expect(await counts()).toEqual({ owners: 8, receipts: 1 });
  });
  it("rolls back both users and receipt when evidence expires after persistence", async () => {
    let written = false;
    const original = executor.query.bind(executor);
    vi.spyOn(executor, "query").mockImplementation((async (sql: string, values?: unknown[]) => {
      const result = await original(sql, values);
      if (sql === "RELEASE SAVEPOINT vay2017_setup_checkpoint") written = true;
      return result;
    }) as typeof executor.query);
    await expect(
      prepare(identity, fixture, expected, () => (written ? new Date(command().expiresAt) : now)),
    ).rejects.toThrow("LEGACY_OWNER_VERIFIED_TARGET_INVALID");
    expect(written).toBe(true);
    expect(await counts()).toEqual({ owners: 0, receipts: 0 });
    for (const table of ["organizations", "organization_memberships", "external_identities"])
      expect(
        (await executor.query(`SELECT count(*)::int AS n FROM identity.${table}`)).rows[0].n,
      ).toBe(0);
  });
});

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

  const prepare = (fixture = transactionFixture(), clock = () => now) =>
    prepareLegacyOwnerSetupTransaction(
      client,
      fixture.request,
      expected,
      fixture.artifacts,
      fixture.trust,
      policy,
      scope(),
      fixture.targetArtifacts,
      clock,
    );
  it("composes source signatures, approvals, guards and checkpoint, then replays without another write", async () => {
    const fixture = transactionFixture();
    await seedApprovals(fixture.request);
    expect(await prepare(fixture)).toEqual({
      outcome: "checkpoint_written_uncommitted",
      commandId: id(99),
    });
    expect(await counts()).toEqual({ users: 9, receipts: 1 });
    expect(await counts(observer)).toEqual({ users: 0, receipts: 0 });
    const spy = vi.spyOn(client, "query");
    expect(await prepare(fixture)).toMatchObject({
      outcome: "matching_receipt_found",
      receipt: { commandId: id(99) },
    });
    expect(spy.mock.calls.some(([sql]) => String(sql).includes("LOCK TABLE identity."))).toBe(
      false,
    );
    expect(await counts()).toEqual({ users: 9, receipts: 1 });
    for (const table of ["organizations", "organization_memberships", "external_identities"])
      expect(
        (await client.query(`SELECT count(*)::int AS n FROM identity.${table}`)).rows[0].n,
      ).toBe(0);
  });
  it("rejects invalid source attestation before any database statement", async () => {
    const fixture = transactionFixture();
    fixture.artifacts[0]!.detachedSignature = "invalid";
    const spy = vi.spyOn(client, "query");
    await expect(prepare(fixture)).rejects.toThrow("LEGACY_OWNER_SETUP_TRANSACTION_INVALID");
    expect(spy).not.toHaveBeenCalled();
  });
  it.each([
    ["contractVersion", "other"],
    ["normalizationVersion", "other"],
    ["environment", "production"],
    ["targetDatabaseSha256", "b".repeat(64)],
    ["ownerId", id(88)],
    ["normalizedEmailSha256", sha],
    ["emailScopeSha256", sha],
    ["observedAt", "2026-09-15T00:59:59.999Z"],
    ["observedAt", "2026-09-15T01:02:00.000Z"],
    ["observedAt", "2026-09-15T01:00:00Z"],
    ["observedAt", "not-a-date"],
    ["userIdPresent", true],
    ["userEmailPresent", "false"],
    ["externalUserIdPresent", 0],
    ["externalEmailPresent", null],
    ["extra", false],
  ])("rejects signed invalid target artifact %s=%s before SQL", async (field, value) => {
    const fixture = transactionFixture((row) => {
      row[field as string] = value;
    });
    const spy = vi.spyOn(client, "query");
    await expect(prepare(fixture)).rejects.toThrow("LEGACY_OWNER_SETUP_TRANSACTION_INVALID");
    expect(spy).not.toHaveBeenCalled();
  });
  it.each(["missing", "extra", "duplicate", "noncanonical", "hash drift"])(
    "rejects %s target artifacts before SQL",
    async (mode) => {
      const fixture = transactionFixture();
      if (mode === "missing") fixture.targetArtifacts.pop();
      if (mode === "extra") fixture.targetArtifacts.push(fixture.targetArtifacts[0]!);
      if (mode === "duplicate") fixture.targetArtifacts[1] = fixture.targetArtifacts[0]!;
      if (mode === "noncanonical") fixture.targetArtifacts[0] += " ";
      if (mode === "hash drift")
        fixture.targetArtifacts[0] = fixture.targetArtifacts[0]!.replace(
          "01:00:00.000Z",
          "01:00:01.000Z",
        );
      const spy = vi.spyOn(client, "query");
      await expect(prepare(fixture)).rejects.toThrow("LEGACY_OWNER_SETUP_TRANSACTION_INVALID");
      expect(spy).not.toHaveBeenCalled();
    },
  );
  it("denies swapped in-scope hashes using live PostgreSQL normalization before writes", async () => {
    const hashes = scope();
    const fixture = transactionFixture((row, i) => {
      row.normalizedEmailSha256 = hashes[(i + 1) % 8];
    });
    expect(
      verifyLegacyOwnerTargetAbsence(
        fixture.request,
        expected,
        fixture.targetArtifacts,
        hashes,
        now,
      ),
    ).toHaveLength(8);
    await seedApprovals(fixture.request);
    await expect(prepare(fixture)).rejects.toThrow("LEGACY_OWNER_SETUP_TRANSACTION_INVALID");
    expect(await counts()).toEqual({ users: 1, receipts: 0 });
  });
  it.each([
    "missing approval",
    "revocation",
    "target conflict",
    "receipt failure",
    "post-write expiry",
  ])("rolls back the composed operation on %s without losing earlier caller work", async (mode) => {
    const fixture = transactionFixture();
    if (mode === "missing approval") await configureGuard();
    else await seedApprovals(fixture.request);
    if (mode === "revocation")
      await client.query(
        "INSERT INTO platform.legacy_owner_approval_revocations VALUES($1,$2,$3,$4,now())",
        [id(91), id(90), now, sha],
      );
    if (mode === "target conflict")
      await client.query(
        "INSERT INTO identity.users(id,email,status) VALUES($1,'conflict@example.invalid','suspended')",
        [id(1)],
      );
    if (mode === "receipt failure")
      await client.query(`CREATE FUNCTION public.transaction_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private detail'; END $$;
          CREATE TRIGGER transaction_fixture BEFORE INSERT ON platform.legacy_owner_bootstrap_receipts FOR EACH ROW EXECUTE FUNCTION public.transaction_fixture()`);
    let wrote = false;
    const original = client.query.bind(client);
    vi.spyOn(client, "query").mockImplementation((async (sql: string, values?: unknown[]) => {
      const result = await original(sql, values);
      if (sql.includes("RELEASE SAVEPOINT vay2017_setup_checkpoint")) wrote = true;
      return result;
    }) as typeof client.query);
    const before = await counts();
    await expect(
      prepare(fixture, () =>
        mode === "post-write expiry" && wrote ? new Date(command().expiresAt) : now,
      ),
    ).rejects.toThrow(/^LEGACY_OWNER_SETUP_TRANSACTION_INVALID$/);
    expect(await counts()).toEqual(before);
    expect(await counts(observer)).toEqual({ users: 0, receipts: 0 });
  });
  it("captures protected evidence and scope before asynchronous database work", async () => {
    const fixture = transactionFixture();
    await seedApprovals(fixture.request);
    const original = client.query.bind(client);
    vi.spyOn(client, "query").mockImplementation((async (sql: string, values?: unknown[]) => {
      if (sql === "SAVEPOINT vay2017_setup_transaction") {
        fixture.request.commandPayload = "invalid";
        fixture.request.verificationKeys.clear();
        fixture.artifacts[0]!.canonicalPayload = "invalid";
        fixture.targetArtifacts[0] = "invalid";
        fixture.trust.verificationKeys.clear();
      }
      return original(sql, values);
    }) as typeof client.query);
    expect(await prepare(fixture)).toHaveProperty("outcome", "checkpoint_written_uncommitted");
  });
  it("denies autocommit before preparing users", async () => {
    await client.query("ROLLBACK");
    await expect(prepare()).rejects.toThrow("LEGACY_OWNER_SETUP_TRANSACTION_INVALID");
    expect(await counts()).toEqual({ users: 0, receipts: 0 });
  });
  it("requires connection disposal when its rollback cannot be confirmed", async () => {
    const fixture = transactionFixture();
    await configureGuard();
    const original = client.query.bind(client);
    vi.spyOn(client, "query").mockImplementation((async (sql: string, values?: unknown[]) => {
      if (sql === "ROLLBACK TO SAVEPOINT vay2017_setup_transaction")
        throw new Error("private connection detail");
      return original(sql, values);
    }) as typeof client.query);
    await expect(prepare(fixture)).rejects.toThrow(
      /^LEGACY_OWNER_SETUP_TRANSACTION_ROLLBACK_FAILED$/,
    );
  });

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
    expect(await guard()).toMatchObject({
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
    const fixture = transactionFixture();
    await seedApprovals(fixture.request);
    await client.query("COMMIT; BEGIN");
    await configureGuard();
    expect(await prepare(fixture)).toHaveProperty("outcome", "checkpoint_written_uncommitted");
    const holder = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const waiter = (await observer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await observer.query(
      "BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '6s'",
    );
    const pending = prepareLegacyOwnerSetupTransaction(
      observer,
      fixture.request,
      expected,
      fixture.artifacts,
      fixture.trust,
      policy,
      scope(),
      fixture.targetArtifacts,
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
