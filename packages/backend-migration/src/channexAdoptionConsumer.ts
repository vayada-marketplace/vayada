import { randomUUID, type KeyObject } from "node:crypto";
import type pg from "pg";

import {
  CHANNEX_ADOPTION_SIGNATURE_ALGORITHM,
  verifyChannexAdoptionManifest,
  type ChannexAdoptionManifest,
  type ParsedChannexAdoptionManifest,
} from "./channexAdoptionManifest.js";
import {
  ChannexAdoptionConsumptionError,
  rejectAdoption,
} from "./channexAdoptionConsumptionError.js";
import {
  verifyChannexAdoptionSourceEvidence,
  verifyChannexAdoptionTargetEvidence,
} from "./channexAdoptionEvidence.js";
import { classifyManifestConsumption } from "./channexAdoptionManifestCrypto.js";

type TransactionClient = Pick<pg.ClientBase, "query">;
type TransactionPool = { connect(): Promise<pg.PoolClient> };
type Environment = ChannexAdoptionManifest["environment"];
export const SINGLE_HUMAN_DUAL_AUTHORITY_DECISION = "VAY-1320@2026-09-12" as const;
export type ChannexAdoptionSingleHumanAuthority = {
  actorUserId: string;
  principal: string;
  decisionId: typeof SINGLE_HUMAN_DUAL_AUTHORITY_DECISION;
};
type VerificationServices = {
  verifySource(client: TransactionClient, manifest: ChannexAdoptionManifest): Promise<void>;
  verifyTarget(client: TransactionClient, manifest: ChannexAdoptionManifest): Promise<void>;
};

export type ChannexAdoptionConsumerConfig = {
  environment: Environment;
  executionPrincipal: string;
  allowedExecutionPrincipals: ReadonlySet<string>;
  verificationKeys: ReadonlyMap<string, KeyObject>;
  signingPrincipals: ReadonlyMap<string, string>;
  approvalPrincipals: ReadonlyMap<string, string>;
  singleHumanDualAuthority: ChannexAdoptionSingleHumanAuthority | null;
  now?: () => Date;
};

export type ChannexAdoptionConsumptionResult = {
  manifestId: string;
  claimId: string;
  replayed: boolean;
};

const defaultServices: VerificationServices = {
  verifySource: verifyChannexAdoptionSourceEvidence,
  verifyTarget: verifyChannexAdoptionTargetEvidence,
};

export async function consumeSignedChannexAdoptionManifest(
  pool: TransactionPool,
  input: { raw: string; detachedSignature: string; algorithm?: string },
  config: ChannexAdoptionConsumerConfig,
): Promise<ChannexAdoptionConsumptionResult> {
  return consumeVerifiedManifest(pool, input, config, defaultServices);
}

async function consumeVerifiedManifest(
  pool: TransactionPool,
  input: { raw: string; detachedSignature: string; algorithm?: string },
  config: ChannexAdoptionConsumerConfig,
  services: VerificationServices,
): Promise<ChannexAdoptionConsumptionResult> {
  assertExecutionPrincipal(config);
  const parsed = verifyChannexAdoptionManifest({
    raw: input.raw,
    detachedSignature: input.detachedSignature,
    algorithm: input.algorithm ?? CHANNEX_ADOPTION_SIGNATURE_ALGORITHM,
    verificationKeys: config.verificationKeys,
  });
  const client = await pool.connect();
  let transactionOpen = false;
  let manifestLocked = false;
  let activeError: unknown;
  const bindingLocks: string[] = [];
  const manifestLockKey = `channex.adoption.manifest:${parsed.manifest.manifestId}`;
  try {
    await acquireAdvisoryLock(client, manifestLockKey);
    manifestLocked = true;
    const existing = await readConsumption(client, parsed.manifest.manifestId);
    const classification = classifyManifestConsumption(existing, parsed.payloadSha256);
    if (classification === "exact_replay") {
      return {
        manifestId: parsed.manifest.manifestId,
        claimId: existing!.claimId!,
        replayed: true,
      };
    }
    if (classification === "payload_drift") rejectAdoption("MANIFEST_PAYLOAD_DRIFT");
    if (classification === "stored_failure") rejectAdoption("MANIFEST_STORED_FAILURE");

    for (const key of bindingLockKeys(parsed.manifest)) {
      await acquireAdvisoryLock(client, key);
      bindingLocks.push(key);
    }
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionOpen = true;
    const lockedExisting = await readConsumption(client, parsed.manifest.manifestId);
    const lockedClassification = classifyManifestConsumption(lockedExisting, parsed.payloadSha256);
    if (lockedClassification === "exact_replay") {
      await client.query("COMMIT");
      transactionOpen = false;
      return {
        manifestId: parsed.manifest.manifestId,
        claimId: lockedExisting!.claimId!,
        replayed: true,
      };
    }
    if (lockedClassification === "payload_drift") rejectAdoption("MANIFEST_PAYLOAD_DRIFT");
    if (lockedClassification === "stored_failure") rejectAdoption("MANIFEST_STORED_FAILURE");

    try {
      const now = config.now?.() ?? new Date();
      validateWindowAndEnvironment(parsed.manifest, config.environment, now);
      await verifyApprovals(client, parsed, config, now);
      await services.verifySource(client, parsed.manifest);
      await services.verifyTarget(client, parsed.manifest);
    } catch (error) {
      if (!(error instanceof ChannexAdoptionConsumptionError)) throw error;
      const failure = error;
      await writeConsumption(client, parsed, input.detachedSignature, null, failure.code);
      await writeAudit(client, parsed, null, failure.code, config);
      await client.query("COMMIT");
      transactionOpen = false;
      throw failure;
    }

    const claimId = randomUUID();
    await client.query(
      `INSERT INTO pms.channel_binding_claims
         (id, property_id, provider, external_property_id, claim_state, claim_source)
       VALUES ($1::uuid, $2::uuid, 'channex', $3, 'verified_non_active', 'adoption')`,
      [claimId, parsed.manifest.targetPropertyId, parsed.manifest.externalPropertyId],
    );
    await writeConsumption(client, parsed, input.detachedSignature, claimId, null);
    await writeAudit(client, parsed, claimId, null, config);
    await client.query("COMMIT");
    transactionOpen = false;
    return { manifestId: parsed.manifest.manifestId, claimId, replayed: false };
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

async function acquireAdvisoryLock(client: TransactionClient, key: string): Promise<void> {
  const result = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
    [key],
  );
  if (!result.rows[0]?.acquired) {
    throw Object.assign(new Error("Channex adoption lock is unavailable; retry later"), {
      code: "55P03",
    });
  }
}

function assertExecutionPrincipal(config: ChannexAdoptionConsumerConfig): void {
  if (!config.allowedExecutionPrincipals.has(config.executionPrincipal))
    rejectAdoption("EXECUTION_PRINCIPAL_FORBIDDEN");
}

function validateWindowAndEnvironment(
  manifest: ChannexAdoptionManifest,
  environment: Environment,
  now: Date,
): void {
  if (manifest.environment !== environment) rejectAdoption("TARGET_ENVIRONMENT_MISMATCH");
  const expectedSource = environment === "production" ? "preprod" : environment;
  if (manifest.sourceEnvironment !== expectedSource) rejectAdoption("SOURCE_ENVIRONMENT_MISMATCH");
  const current = now.toISOString();
  if (current < manifest.issuedAt) rejectAdoption("MANIFEST_NOT_YET_VALID");
  if (current >= manifest.expiresAt) rejectAdoption("MANIFEST_EXPIRED");
}

async function verifyApprovals(
  client: TransactionClient,
  parsed: ParsedChannexAdoptionManifest,
  config: ChannexAdoptionConsumerConfig,
  now: Date,
): Promise<void> {
  const ids = parsed.manifest.approvalEvidence.map((approval) => approval.approvalRecordId);
  const result = await client.query<{
    approvalRecordId: string;
    manifestId: string;
    environment: string;
    expiresAt: string;
    authority: string;
    actorUserId: string;
    approvedAt: string;
    approvalSubjectSha256: string;
    registryRevision: number;
    rowStateSha256: string;
    revoked: boolean;
    timestampsCanonical: boolean;
  }>(
    `SELECT approval.approval_record_id::text AS "approvalRecordId",
            approval.manifest_id::text AS "manifestId", approval.environment,
            to_char(approval.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",
            approval.authority, approval.actor_user_id::text AS "actorUserId",
            to_char(approval.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "approvedAt",
            approval.approval_subject_sha256 AS "approvalSubjectSha256",
            approval.registry_revision AS "registryRevision",
            approval.row_state_sha256 AS "rowStateSha256",
            revocation.approval_record_id IS NOT NULL AS revoked,
            approval.expires_at = date_trunc('milliseconds', approval.expires_at)
              AND approval.approved_at = date_trunc('milliseconds', approval.approved_at)
              AS "timestampsCanonical"
       FROM platform.channex_adoption_approval_records approval
       LEFT JOIN platform.channex_adoption_approval_revocations revocation
         USING (approval_record_id)
      WHERE approval.approval_record_id = ANY($1::uuid[])
      ORDER BY approval.authority`,
    [ids],
  );
  if (result.rows.length !== 2) rejectAdoption("APPROVAL_EVIDENCE_MISMATCH");
  const byId = new Map(result.rows.map((row) => [row.approvalRecordId, row]));
  const machinePrincipals = new Set<string>([
    config.executionPrincipal,
    requiredPrincipal(
      config.signingPrincipals,
      parsed.manifest.signingKeyId,
      "SIGNING_PRINCIPAL_UNKNOWN",
    ),
  ]);
  if (machinePrincipals.size !== 2) rejectAdoption("ROLE_SEPARATION_VIOLATION");
  const approvalPrincipals: string[] = [];
  for (const signed of parsed.manifest.approvalEvidence) {
    const actual = byId.get(signed.approvalRecordId);
    if (
      !actual ||
      actual.revoked ||
      !actual.timestampsCanonical ||
      actual.approvedAt > now.toISOString() ||
      actual.manifestId !== parsed.manifest.manifestId ||
      actual.environment !== parsed.manifest.environment ||
      actual.expiresAt !== parsed.manifest.expiresAt ||
      actual.authority !== signed.authority ||
      actual.actorUserId !== signed.actorUserId ||
      actual.approvedAt !== signed.approvedAt ||
      actual.approvalSubjectSha256 !== parsed.approvalSubjectSha256 ||
      actual.approvalSubjectSha256 !== signed.approvalSubjectSha256 ||
      actual.registryRevision !== signed.registryRevision ||
      actual.rowStateSha256 !== signed.rowStateSha256
    )
      rejectAdoption("APPROVAL_EVIDENCE_MISMATCH");
    const approvalPrincipal = requiredPrincipal(
      config.approvalPrincipals,
      signed.actorUserId,
      "APPROVAL_PRINCIPAL_UNKNOWN",
    );
    if (machinePrincipals.has(approvalPrincipal)) rejectAdoption("ROLE_SEPARATION_VIOLATION");
    approvalPrincipals.push(approvalPrincipal);
  }
  validateChannexAdoptionApprovalPolicy(
    config,
    parsed.manifest.approvalEvidence.map((row) => row.actorUserId),
    approvalPrincipals,
  );
}

export function channexAdoptionApprovalPolicyEvidence(
  config: ChannexAdoptionConsumerConfig,
  actorUserIds: readonly string[],
) {
  const actorId = new Set(actorUserIds).size === 1 ? actorUserIds[0]! : null;
  const authorization = config.singleHumanDualAuthority;
  return actorId
    ? {
        name: "single_human_dual_authority.v1",
        decisionId: authorization?.actorUserId === actorId ? authorization.decisionId : null,
      }
    : { name: "independent_humans.v1", decisionId: null };
}

export function validateChannexAdoptionApprovalPolicy(
  config: ChannexAdoptionConsumerConfig,
  actorUserIds: readonly string[],
  approvalPrincipals: readonly string[],
): void {
  if (new Set(actorUserIds).size === 2) {
    if (new Set(approvalPrincipals).size !== 2) rejectAdoption("ROLE_SEPARATION_VIOLATION");
    return;
  }
  const actorUserId = actorUserIds[0]!;
  const authorization = config.singleHumanDualAuthority;
  if (
    !authorization ||
    authorization.decisionId !== SINGLE_HUMAN_DUAL_AUTHORITY_DECISION ||
    authorization.actorUserId !== actorUserId ||
    approvalPrincipals.some((principal) => principal !== authorization.principal)
  )
    rejectAdoption("SINGLE_HUMAN_DUAL_AUTHORITY_FORBIDDEN");
}

function requiredPrincipal(
  principals: ReadonlyMap<string, string>,
  id: string,
  code: string,
): string {
  const principal = principals.get(id);
  if (!principal) rejectAdoption(code);
  return principal;
}

async function readConsumption(client: TransactionClient, manifestId: string) {
  const result = await client.query<{
    payloadSha256: string;
    outcome: "succeeded" | "failed";
    claimId: string | null;
  }>(
    `SELECT payload_sha256 AS "payloadSha256", outcome, claim_id::text AS "claimId"
       FROM platform.channex_adoption_manifest_consumptions
      WHERE manifest_id = $1::uuid FOR UPDATE`,
    [manifestId],
  );
  if (result.rows.length > 1) rejectAdoption("MANIFEST_CONSUMPTION_CORRUPT");
  return result.rows[0] ?? null;
}

function bindingLockKeys(manifest: ChannexAdoptionManifest): string[] {
  return [
    `channex.management:${manifest.targetPropertyId}`,
    `channex.external-property:${manifest.externalPropertyId}`,
  ].sort();
}

async function writeConsumption(
  client: TransactionClient,
  parsed: ParsedChannexAdoptionManifest,
  detachedSignature: string,
  claimId: string | null,
  failureCode: string | null,
) {
  const manifest = parsed.manifest;
  await client.query(
    `INSERT INTO platform.channex_adoption_manifest_consumptions
       (manifest_id, payload_sha256, contract_version, environment, source_environment,
        source_run_id, legacy_pms_hotel_id, external_property_id, target_property_id,
        target_organization_id, signing_key_id, signature_algorithm, detached_signature,
        signature_verified, outcome, claim_id, failure_code)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
             $11, $12, $13, TRUE, $14, $15::uuid, $16)`,
    [
      manifest.manifestId,
      parsed.payloadSha256,
      manifest.contractVersion,
      manifest.environment,
      manifest.sourceEnvironment,
      manifest.sourceRunId,
      manifest.legacyPmsHotelId,
      manifest.externalPropertyId,
      manifest.targetPropertyId,
      manifest.targetOrganizationId,
      manifest.signingKeyId,
      CHANNEX_ADOPTION_SIGNATURE_ALGORITHM,
      Buffer.from(detachedSignature, "base64url"),
      failureCode ? "failed" : "succeeded",
      claimId,
      failureCode,
    ],
  );
}

async function writeAudit(
  client: TransactionClient,
  parsed: ParsedChannexAdoptionManifest,
  claimId: string | null,
  failureCode: string | null,
  config: ChannexAdoptionConsumerConfig,
) {
  const manifest = parsed.manifest;
  await client.query(
    `INSERT INTO platform.product_audit_events
       (id, audit_key, product, action, occurred_at, tenant_scope,
        actor_type, target_resource_product, target_resource_type, target_resource_id,
        redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope, ai_visible)
     VALUES ($1::uuid, $2, 'pms', $3, now(), 'migration',
             'migration', 'pms', $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
             'security', 'restricted', FALSE)`,
    [
      randomUUID(),
      `channex-adoption:${manifest.manifestId}`,
      failureCode ? "channex_adoption_rejected" : "channex_adoption_reserved",
      claimId ? "channel_binding_claim" : "channex_adoption_manifest",
      claimId ?? manifest.manifestId,
      JSON.stringify({
        manifestId: manifest.manifestId,
        payloadSha256: parsed.payloadSha256,
        sourceRunId: manifest.sourceRunId,
        sourceSchemaRevision: manifest.sourceSchemaRevision,
        sourceEvidenceSha256: manifest.sourceEvidenceSha256,
        signingKeyId: manifest.signingKeyId,
        signatureAlgorithm: CHANNEX_ADOPTION_SIGNATURE_ALGORITHM,
        signatureVerified: true,
        issuedAt: manifest.issuedAt,
        expiresAt: manifest.expiresAt,
        legacyPmsHotelId: manifest.legacyPmsHotelId,
        externalPropertyId: manifest.externalPropertyId,
        approvalRecordIds: manifest.approvalEvidence.map((row) => row.approvalRecordId),
        approvalPolicy: channexAdoptionApprovalPolicyEvidence(
          config,
          manifest.approvalEvidence.map((row) => row.actorUserId),
        ),
        targetOrganizationId: manifest.targetOrganizationId,
        targetPropertyId: manifest.targetPropertyId,
        legacyEvidence: {
          hotel: {
            rowOrdinal: manifest.legacyEvidence.hotel.rowOrdinal,
            rowChecksumSha256: manifest.legacyEvidence.hotel.rowChecksumSha256,
          },
          connection: manifest.legacyEvidence.connection,
          roomTypeMappings: manifest.legacyEvidence.roomTypeMappings,
          ratePlanMappings: manifest.legacyEvidence.ratePlanMappings,
          bookingMappings: manifest.legacyEvidence.bookingMappings,
          bookings: manifest.legacyEvidence.bookings,
        },
        targetEvidence: manifest.targetEvidence,
        preState: { bindingClaims: manifest.targetEvidence.bindingClaims },
        outcome: failureCode ? "failed" : "succeeded",
        failureCode,
      }),
      JSON.stringify({
        approvalActorUserIds: manifest.approvalEvidence.map((row) => row.actorUserId),
      }),
      JSON.stringify({ contractVersion: manifest.contractVersion }),
    ],
  );
}
