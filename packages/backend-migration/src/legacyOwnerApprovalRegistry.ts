import { createHash } from "node:crypto";
import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import { verifyLegacyOwnerApprovalEnvelope } from "./legacyOwnerApprovalEnvelope.js";

type Authority = "migration_owner" | "security_owner";
type Verification = Parameters<typeof verifyLegacyOwnerApprovalEnvelope>[0];
export const hashLegacyOwnerApprovalEnvelope = (canonicalPayload: string): string =>
  createHash("sha256")
    .update("vayada:legacy-pms-owner-evidence:v1\0approval-envelope\0")
    .update(canonicalPayload)
    .digest("hex");

/**
 * Signature + current registry verification, NOT eligibility or execution.
 * Caller supplies trusted keys/principal policy, fresh time and the same locked
 * transaction as evidence checks. Recheck before mutation; no cached approval.
 * This does not establish locks, write records, grant access or transition claims.
 */
export async function verifyLegacyOwnerApprovals(
  client: AdoptionQueryClient,
  input: Omit<Verification, "now">,
  policy: {
    executionPrincipal: string;
    signingPrincipals: ReadonlyMap<string, string>;
    actors: ReadonlyMap<string, { principal: string; authorities: readonly Authority[] }>;
    singleHumanDualAuthority?: { actorUserId: string; decisionId: string };
  },
  clock: () => Date = () => new Date(),
): Promise<{ outcome: "approvals_match_requires_eligibility" }> {
  const captured = {
    ...input,
    evidence: structuredClone(input.evidence),
    verificationKeys: new Map(input.verificationKeys),
  };
  const initialTime = clock();
  const { envelope } = verifyLegacyOwnerApprovalEnvelope({ ...captured, now: initialTime });
  const fail = (): never => {
    throw new Error("Legacy owner approval registry mismatch");
  };
  const signingPrincipal = policy.signingPrincipals.get(envelope.signingKeyId);
  if (
    !signingPrincipal?.trim() ||
    !policy.executionPrincipal.trim() ||
    signingPrincipal === policy.executionPrincipal
  )
    return fail();
  // Capture policy and clock values before awaiting database reads.
  const actors = new Map([...policy.actors].map(([id, actor]) => [id, structuredClone(actor)]));
  const executionPrincipal = policy.executionPrincipal;
  const dual = policy.singleHumanDualAuthority ? { ...policy.singleHumanDualAuthority } : undefined;
  const now = initialTime.toISOString();
  const hash = hashLegacyOwnerApprovalEnvelope(captured.canonicalPayload);
  const ids = [envelope.migrationApprovalRecordId, envelope.securityApprovalRecordId];
  const result = await client.query<{
    id: string;
    commandId: string;
    contractVersion: string;
    environment: string;
    envelopeSha256: string;
    authority: string;
    actorUserId: string;
    timeValid: boolean;
    revoked: boolean;
  }>(
    `SELECT a.approval_record_id::text AS id, a.command_id::text AS "commandId",
      a.contract_version AS "contractVersion", a.environment, a.envelope_sha256 AS "envelopeSha256",
      a.authority, a.actor_user_id::text AS "actorUserId",
      a.approved_at >= $2::timestamptz AND a.approved_at <= $3::timestamptz
        AND a.expires_at = $4::timestamptz AS "timeValid",
      r.approval_record_id IS NOT NULL AS revoked
    FROM platform.legacy_owner_approval_records a
    LEFT JOIN platform.legacy_owner_approval_revocations r USING (approval_record_id)
    WHERE a.approval_record_id = ANY($1::uuid[])`,
    [ids, envelope.issuedAt, now, envelope.expiresAt],
  );
  if (result.rows.length !== 2) return fail();
  const authorities: Authority[] = ["migration_owner", "security_owner"];
  const principals: string[] = [];
  for (const [index, id] of ids.entries()) {
    const matches = result.rows.filter((row) => row.id === id);
    const row = matches[0];
    const actor = row && actors.get(row.actorUserId);
    if (
      matches.length !== 1 ||
      !row ||
      row.revoked ||
      row.commandId !== envelope.commandId ||
      row.contractVersion !== envelope.contractVersion ||
      row.environment !== envelope.environment ||
      row.envelopeSha256 !== hash ||
      row.authority !== authorities[index] ||
      row.timeValid !== true ||
      !actor?.principal.trim() ||
      !actor.authorities.includes(authorities[index]!) ||
      actor.principal === signingPrincipal ||
      actor.principal === executionPrincipal
    )
      return fail();
    principals.push(actor.principal);
  }
  if (principals[0] === principals[1]) {
    const actor = result.rows[0]!.actorUserId;
    if (
      !dual?.decisionId.trim() ||
      dual.actorUserId !== actor ||
      result.rows.some((row) => row.actorUserId !== actor)
    )
      return fail();
  }
  verifyLegacyOwnerApprovalEnvelope({ ...captured, now: clock() });
  return { outcome: "approvals_match_requires_eligibility" };
}
