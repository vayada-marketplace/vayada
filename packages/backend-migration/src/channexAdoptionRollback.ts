import { randomUUID } from "node:crypto";
import type pg from "pg";

import {
  channexAdoptionApprovalPolicyEvidence,
  validateChannexAdoptionApprovalPolicy,
  type ChannexAdoptionConsumerConfig,
} from "./channexAdoptionConsumer.js";
import { rejectAdoption } from "./channexAdoptionConsumptionError.js";
import { hashRollbackReason, hashRollbackSubject } from "./channexAdoptionManifestCrypto.js";

type TransactionClient = Pick<pg.ClientBase, "query">;
type TransactionPool = { connect(): Promise<pg.PoolClient> };

export type ChannexAdoptionRollbackResult = {
  manifestId: string;
  claimId: string;
  replayed: boolean;
};

export async function rollbackChannexAdoption(
  pool: TransactionPool,
  input: {
    manifestId: string;
    reason: string;
    expiresAt: string;
    approvalRecordIds: readonly [string, string];
  },
  config: ChannexAdoptionConsumerConfig,
): Promise<ChannexAdoptionRollbackResult> {
  if (!config.allowedExecutionPrincipals.has(config.executionPrincipal))
    rejectAdoption("EXECUTION_PRINCIPAL_FORBIDDEN");
  if (!validTimestamp(input.expiresAt)) rejectAdoption("ROLLBACK_EXPIRY_INVALID");
  const client = await pool.connect();
  let transactionOpen = false;
  let manifestLocked = false;
  let activeError: unknown;
  const bindingLocks: string[] = [];
  const manifestLockKey = `channex.adoption.manifest:${input.manifestId}`;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [manifestLockKey]);
    manifestLocked = true;
    let consumption = await readSuccessfulConsumption(client, input.manifestId);
    const reasonSha256 = hashRollbackReason(input.reason);
    let subjectSha256 = hashRollbackSubject({
      manifestId: input.manifestId,
      claimId: consumption.claimId,
      environment: consumption.environment,
      expiresAt: input.expiresAt,
      rollbackReasonSha256: reasonSha256,
    });
    const existing = await readRollback(client, input.manifestId);
    if (existing) {
      assertRollbackReplay(existing, consumption.claimId, reasonSha256, subjectSha256);
      return { manifestId: input.manifestId, claimId: consumption.claimId, replayed: true };
    }
    if (consumption.environment !== config.environment)
      rejectAdoption("TARGET_ENVIRONMENT_MISMATCH");

    for (const key of bindingLockKeys(
      consumption.targetPropertyId,
      consumption.externalPropertyId,
    )) {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
      bindingLocks.push(key);
    }
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionOpen = true;
    consumption = await readSuccessfulConsumption(client, input.manifestId);
    subjectSha256 = hashRollbackSubject({
      manifestId: input.manifestId,
      claimId: consumption.claimId,
      environment: consumption.environment,
      expiresAt: input.expiresAt,
      rollbackReasonSha256: reasonSha256,
    });
    const lockedExisting = await readRollback(client, input.manifestId);
    if (lockedExisting) {
      assertRollbackReplay(lockedExisting, consumption.claimId, reasonSha256, subjectSha256);
      await client.query("COMMIT");
      transactionOpen = false;
      return { manifestId: input.manifestId, claimId: consumption.claimId, replayed: true };
    }
    if (consumption.environment !== config.environment)
      rejectAdoption("TARGET_ENVIRONMENT_MISMATCH");

    await verifyRollbackApprovals(client, input.approvalRecordIds, {
      manifestId: input.manifestId,
      environment: consumption.environment,
      expiresAt: input.expiresAt,
      reasonSha256,
      subjectSha256,
      signingKeyId: consumption.signingKeyId,
      config,
    });
    const released = await client.query<{ id: string }>(
      `UPDATE pms.channel_binding_claims
          SET claim_state = 'released', updated_at = now()
        WHERE id = $1::uuid AND property_id = $2::uuid AND provider = 'channex'
          AND external_property_id = $3 AND claim_state = 'verified_non_active'
          AND claim_source = 'adoption'
      RETURNING id::text`,
      [consumption.claimId, consumption.targetPropertyId, consumption.externalPropertyId],
    );
    if (released.rows.length !== 1) rejectAdoption("ROLLBACK_CLAIM_MISMATCH");
    const approvals = await readRollbackApprovals(client, input.approvalRecordIds);
    const byAuthority = new Map(approvals.map((row) => [row.authority, row.approvalRecordId]));
    await client.query(
      `INSERT INTO platform.channex_adoption_rollbacks
         (manifest_id, claim_id, rollback_reason_sha256, rollback_subject_sha256,
          migration_approval_record_id, security_approval_record_id, released_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, now())`,
      [
        input.manifestId,
        consumption.claimId,
        reasonSha256,
        subjectSha256,
        byAuthority.get("migration_owner"),
        byAuthority.get("security_owner"),
      ],
    );
    await client.query(
      `INSERT INTO platform.product_audit_events
         (id, audit_key, product, action, occurred_at, tenant_scope,
          actor_type, target_resource_product, target_resource_type, target_resource_id,
          redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope, ai_visible)
       VALUES ($1::uuid, $2, 'pms', 'channex_adoption_released', now(), 'migration',
               'migration', 'pms', 'channel_binding_claim', $3,
               $4::jsonb, '{}'::jsonb, '{}'::jsonb, 'security', 'restricted', FALSE)`,
      [
        randomUUID(),
        `channex-adoption-rollback:${input.manifestId}`,
        consumption.claimId,
        JSON.stringify({
          manifestId: input.manifestId,
          claimId: consumption.claimId,
          targetOrganizationId: consumption.targetOrganizationId,
          targetPropertyId: consumption.targetPropertyId,
          rollbackReasonSha256: reasonSha256,
          rollbackSubjectSha256: subjectSha256,
          approvalRecordIds: [...input.approvalRecordIds],
          approvalActorUserIds: approvals.map((row) => row.actorUserId),
          approvalPolicy: channexAdoptionApprovalPolicyEvidence(
            config,
            approvals.map((row) => row.actorUserId),
          ),
        }),
      ],
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return { manifestId: input.manifestId, claimId: consumption.claimId, replayed: false };
  } catch (error) {
    activeError = error;
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (manifestLocked) {
        for (const key of bindingLocks.reverse())
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [manifestLockKey]);
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      client.release(
        cleanupError === undefined
          ? undefined
          : cleanupError instanceof Error
            ? cleanupError
            : true,
      );
    } catch (error) {
      cleanupError ??= error;
    }
    if (activeError === undefined && cleanupError !== undefined) throw cleanupError;
  }
}

type StoredRollback = {
  claimId: string;
  rollbackReasonSha256: string;
  rollbackSubjectSha256: string;
};

async function readRollback(
  client: TransactionClient,
  manifestId: string,
): Promise<StoredRollback | null> {
  const result = await client.query<StoredRollback>(
    `SELECT claim_id::text AS "claimId", rollback_reason_sha256 AS "rollbackReasonSha256",
            rollback_subject_sha256 AS "rollbackSubjectSha256"
       FROM platform.channex_adoption_rollbacks WHERE manifest_id = $1::uuid FOR UPDATE`,
    [manifestId],
  );
  return result.rows[0] ?? null;
}

function assertRollbackReplay(
  rollback: StoredRollback,
  claimId: string,
  reasonSha256: string,
  subjectSha256: string,
): void {
  if (
    rollback.claimId !== claimId ||
    rollback.rollbackReasonSha256 !== reasonSha256 ||
    rollback.rollbackSubjectSha256 !== subjectSha256
  )
    rejectAdoption("ROLLBACK_PAYLOAD_DRIFT");
}

async function readSuccessfulConsumption(client: TransactionClient, manifestId: string) {
  const result = await client.query<{
    claimId: string;
    environment: ChannexAdoptionConsumerConfig["environment"];
    targetPropertyId: string;
    externalPropertyId: string;
    targetOrganizationId: string;
    signingKeyId: string;
  }>(
    `SELECT consumption.claim_id::text AS "claimId", consumption.environment,
            consumption.target_property_id::text AS "targetPropertyId",
            consumption.external_property_id::text AS "externalPropertyId",
            consumption.target_organization_id::text AS "targetOrganizationId",
            consumption.signing_key_id AS "signingKeyId"
       FROM platform.channex_adoption_manifest_consumptions consumption
      WHERE consumption.manifest_id = $1::uuid AND consumption.outcome = 'succeeded'
      FOR UPDATE OF consumption`,
    [manifestId],
  );
  if (result.rows.length !== 1 || !result.rows[0]?.claimId)
    rejectAdoption("ROLLBACK_MANIFEST_MISMATCH");
  return result.rows[0];
}

type RollbackApproval = {
  approvalRecordId: string;
  manifestId: string;
  environment: string;
  expiresAt: string;
  rollbackReasonSha256: string;
  authority: string;
  actorUserId: string;
  approvedAt: string;
  rollbackSubjectSha256: string;
  registryRevision: number;
  rowStateSha256: string;
  revoked: boolean;
  timestampsCanonical: boolean;
};

async function readRollbackApprovals(
  client: TransactionClient,
  ids: readonly [string, string],
): Promise<RollbackApproval[]> {
  const result = await client.query<RollbackApproval>(
    `SELECT approval.approval_record_id::text AS "approvalRecordId",
            approval.manifest_id::text AS "manifestId", approval.environment,
            to_char(approval.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",
            approval.rollback_reason_sha256 AS "rollbackReasonSha256", approval.authority,
            approval.actor_user_id::text AS "actorUserId",
            to_char(approval.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "approvedAt",
            approval.rollback_subject_sha256 AS "rollbackSubjectSha256",
            approval.registry_revision AS "registryRevision",
            approval.row_state_sha256 AS "rowStateSha256",
            revocation.approval_record_id IS NOT NULL AS revoked,
            approval.expires_at = date_trunc('milliseconds', approval.expires_at)
              AND approval.approved_at = date_trunc('milliseconds', approval.approved_at)
              AS "timestampsCanonical"
       FROM platform.channex_adoption_rollback_approval_records approval
       LEFT JOIN platform.channex_adoption_rollback_approval_revocations revocation
         USING (approval_record_id)
      WHERE approval.approval_record_id = ANY($1::uuid[])
      ORDER BY approval.authority`,
    [ids],
  );
  return result.rows;
}

async function verifyRollbackApprovals(
  client: TransactionClient,
  ids: readonly [string, string],
  expected: {
    manifestId: string;
    environment: string;
    expiresAt: string;
    reasonSha256: string;
    subjectSha256: string;
    signingKeyId: string;
    config: ChannexAdoptionConsumerConfig;
  },
) {
  const rows = await readRollbackApprovals(client, ids);
  if (rows.length !== 2) rejectAdoption("ROLLBACK_APPROVAL_MISMATCH");
  const now = (expected.config.now?.() ?? new Date()).toISOString();
  const machinePrincipals = new Set([
    expected.config.executionPrincipal,
    requiredPrincipal(expected.config.signingPrincipals, expected.signingKeyId),
  ]);
  if (machinePrincipals.size !== 2) rejectAdoption("ROLE_SEPARATION_VIOLATION");
  const approvalPrincipals: string[] = [];
  for (const [index, authority] of ["migration_owner", "security_owner"].entries()) {
    const row = rows[index];
    if (
      !row ||
      row.authority !== authority ||
      row.revoked ||
      !row.timestampsCanonical ||
      row.manifestId !== expected.manifestId ||
      row.environment !== expected.environment ||
      row.expiresAt !== expected.expiresAt ||
      row.rollbackReasonSha256 !== expected.reasonSha256 ||
      row.rollbackSubjectSha256 !== expected.subjectSha256 ||
      row.registryRevision < 1 ||
      !/^[0-9a-f]{64}$/.test(row.rowStateSha256) ||
      row.approvedAt > now ||
      now >= row.expiresAt
    )
      rejectAdoption("ROLLBACK_APPROVAL_MISMATCH");
    const approvalPrincipal = requiredPrincipal(
      expected.config.approvalPrincipals,
      row.actorUserId,
    );
    if (machinePrincipals.has(approvalPrincipal)) rejectAdoption("ROLE_SEPARATION_VIOLATION");
    approvalPrincipals.push(approvalPrincipal);
  }
  validateChannexAdoptionApprovalPolicy(
    expected.config,
    rows.map((row) => row.actorUserId),
    approvalPrincipals,
  );
}

function requiredPrincipal(principals: ReadonlyMap<string, string>, id: string): string {
  const principal = principals.get(id);
  if (!principal) rejectAdoption("ROLLBACK_PRINCIPAL_UNKNOWN");
  return principal;
}

function bindingLockKeys(propertyId: string, externalPropertyId: string): string[] {
  return [
    `channex.management:${propertyId}`,
    `channex.external-property:${externalPropertyId}`,
  ].sort();
}

function validTimestamp(value: string): boolean {
  return (
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value) &&
    new Date(value).toISOString() === value
  );
}
