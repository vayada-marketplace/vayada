import { verifyLegacyOwnerSetupApprovals } from "./legacyOwnerSetupApprovals.js";
import { verifyLegacyOwnerSetupSignature } from "./legacyOwnerSetupSignature.js";

/** Retains approval row locks in the caller's dedicated transaction. Not a
 * writer or complete command validation. Caller MUST roll back on any failure
 * and recheck expiry immediately before its eventual atomic write/receipt. */
export async function lockAndVerifyLegacyOwnerSetupApprovals(
  ...[client, input, policy, clock = () => new Date()]: Parameters<
    typeof verifyLegacyOwnerSetupApprovals
  >
): Promise<{ outcome: "approvals_locked_requires_command_validation"; executable: false }> {
  try {
    const captured = { ...input, verificationKeys: new Map(input.verificationKeys) };
    const trusted = {
      ...policy,
      signingPrincipals: new Map(policy.signingPrincipals),
      actors: structuredClone(new Map(policy.actors)),
      singleHumanDualAuthority: policy.singleHumanDualAuthority
        ? { ...policy.singleHumanDualAuthority }
        : undefined,
    };
    const { envelope } = verifyLegacyOwnerSetupSignature({ ...captured, now: clock() });
    // SAVEPOINT fails outside a transaction. Releasing OUR savepoint retains
    // locks until the outer transaction ends; no BEGIN/COMMIT is hidden here.
    await client.query("SAVEPOINT vay2017_setup_approval_locks");
    const settings = await client.query<{ allowed: boolean }>(
      `SELECT current_setting('transaction_isolation') = 'read committed'
        AND current_setting('lock_timeout') <> '0'
        AND current_setting('statement_timeout') <> '0' AS allowed`,
    );
    if (settings.rows.length !== 1 || settings.rows[0]?.allowed !== true) throw new Error();
    const ids = [envelope.migrationApprovalRecordId, envelope.securityApprovalRecordId].sort();
    const locked = await client.query<{ id: string }>(
      `SELECT approval_record_id::text AS id FROM platform.legacy_owner_approval_records
       WHERE approval_record_id = ANY($1::uuid[])
         AND NOT pg_catalog.row_security_active('platform.legacy_owner_approval_records'::regclass)
       ORDER BY approval_record_id FOR UPDATE`,
      [ids],
    );
    if (locked.rows.length !== 2 || locked.rows.some((row, i) => row.id !== ids[i]))
      throw new Error();
    // Separate READ COMMITTED statement: observe a revocation that committed
    // while FOR UPDATE waited for its FK's KEY SHARE lock. FOR NO KEY UPDATE
    // is insufficient: it would not exclude a new revocation's FK check.
    await verifyLegacyOwnerSetupApprovals(client, captured, trusted, clock);
    await client.query("RELEASE SAVEPOINT vay2017_setup_approval_locks");
    return { outcome: "approvals_locked_requires_command_validation", executable: false };
  } catch {
    throw new Error("LEGACY_OWNER_SETUP_APPROVAL_LOCKS_INVALID");
  }
}
