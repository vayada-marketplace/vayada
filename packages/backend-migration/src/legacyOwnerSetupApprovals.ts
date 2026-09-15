import { createHash } from "node:crypto";
import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import type { verifyLegacyOwnerApprovals } from "./legacyOwnerApprovalRegistry.js";
import { verifyLegacyOwnerSetupSignature } from "./legacyOwnerSetupSignature.js";

export const hashLegacyOwnerSetupEnvelope = (canonicalPayload: string): string =>
  createHash("sha256")
    .update("vayada:legacy-owner-internal-setup:v1\0approval-envelope\0")
    .update(canonicalPayload)
    .digest("hex");

/** Current registry snapshot, NOT write authority. Caller must retain its own
 * independently authorized approval/revocation serialization through later writes.
 * This helper acquires no locks, creates no approvals and grants no access. */
export async function verifyLegacyOwnerSetupApprovals(
  client: AdoptionQueryClient,
  input: Omit<Parameters<typeof verifyLegacyOwnerSetupSignature>[0], "now">,
  policy: Parameters<typeof verifyLegacyOwnerApprovals>[2],
  clock: () => Date = () => new Date(),
): Promise<{ outcome: "approvals_match_requires_command_validation"; executable: false }> {
  const fail = (): never => {
    throw new Error("LEGACY_OWNER_SETUP_APPROVALS_INVALID");
  };
  try {
    const captured = { ...input, verificationKeys: new Map(input.verificationKeys) };
    const initialTime = clock();
    const { envelope } = verifyLegacyOwnerSetupSignature({ ...captured, now: initialTime });
    const signingPrincipal = policy.signingPrincipals.get(envelope.signingKeyId);
    const executionPrincipal = policy.executionPrincipal;
    if (
      !signingPrincipal?.trim() ||
      !executionPrincipal.trim() ||
      signingPrincipal === executionPrincipal
    )
      return fail();
    const actors = new Map([...policy.actors].map(([id, actor]) => [id, structuredClone(actor)]));
    const dual = policy.singleHumanDualAuthority
      ? { ...policy.singleHumanDualAuthority }
      : undefined;
    const ids = [envelope.migrationApprovalRecordId, envelope.securityApprovalRecordId];
    const hash = hashLegacyOwnerSetupEnvelope(captured.canonicalPayload);
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
        a.contract_version AS "contractVersion", a.environment,
        a.envelope_sha256 AS "envelopeSha256", a.authority, a.actor_user_id::text AS "actorUserId",
        a.approved_at >= $2::timestamptz AND a.approved_at <= $3::timestamptz
          AND a.expires_at = $4::timestamptz AS "timeValid",
        r.approval_record_id IS NOT NULL AS revoked
       FROM platform.legacy_owner_approval_records a
       LEFT JOIN platform.legacy_owner_approval_revocations r USING (approval_record_id)
       WHERE a.approval_record_id = ANY($1::uuid[])
         AND NOT pg_catalog.row_security_active('platform.legacy_owner_approval_records'::regclass)
         AND NOT pg_catalog.row_security_active('platform.legacy_owner_approval_revocations'::regclass)`,
      [ids, envelope.issuedAt, initialTime.toISOString(), envelope.expiresAt],
    );
    if (result.rows.length !== 2) return fail();
    const authorities = ["migration_owner", "security_owner"] as const;
    const principals: string[] = [];
    for (const [index, id] of ids.entries()) {
      const matches = result.rows.filter((row) => row.id === id);
      const row = matches[0];
      const actor = row && actors.get(row.actorUserId);
      if (
        matches.length !== 1 ||
        !row ||
        row.revoked !== false ||
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
    verifyLegacyOwnerSetupSignature({ ...captured, now: clock() });
    return { outcome: "approvals_match_requires_command_validation", executable: false };
  } catch {
    return fail();
  }
}
