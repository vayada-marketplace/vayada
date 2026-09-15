import { createHash } from "node:crypto";
import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import type { verifyLegacyOwnerApprovals } from "./legacyOwnerApprovalRegistry.js";
import { verifyLegacyHistoricalBindingEnvelope } from "./legacyHistoricalBindingEnvelope.js";

export const hashLegacyHistoricalBindingEnvelope = (payload: string) =>
  createHash("sha256")
    .update("vayada:legacy-historical-binding-transition:v1\0approval-envelope\0")
    .update(payload)
    .digest("hex");

/** Caller owns a dedicated READ COMMITTED transaction and MUST roll back on any
 * failure. Retains ordered approval locks; does not validate eligibility, write
 * claims or grant authority. Acquire these before target locks; recheck expiry
 * before the eventual atomic mutation. Principals/keys/policy are trusted inputs. */
export async function lockAndVerifyLegacyHistoricalBindingApprovals(
  client: AdoptionQueryClient,
  input: Omit<Parameters<typeof verifyLegacyHistoricalBindingEnvelope>[0], "now">,
  policy: Parameters<typeof verifyLegacyOwnerApprovals>[2],
  clock: () => Date = () => new Date(),
): Promise<{ outcome: "approvals_locked_requires_eligibility"; executable: false }> {
  try {
    const captured = {
      ...input,
      evidence: structuredClone(input.evidence),
      verificationKeys: new Map(input.verificationKeys),
    };
    const { envelope } = verifyLegacyHistoricalBindingEnvelope({ ...captured, now: clock() });
    const signer = policy.signingPrincipals.get(envelope.signingKeyId);
    const executor = policy.executionPrincipal;
    const actors = structuredClone(new Map(policy.actors));
    const dual = policy.singleHumanDualAuthority
      ? { ...policy.singleHumanDualAuthority }
      : undefined;
    if (!signer?.trim() || !executor.trim() || signer === executor) throw new Error();
    const ids = [envelope.migrationApprovalRecordId, envelope.securityApprovalRecordId];
    // SAVEPOINT refuses autocommit. Releasing it retains locks in the outer transaction.
    await client.query("SAVEPOINT vay2017_historical_approvals");
    await client.query("SET LOCAL search_path = pg_catalog");
    const settings = await client.query<{ allowed: boolean }>(`SELECT
      current_setting('transaction_isolation') = 'read committed'
      AND current_setting('lock_timeout') <> '0' AND current_setting('statement_timeout') <> '0' AS allowed`);
    if (settings.rows.length !== 1 || settings.rows[0]?.allowed !== true) throw new Error();
    const sorted = [...ids].sort();
    const locked = await client.query<{ id: string }>(
      `SELECT approval_record_id::text AS id
      FROM platform.legacy_owner_approval_records WHERE approval_record_id = ANY($1::uuid[])
      AND NOT pg_catalog.row_security_active('platform.legacy_owner_approval_records'::regclass)
      ORDER BY approval_record_id FOR UPDATE`,
      [sorted],
    );
    if (locked.rows.length !== 2 || locked.rows.some((row, i) => row.id !== sorted[i]))
      throw new Error();
    // Fresh statement snapshot sees revocations committed while FOR UPDATE waited
    // for their FK KEY SHARE. A weaker row lock would not fence new revocations.
    const now = clock();
    verifyLegacyHistoricalBindingEnvelope({ ...captured, now });
    const result = await client.query<{
      id: string;
      commandId: string;
      version: string;
      environment: string;
      hash: string;
      authority: "migration_owner" | "security_owner";
      actorId: string;
      valid: boolean;
      revoked: boolean;
    }>(
      `SELECT a.approval_record_id::text AS id, a.command_id::text AS "commandId",
      a.contract_version AS version, a.environment, a.envelope_sha256 AS hash, a.authority,
      a.actor_user_id::text AS "actorId", a.approved_at >= $2::timestamptz
      AND a.approved_at <= $3::timestamptz AND a.expires_at = $4::timestamptz AS valid,
      r.approval_record_id IS NOT NULL AS revoked FROM platform.legacy_owner_approval_records a
      LEFT JOIN platform.legacy_owner_approval_revocations r USING (approval_record_id)
      WHERE a.approval_record_id = ANY($1::uuid[])
      AND NOT pg_catalog.row_security_active('platform.legacy_owner_approval_records'::regclass)
      AND NOT pg_catalog.row_security_active('platform.legacy_owner_approval_revocations'::regclass)`,
      [ids, envelope.issuedAt, now.toISOString(), envelope.expiresAt],
    );
    if (result.rows.length !== 2) throw new Error();
    const principals: string[] = [];
    for (const [i, id] of ids.entries()) {
      const matches = result.rows.filter((row) => row.id === id);
      const row = matches[0];
      const actor = row && actors.get(row.actorId);
      if (
        matches.length !== 1 ||
        !row ||
        row.version !== envelope.contractVersion ||
        row.commandId !== envelope.commandId ||
        row.environment !== envelope.environment ||
        row.hash !== hashLegacyHistoricalBindingEnvelope(captured.canonicalPayload) ||
        row.authority !== ["migration_owner", "security_owner"][i] ||
        row.valid !== true ||
        row.revoked !== false ||
        !actor?.principal.trim() ||
        !actor.authorities.includes(row.authority) ||
        actor.principal === signer ||
        actor.principal === executor
      )
        throw new Error();
      principals.push(actor.principal);
    }
    if (
      principals[0] === principals[1] &&
      (!dual?.decisionId.trim() || result.rows.some((row) => row.actorId !== dual.actorUserId))
    )
      throw new Error();
    verifyLegacyHistoricalBindingEnvelope({ ...captured, now: clock() });
    await client.query("RELEASE SAVEPOINT vay2017_historical_approvals");
    return { outcome: "approvals_locked_requires_eligibility", executable: false };
  } catch {
    throw new Error("LEGACY_HISTORICAL_BINDING_APPROVALS_INVALID");
  }
}
