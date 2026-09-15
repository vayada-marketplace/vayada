import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import { OWNER_EMAIL_INDEX_EXPRESSION } from "./legacyOwnerEmailIndexPlan.js";
import { verifyLegacyOwnerEmailIndex } from "./legacyOwnerEmailIndexVerification.js";
import { parseLegacyOwnerSetupCommand } from "./legacyOwnerSetupCommand.js";

/** Absence guard, NOT an authorized executor. Caller independently authenticates
 * database identity, evidence, eight-email scope and approvals before calling.
 * Use a dedicated transaction; roll back ALL on failure and retain these locks
 * through checkpoint/commit. Resolve authenticated exact replay BEFORE this guard.
 * Locks briefly block ALL writes to both identity tables; production use needs
 * a separately reviewed bounded execution window. Never call providers here. */
export async function lockAndCheckLegacyOwnerSetupTargets(
  client: AdoptionQueryClient,
  payload: string,
  expected: Parameters<typeof parseLegacyOwnerSetupCommand>[1],
  emailSha256: readonly string[],
  clock: () => Date = () => new Date(),
): Promise<{ outcome: "targets_absent_locked_requires_authorized_write"; executable: false }> {
  let savepoint = false;
  try {
    const captured = structuredClone(expected);
    const scope = [...emailSha256];
    const { command } = parseLegacyOwnerSetupCommand(payload, captured, clock());
    await client.query("SAVEPOINT vay2017_setup_target_locks");
    savepoint = true;
    const settings = await client.query<{ allowed: boolean }>(`SELECT
      current_setting('transaction_isolation') = 'read committed'
      AND current_setting('lock_timeout') <> '0'
      AND current_setting('statement_timeout') <> '0' AS allowed`);
    if (settings.rows.length !== 1 || settings.rows[0]?.allowed !== true) throw new Error();
    await client.query("SET LOCAL search_path = pg_catalog");
    // Existing writers use differing orders. Never wait with a partial lock set.
    await client.query(`LOCK TABLE identity.external_identities, identity.users
      IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    await verifyLegacyOwnerEmailIndex(client, scope);
    const visibility = await client.query<{ allowed: boolean }>(`SELECT
      NOT row_security_active('identity.users'::regclass)
      AND NOT row_security_active('identity.external_identities'::regclass)
      AND c.relkind = 'r' AND a.atttypid = 'pg_catalog.text'::regtype
      AND a.attcollation = 'pg_catalog.default'::regcollation
      AND NOT a.attisdropped AND a.attgenerated = '' AS allowed
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.oid = 'identity.external_identities'::regclass
      AND a.attname = 'provider_email'`);
    if (visibility.rows.length !== 1 || visibility.rows[0]?.allowed !== true) throw new Error();
    const normalized = await client.query<{ hash: string }>(
      `SELECT ${OWNER_EMAIL_INDEX_EXPRESSION} AS hash FROM unnest($1::text[]) AS v(email)`,
      [command.owners.map((owner) => owner.email)],
    );
    const hashes = normalized.rows.map((row) => row.hash);
    if (
      hashes.length !== command.owners.length ||
      new Set(hashes).size !== hashes.length ||
      hashes.some((hash) => !scope.includes(hash))
    )
      throw new Error();
    const conflicts = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM identity.users
        WHERE id = ANY($1::uuid[]) OR ${OWNER_EMAIL_INDEX_EXPRESSION} = ANY($2::text[])
      ) OR EXISTS (
        SELECT 1 FROM (SELECT user_id, provider_email AS email
          FROM identity.external_identities) AS external
        WHERE user_id = ANY($1::uuid[]) OR ${OWNER_EMAIL_INDEX_EXPRESSION} = ANY($2::text[])
      ) AS present`,
      [command.owners.map((owner) => owner.ownerId), hashes],
    );
    if (conflicts.rows.length !== 1 || conflicts.rows[0]?.present !== false) throw new Error();
    // Database checks may consume the evidence/command lifetime.
    parseLegacyOwnerSetupCommand(payload, captured, clock());
    await client.query("RELEASE SAVEPOINT vay2017_setup_target_locks");
    return { outcome: "targets_absent_locked_requires_authorized_write", executable: false };
  } catch {
    if (savepoint) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT vay2017_setup_target_locks");
        await client.query("RELEASE SAVEPOINT vay2017_setup_target_locks");
      } catch {
        // Unknown transaction state: caller must discard the connection.
        throw new Error("LEGACY_OWNER_SETUP_TARGET_LOCKS_ROLLBACK_FAILED");
      }
    }
    throw new Error("LEGACY_OWNER_SETUP_TARGET_LOCKS_INVALID");
  }
}
