import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const evidence = vi.hoisted(() => ({
  verifySource: vi.fn(),
  verifyTarget: vi.fn(),
}));
vi.mock("./channexAdoptionEvidence.js", () => ({
  verifyChannexAdoptionSourceEvidence: evidence.verifySource,
  verifyChannexAdoptionTargetEvidence: evidence.verifyTarget,
}));

import {
  consumeSignedChannexAdoptionManifest,
  type ChannexAdoptionConsumerConfig,
} from "./channexAdoptionConsumer.js";
import { rejectAdoption } from "./channexAdoptionConsumptionError.js";
import type { ChannexAdoptionManifest } from "./channexAdoptionManifest.js";
import {
  canonicalizeJson,
  hashApprovalSubject,
  hashRollbackReason,
  hashRollbackSubject,
} from "./channexAdoptionManifestCrypto.js";
import { rollbackChannexAdoption } from "./channexAdoptionRollback.js";
import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const DATABASE = "vayada_channex_adoption_consumer_test";
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE_URL = process.env["TEST_DATABASE_URL"];
const HASH = "a".repeat(64);
const NOW = new Date("2026-09-12T10:30:00.000Z");
const USER_IDS = [1, 2].map((value) => uuid(900 + value));
const ORGANIZATION_ID = uuid(800);
const PROPERTY_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((value) => uuid(700 + value));

let admin: pg.Client;
let pool: pg.Pool;
let privateKey: KeyObject;
let publicKey: KeyObject;
let config: ChannexAdoptionConsumerConfig;

describe.skipIf(!DATABASE_URL)("Channex adoption consumption", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(DATABASE_URL!);
    const adminUrl = new URL(DATABASE_URL!);
    adminUrl.pathname = "/postgres";
    const targetUrl = new URL(DATABASE_URL!);
    targetUrl.pathname = `/${DATABASE}`;
    admin = new pg.Client({ connectionString: adminUrl.href });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    expect(
      (
        await runMigrations({
          connectionString: targetUrl.href,
          migrationsDir: MIGRATIONS,
          environment: "local",
        })
      ).failed,
    ).toBeNull();
    pool = new pg.Pool({ connectionString: targetUrl.href, max: 4 });
    await pool.query(
      `INSERT INTO identity.users(id,email) VALUES ($1,'migration@example.test'),($2,'security@example.test')`,
      USER_IDS,
    );
    await pool.query(
      `INSERT INTO identity.organizations(id,kind,name,slug,status)
       VALUES ($1,'hotel_group','Adoption Test','adoption-test','active')`,
      [ORGANIZATION_ID],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name)
       SELECT id, 'property-' || ordinality, 'Property ' || ordinality
         FROM unnest($1::uuid[]) WITH ORDINALITY AS source(id, ordinality)`,
      [PROPERTY_IDS],
    );
    ({ privateKey, publicKey } = generateKeyPairSync("ed25519"));
    config = {
      environment: "local",
      executionPrincipal: "iam:migration-runner",
      allowedExecutionPrincipals: new Set(["iam:migration-runner"]),
      verificationKeys: new Map([["migration-local-2026-01", publicKey]]),
      signingPrincipals: new Map([["migration-local-2026-01", "kms:manifest-signer"]]),
      approvalPrincipals: new Map([
        [USER_IDS[0]!, "user:migration-owner"],
        [USER_IDS[1]!, "user:security-owner"],
      ]),
      singleHumanDualAuthority: {
        actorUserId: USER_IDS[0]!,
        principal: "user:migration-owner",
        decisionId: "VAY-1320@2026-09-12",
      },
      now: () => NOW,
    };
  }, 30_000);

  afterAll(async () => {
    if (pool) await endPoolAndWaitForClients(pool);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("consumes once, persists failures, serializes conflicts, and isolates rollback", async () => {
    evidence.verifySource.mockResolvedValue(undefined);
    evidence.verifyTarget.mockImplementation(
      async (client: Pick<pg.ClientBase, "query">, manifest: ChannexAdoptionManifest) => {
        const result = await client.query(
          `SELECT 1 FROM pms.channel_binding_claims
            WHERE property_id=$1::uuid OR (provider='channex' AND external_property_id=$2)`,
          [manifest.targetPropertyId, manifest.externalPropertyId],
        );
        if (result.rows.length) rejectAdoption("BINDING_CLAIM_HISTORY_EXISTS");
      },
    );
    const first = fixture(1, PROPERTY_IDS[0]!, uuid(601));
    await insertApprovals(first.manifest);
    const before = await pool.query("SELECT * FROM pms.channel_connections ORDER BY property_id");
    const concurrentReplay = await Promise.all([consume(first), consume(first)]);
    expect(concurrentReplay.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(new Set(concurrentReplay.map((result) => result.claimId)).size).toBe(1);
    const consumed = concurrentReplay[0]!;
    expect(await claim(consumed.claimId)).toMatchObject({
      claimState: "verified_non_active",
      claimSource: "adoption",
      propertyId: PROPERTY_IDS[0],
    });
    expect((await consume(first)).replayed).toBe(true);
    evidence.verifySource.mockClear();
    evidence.verifyTarget.mockClear();
    await expect(
      consumeSignedChannexAdoptionManifest(
        pool,
        { raw: JSON.stringify(first.manifest), detachedSignature: first.signature },
        { ...config, now: () => new Date("2026-09-13T10:30:00.000Z") },
      ),
    ).resolves.toMatchObject({ replayed: true, claimId: consumed.claimId });
    expect(evidence.verifySource).not.toHaveBeenCalled();
    expect(evidence.verifyTarget).not.toHaveBeenCalled();
    expect(await pool.query("SELECT * FROM pms.channel_connections ORDER BY property_id")).toEqual(
      before,
    );
    const drift = structuredClone(first.manifest);
    drift.sourceEvidenceSha256 = "b".repeat(64);
    refreshApprovalSubject(drift);
    await expect(
      consume({ manifest: drift, signature: signatureFor(drift) }),
    ).rejects.toMatchObject({
      code: "MANIFEST_PAYLOAD_DRIFT",
    });

    const wrongEnvironment = fixture(5, PROPERTY_IDS[4]!, uuid(605));
    wrongEnvironment.manifest.environment = "staging";
    wrongEnvironment.manifest.sourceEnvironment = "staging";
    refreshApprovalSubject(wrongEnvironment.manifest);
    wrongEnvironment.signature = signatureFor(wrongEnvironment.manifest);
    await insertApprovals(wrongEnvironment.manifest);
    await expect(consume(wrongEnvironment)).rejects.toMatchObject({
      code: "TARGET_ENVIRONMENT_MISMATCH",
    });

    const wrongPairing = fixture(10, PROPERTY_IDS[4]!, uuid(610));
    wrongPairing.manifest.sourceEnvironment = "staging";
    refreshApprovalSubject(wrongPairing.manifest);
    wrongPairing.signature = signatureFor(wrongPairing.manifest);
    await insertApprovals(wrongPairing.manifest);
    await expect(consume(wrongPairing)).rejects.toMatchObject({
      code: "SOURCE_ENVIRONMENT_MISMATCH",
    });

    const expired = fixture(6, PROPERTY_IDS[5]!, uuid(606));
    expired.manifest.expiresAt = "2026-09-12T10:20:00.000Z";
    refreshApprovalSubject(expired.manifest);
    expired.signature = signatureFor(expired.manifest);
    await insertApprovals(expired.manifest);
    await expect(consume(expired)).rejects.toMatchObject({ code: "MANIFEST_EXPIRED" });

    const revoked = fixture(7, PROPERTY_IDS[6]!, uuid(607));
    await insertApprovals(revoked.manifest);
    await pool.query(
      `INSERT INTO platform.channex_adoption_approval_revocations
         (approval_record_id,revoked_by_user_id,revoked_at,reason_sha256)
       VALUES($1,$2,$3,$4)`,
      [revoked.manifest.approvalEvidence[0].approvalRecordId, USER_IDS[1], NOW, HASH],
    );
    await expect(consume(revoked)).rejects.toMatchObject({ code: "APPROVAL_EVIDENCE_MISMATCH" });

    const collidingRoles = fixture(8, PROPERTY_IDS[7]!, uuid(608));
    await insertApprovals(collidingRoles.manifest);
    await expect(
      consumeSignedChannexAdoptionManifest(
        pool,
        {
          raw: JSON.stringify(collidingRoles.manifest),
          detachedSignature: collidingRoles.signature,
        },
        {
          ...config,
          approvalPrincipals: new Map([
            [USER_IDS[0]!, "kms:manifest-signer"],
            [USER_IDS[1]!, "user:security-owner"],
          ]),
        },
      ),
    ).rejects.toMatchObject({ code: "ROLE_SEPARATION_VIOLATION" });

    const collidingMachines = fixture(12, PROPERTY_IDS[7]!, uuid(612));
    await insertApprovals(collidingMachines.manifest);
    await expect(
      consumeSignedChannexAdoptionManifest(
        pool,
        {
          raw: JSON.stringify(collidingMachines.manifest),
          detachedSignature: collidingMachines.signature,
        },
        {
          ...config,
          signingPrincipals: new Map([
            [collidingMachines.manifest.signingKeyId, config.executionPrincipal],
          ]),
        },
      ),
    ).rejects.toMatchObject({ code: "ROLE_SEPARATION_VIOLATION" });

    const rejected = fixture(2, PROPERTY_IDS[1]!, uuid(602));
    await insertApprovals(rejected.manifest);
    evidence.verifySource.mockImplementationOnce(async () =>
      rejectAdoption("SOURCE_EVIDENCE_CHANGED"),
    );
    await expect(consume(rejected)).rejects.toMatchObject({ code: "SOURCE_EVIDENCE_CHANGED" });
    expect(
      (
        await pool.query(
          `SELECT outcome,failure_code AS "failureCode" FROM platform.channex_adoption_manifest_consumptions
            WHERE manifest_id=$1`,
          [rejected.manifest.manifestId],
        )
      ).rows[0],
    ).toEqual({ outcome: "failed", failureCode: "SOURCE_EVIDENCE_CHANGED" });
    await expect(consume(rejected)).rejects.toMatchObject({ code: "MANIFEST_STORED_FAILURE" });

    const singleHuman = fixture(11, PROPERTY_IDS[1]!, uuid(611));
    singleHuman.manifest.approvalEvidence[1].actorUserId =
      singleHuman.manifest.approvalEvidence[0].actorUserId;
    refreshApprovalSubject(singleHuman.manifest);
    singleHuman.signature = signatureFor(singleHuman.manifest);
    await insertApprovals(singleHuman.manifest);
    const singleHumanConsumed = await consume(singleHuman);
    expect(singleHumanConsumed).toMatchObject({ replayed: false });
    expect(
      (
        await pool.query(
          `SELECT redacted_payload #>> '{approvalPolicy,name}' AS policy,
                  redacted_payload #>> '{approvalPolicy,decisionId}' AS decision
             FROM platform.product_audit_events WHERE audit_key=$1`,
          [`channex-adoption:${singleHuman.manifest.manifestId}`],
        )
      ).rows[0],
    ).toEqual({
      policy: "single_human_dual_authority.v1",
      decision: "VAY-1320@2026-09-12",
    });

    for (const [seed, actor, authorization] of [
      [13, USER_IDS[1]!, config.singleHumanDualAuthority],
      [14, USER_IDS[0]!, null],
    ] as const) {
      const unauthorized = fixture(seed, PROPERTY_IDS[4]!, uuid(600 + seed));
      unauthorized.manifest.approvalEvidence[1].actorUserId = actor;
      unauthorized.manifest.approvalEvidence[0].actorUserId = actor;
      refreshApprovalSubject(unauthorized.manifest);
      unauthorized.signature = signatureFor(unauthorized.manifest);
      await insertApprovals(unauthorized.manifest);
      await expect(
        consumeSignedChannexAdoptionManifest(
          pool,
          {
            raw: JSON.stringify(unauthorized.manifest),
            detachedSignature: unauthorized.signature,
          },
          { ...config, singleHumanDualAuthority: authorization },
        ),
      ).rejects.toMatchObject({ code: "SINGLE_HUMAN_DUAL_AUTHORITY_FORBIDDEN" });
    }

    const rejectedRollbackIds = [uuid(505), uuid(506)] as const;
    const rejectedRollbackExpiry = "2026-09-12T11:40:00.000Z";
    await insertRollbackApprovals(
      singleHuman.manifest,
      singleHumanConsumed.claimId,
      "Rejected approval fixture",
      rejectedRollbackExpiry,
      rejectedRollbackIds,
    );
    await expect(
      rollbackChannexAdoption(
        pool,
        {
          manifestId: singleHuman.manifest.manifestId,
          reason: "Rejected approval fixture",
          expiresAt: rejectedRollbackExpiry,
          approvalRecordIds: [rejectedRollbackIds[0], uuid(599)],
        },
        config,
      ),
    ).rejects.toMatchObject({ code: "ROLLBACK_APPROVAL_MISMATCH" });
    await pool.query(
      `INSERT INTO platform.channex_adoption_rollback_approval_revocations
         (approval_record_id,revoked_by_user_id,revoked_at,reason_sha256)
       VALUES($1,$2,$3,$4)`,
      [rejectedRollbackIds[1], USER_IDS[1], NOW, HASH],
    );
    await expect(
      rollbackChannexAdoption(
        pool,
        {
          manifestId: singleHuman.manifest.manifestId,
          reason: "Rejected approval fixture",
          expiresAt: rejectedRollbackExpiry,
          approvalRecordIds: rejectedRollbackIds,
        },
        config,
      ),
    ).rejects.toMatchObject({ code: "ROLLBACK_APPROVAL_MISMATCH" });

    const atomicRollbackIds = [uuid(507), uuid(508)] as const;
    const atomicRollbackExpiry = "2026-09-12T11:50:00.000Z";
    await insertRollbackApprovals(
      singleHuman.manifest,
      singleHumanConsumed.claimId,
      "Atomic rollback fixture",
      atomicRollbackExpiry,
      atomicRollbackIds,
    );
    await pool.query(
      `INSERT INTO platform.product_audit_events
         (audit_key,product,action,occurred_at,tenant_scope,actor_type,
          target_resource_product,target_resource_type,target_resource_id)
       VALUES($1,'pms','synthetic_conflict',now(),'migration','migration','pms','test','test')`,
      [`channex-adoption-rollback:${singleHuman.manifest.manifestId}`],
    );
    await expect(
      rollbackChannexAdoption(
        pool,
        {
          manifestId: singleHuman.manifest.manifestId,
          reason: "Atomic rollback fixture",
          expiresAt: atomicRollbackExpiry,
          approvalRecordIds: atomicRollbackIds,
        },
        config,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect(await claim(singleHumanConsumed.claimId)).toMatchObject({
      claimState: "verified_non_active",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer count FROM platform.channex_adoption_rollbacks WHERE manifest_id=$1",
          [singleHuman.manifest.manifestId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });

    const conflictA = fixture(3, PROPERTY_IDS[2]!, uuid(603));
    const conflictB = fixture(4, PROPERTY_IDS[3]!, uuid(603));
    await insertApprovals(conflictA.manifest);
    await insertApprovals(conflictB.manifest);
    const results = await Promise.allSettled([consume(conflictA), consume(conflictB)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM pms.channel_binding_claims
            WHERE external_property_id=$1`,
          [uuid(603)],
        )
      ).rows[0],
    ).toEqual({ count: 1 });

    const sameTargetA = fixture(15, PROPERTY_IDS[5]!, uuid(615));
    const sameTargetB = fixture(16, PROPERTY_IDS[5]!, uuid(616));
    await insertApprovals(sameTargetA.manifest);
    await insertApprovals(sameTargetB.manifest);
    const sameTargetResults = await Promise.allSettled([
      consume(sameTargetA),
      consume(sameTargetB),
    ]);
    expect(sameTargetResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(sameTargetResults.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer count FROM pms.channel_binding_claims WHERE property_id=$1",
          [PROPERTY_IDS[5]],
        )
      ).rows[0],
    ).toEqual({ count: 1 });

    const changedWhileWaiting = fixture(17, PROPERTY_IDS[8]!, uuid(617));
    await insertApprovals(changedWhileWaiting.manifest);
    const mutator = await pool.connect();
    try {
      await mutator.query("BEGIN");
      for (const key of [
        `channex.management:${changedWhileWaiting.manifest.targetPropertyId}`,
        `channex.external-property:${changedWhileWaiting.manifest.externalPropertyId}`,
      ].sort())
        await mutator.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      const blockedConsumption = consume(changedWhileWaiting);
      await waitForAdvisoryWaiter();
      await mutator.query(
        `INSERT INTO pms.channel_binding_claims
           (property_id,provider,external_property_id,claim_state,claim_source)
         VALUES($1,'channex',$2,'verified_non_active','repair')`,
        [
          changedWhileWaiting.manifest.targetPropertyId,
          changedWhileWaiting.manifest.externalPropertyId,
        ],
      );
      await mutator.query("COMMIT");
      await expect(blockedConsumption).rejects.toMatchObject({
        code: "BINDING_CLAIM_HISTORY_EXISTS",
      });
      expect(
        (
          await pool.query(
            `SELECT outcome,failure_code AS "failureCode"
               FROM platform.channex_adoption_manifest_consumptions WHERE manifest_id=$1`,
            [changedWhileWaiting.manifest.manifestId],
          )
        ).rows[0],
      ).toEqual({ outcome: "failed", failureCode: "BINDING_CLAIM_HISTORY_EXISTS" });
    } finally {
      await mutator.query("ROLLBACK").catch(() => undefined);
      mutator.release();
    }

    const expiresAt = "2026-09-12T11:30:00.000Z";
    const rollbackIds = [uuid(501), uuid(502)] as const;
    await insertRollbackApprovals(
      first.manifest,
      consumed.claimId,
      "Synthetic fixture cleanup",
      expiresAt,
      rollbackIds,
    );
    expect(
      (
        await rollbackChannexAdoption(
          pool,
          {
            manifestId: first.manifest.manifestId,
            reason: "Synthetic fixture cleanup",
            expiresAt,
            approvalRecordIds: rollbackIds,
          },
          config,
        )
      ).replayed,
    ).toBe(false);
    expect(await claim(consumed.claimId)).toMatchObject({ claimState: "released" });
    expect(
      (
        await pool.query(
          `SELECT redacted_payload #>> '{approvalPolicy,name}' AS policy,
                  redacted_payload #>> '{approvalPolicy,decisionId}' AS decision
             FROM platform.product_audit_events WHERE audit_key=$1`,
          [`channex-adoption-rollback:${first.manifest.manifestId}`],
        )
      ).rows[0],
    ).toEqual({
      policy: "single_human_dual_authority.v1",
      decision: "VAY-1320@2026-09-12",
    });
    expect(
      (
        await rollbackChannexAdoption(
          pool,
          {
            manifestId: first.manifest.manifestId,
            reason: "Synthetic fixture cleanup",
            expiresAt,
            approvalRecordIds: rollbackIds,
          },
          config,
        )
      ).replayed,
    ).toBe(true);

    const winner = results.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof consume>>> =>
        result.status === "fulfilled",
    )!.value;
    await pool.query("UPDATE pms.channel_binding_claims SET claim_state='active' WHERE id=$1", [
      winner.claimId,
    ]);
    const winningManifest =
      winner.manifestId === conflictA.manifest.manifestId ? conflictA.manifest : conflictB.manifest;
    const activeRollbackIds = [uuid(503), uuid(504)] as const;
    await insertRollbackApprovals(
      winningManifest,
      winner.claimId,
      "Must not release active claim",
      expiresAt,
      activeRollbackIds,
    );
    await expect(
      rollbackChannexAdoption(
        pool,
        {
          manifestId: winner.manifestId,
          reason: "Must not release active claim",
          expiresAt,
          approvalRecordIds: activeRollbackIds,
        },
        config,
      ),
    ).rejects.toMatchObject({ code: "ROLLBACK_CLAIM_MISMATCH" });
    expect(await claim(winner.claimId)).toMatchObject({ claimState: "active" });

    const transactionFailure = fixture(9, PROPERTY_IDS[7]!, uuid(609));
    transactionFailure.manifest.manifestId = uuid(109);
    transactionFailure.manifest.approvalEvidence[0].approvalRecordId = uuid(1090);
    transactionFailure.manifest.approvalEvidence[1].approvalRecordId = uuid(1091);
    refreshApprovalSubject(transactionFailure.manifest);
    transactionFailure.signature = signatureFor(transactionFailure.manifest);
    await insertApprovals(transactionFailure.manifest);
    await pool.query(
      `INSERT INTO platform.product_audit_events
         (audit_key,product,action,occurred_at,tenant_scope,actor_type,
          target_resource_product,target_resource_type,target_resource_id)
       VALUES($1,'pms','synthetic_conflict',now(),'migration','migration','pms','test','test')`,
      [`channex-adoption:${transactionFailure.manifest.manifestId}`],
    );
    await expect(consume(transactionFailure)).rejects.toMatchObject({ code: "23505" });
    expect(
      (
        await pool.query(
          `SELECT
             (SELECT count(*)::integer FROM pms.channel_binding_claims WHERE external_property_id=$1) AS claims,
             (SELECT count(*)::integer FROM platform.channex_adoption_manifest_consumptions WHERE manifest_id=$2) AS consumptions`,
          [transactionFailure.manifest.externalPropertyId, transactionFailure.manifest.manifestId],
        )
      ).rows[0],
    ).toEqual({ claims: 0, consumptions: 0 });
  }, 30_000);
});

async function endPoolAndWaitForClients(pool: pg.Pool): Promise<void> {
  const clientCount = pool.totalCount;
  let resolveRemoved: () => void = () => undefined;
  const allClientsRemoved = new Promise<void>((resolve) => {
    resolveRemoved = resolve;
  });
  let removed = 0;
  const onRemove = () => {
    removed += 1;
    if (removed === clientCount) resolveRemoved();
  };
  if (clientCount > 0) pool.on("remove", onRemove);
  try {
    await pool.end();
    if (clientCount > 0) await allClientsRemoved;
  } finally {
    pool.off("remove", onRemove);
  }
}

function fixture(seed: number, targetPropertyId: string, externalPropertyId: string) {
  const manifest: ChannexAdoptionManifest = {
    contractVersion: "channex-property-adoption.v1",
    manifestId: uuid(100 + seed),
    issuedAt: "2026-09-12T10:00:00.000Z",
    expiresAt: "2026-09-12T11:00:00.000Z",
    environment: "local",
    sourceEnvironment: "local",
    sourceRunId: `vay1351-${seed.toString(16).padStart(24, "0")}`,
    sourceSchemaRevision: "b".repeat(40),
    sourceEvidenceSha256: HASH,
    legacyPmsHotelId: uuid(200 + seed),
    externalPropertyId,
    targetPropertyId,
    targetOrganizationId: ORGANIZATION_ID,
    targetSourceLinkId: uuid(300 + seed),
    legacyResourceLinkId: uuid(310 + seed),
    targetResourceLinkId: uuid(320 + seed),
    targetPmsResourceLinkId: uuid(330 + seed),
    legacyEvidence: {
      hotel: { rowOrdinal: 1, rowChecksumSha256: HASH, userId: uuid(400 + seed) },
      connection: { rowOrdinal: 2, rowChecksumSha256: HASH },
      roomTypeMappings: { rowCount: 0, orderedRowsSha256: HASH },
      ratePlanMappings: { rowCount: 0, orderedRowsSha256: HASH },
      bookingMappings: { rowCount: 0, orderedRowsSha256: HASH },
      bookings: { rowCount: 0, orderedRowsSha256: HASH },
    },
    targetEvidence: {
      property: { id: targetPropertyId, rowStateSha256: HASH },
      sourceLink: {
        id: uuid(300 + seed),
        rowStateSha256: HASH,
        migrationRunId: `vay1351-${seed.toString(16).padStart(24, "0")}`,
        migrationPhase: "complete",
        migrationDisposition: "canonical",
      },
      legacyResourceLink: { id: uuid(310 + seed), rowStateSha256: HASH },
      targetResourceLink: { id: uuid(320 + seed), rowStateSha256: HASH },
      targetPmsResourceLink: { id: uuid(330 + seed), rowStateSha256: HASH },
      organization: { id: ORGANIZATION_ID, rowStateSha256: HASH },
      bindingClaims: { rowCount: 0, orderedRowsSha256: HASH },
    },
    approvalSubjectSha256: HASH,
    approvalEvidence: [
      approval(seed * 2, "migration_owner", USER_IDS[0]!, "2026-09-12T10:05:00.000Z"),
      approval(seed * 2 + 1, "security_owner", USER_IDS[1]!, "2026-09-12T10:06:00.000Z"),
    ],
    signingKeyId: "migration-local-2026-01",
  };
  refreshApprovalSubject(manifest);
  const signature = signatureFor(manifest);
  return { manifest, signature };
}

function refreshApprovalSubject(manifest: ChannexAdoptionManifest) {
  const subject = hashApprovalSubject(manifest as unknown as Record<string, unknown>);
  manifest.approvalSubjectSha256 = subject;
  manifest.approvalEvidence.forEach((row) => (row.approvalSubjectSha256 = subject));
}

function signatureFor(manifest: ChannexAdoptionManifest): string {
  return sign(null, Buffer.from(canonicalizeJson(manifest)), privateKey).toString("base64url");
}

function approval(
  seed: number,
  authority: "migration_owner" | "security_owner",
  actorUserId: string,
  approvedAt: string,
) {
  return {
    approvalRecordId: uuid(1000 + seed),
    authority,
    actorUserId,
    approvedAt,
    approvalSubjectSha256: HASH,
    registryRevision: seed + 1,
    rowStateSha256: HASH,
  };
}

async function insertApprovals(manifest: ChannexAdoptionManifest) {
  for (const row of manifest.approvalEvidence)
    await pool.query(
      `INSERT INTO platform.channex_adoption_approval_records
         (approval_record_id,manifest_id,environment,expires_at,authority,actor_user_id,
          approved_at,approval_subject_sha256,registry_revision,row_state_sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.approvalRecordId,
        manifest.manifestId,
        manifest.environment,
        manifest.expiresAt,
        row.authority,
        row.actorUserId,
        row.approvedAt,
        row.approvalSubjectSha256,
        row.registryRevision,
        row.rowStateSha256,
      ],
    );
}

async function waitForAdvisoryWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::integer count FROM pg_locks WHERE locktype='advisory' AND NOT granted",
    );
    if (result.rows[0]!.count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the adoption consumer to block on the binding lock");
}

async function insertRollbackApprovals(
  manifest: ChannexAdoptionManifest,
  claimId: string,
  reason: string,
  expiresAt: string,
  ids: readonly [string, string],
) {
  const reasonSha256 = hashRollbackReason(reason);
  const subject = hashRollbackSubject({
    manifestId: manifest.manifestId,
    claimId,
    environment: manifest.environment,
    expiresAt,
    rollbackReasonSha256: reasonSha256,
  });
  for (const [index, authority] of ["migration_owner", "security_owner"].entries())
    await pool.query(
      `INSERT INTO platform.channex_adoption_rollback_approval_records
         (approval_record_id,manifest_id,environment,expires_at,rollback_reason_sha256,
          authority,actor_user_id,approved_at,rollback_subject_sha256,registry_revision,row_state_sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        ids[index],
        manifest.manifestId,
        manifest.environment,
        expiresAt,
        reasonSha256,
        authority,
        USER_IDS[0],
        "2026-09-12T10:15:00.000Z",
        subject,
        index + 1,
        HASH,
      ],
    );
}

async function consume(fixtureValue: ReturnType<typeof fixture>) {
  return consumeSignedChannexAdoptionManifest(
    pool,
    { raw: JSON.stringify(fixtureValue.manifest), detachedSignature: fixtureValue.signature },
    config,
  );
}

async function claim(id: string) {
  return (
    await pool.query(
      `SELECT property_id::text AS "propertyId", claim_state AS "claimState",
              claim_source AS "claimSource" FROM pms.channel_binding_claims WHERE id=$1`,
      [id],
    )
  ).rows[0];
}

function uuid(value: number): string {
  return `19630000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
