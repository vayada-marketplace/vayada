import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { TokenVerifier } from "./verify.js";

export type AdminTransferBinding = {
  organizationId: string;
  actorMembershipId: string;
  targetMembershipId: string;
  workosUserId: string;
  workosOrgId: string;
  sessionId: string;
  /** Server-computed digest of the complete validated transfer, including revisions. */
  requestDigest: string;
};
const digest = (state: string) => createHash("sha256").update(state).digest("hex");
const values = (b: AdminTransferBinding) => [
  b.organizationId,
  b.actorMembershipId,
  b.targetMembershipId,
  b.workosUserId,
  b.workosOrgId,
  b.sessionId,
  b.requestDigest,
];
const bindingSql = `organization_id = $1 AND actor_membership_id = $2
  AND target_membership_id = $3 AND workos_user_id = $4 AND workos_org_id = $5
  AND request_digest = $7`;

/** Internal storage port: callers must authorize/lock the live admin and validate the intent. */
export async function createAdminTransferProof(client: PoolClient, binding: AdminTransferBinding) {
  const state = randomBytes(32).toString("base64url");
  const result = await client.query<{ id: string }>(
    `
    INSERT INTO identity.account_admin_transfer_proofs
      (organization_id, actor_membership_id, target_membership_id, workos_user_id,
       workos_org_id, source_session_id, request_digest, state_digest)
    SELECT $1, actor.id, target.id, $4, $5, $6, $7, $8
    FROM identity.organization_memberships actor
    JOIN identity.organization_memberships target ON target.organization_id = actor.organization_id
    WHERE actor.id = $2 AND target.id = $3 AND actor.organization_id = $1
    RETURNING id`,
    [...values(binding), digest(state)],
  );
  if (!result.rows[0]) throw new Error("Invalid transfer membership binding");
  return { id: result.rows[0].id, state };
}

/** Only call with the token returned by the server-side code exchange for this state.
 * This does not replace the browser session. The callback must retain/check the source session.
 */
export async function verifyAdminTransferProof(
  client: PoolClient,
  binding: AdminTransferBinding,
  state: string,
  accessToken: string,
  verifier: TokenVerifier,
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
  const session = await verifier(accessToken);
  if (
    session.workosUserId !== binding.workosUserId ||
    session.workosOrgId !== binding.workosOrgId ||
    !session.sessionId ||
    !Number.isSafeInteger(session.authenticatedAt) ||
    !session.authenticatedAt
  )
    return null;
  const result = await client.query<{ id: string }>(
    `
    WITH locked AS MATERIALIZED (
      SELECT * FROM identity.account_admin_transfer_proofs
      WHERE ${bindingSql} AND source_session_id = $6 AND state_digest = $8 FOR UPDATE
    ), eligible AS MATERIALIZED (
      SELECT id FROM locked WHERE verified_session_id IS NULL AND consumed_at IS NULL
        AND expires_at > clock_timestamp()
        AND $10 >= floor(extract(epoch FROM created_at))
        AND $10 <= extract(epoch FROM clock_timestamp())
        AND $11 > extract(epoch FROM clock_timestamp())
    )
    UPDATE identity.account_admin_transfer_proofs
    SET verified_session_id = $9, authenticated_at = to_timestamp($10)
    WHERE id IN (SELECT id FROM eligible) RETURNING id`,
    [
      ...values(binding),
      digest(state),
      session.sessionId,
      session.authenticatedAt,
      session.expiresAt,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/** Call inside the ownership transaction, using its PoolClient: rollback restores the proof.
 * sessionId is the current source browser session; the verified provider session is evidence only.
 */
export async function consumeAdminTransferProof(
  client: PoolClient,
  binding: AdminTransferBinding,
  proofId: string,
): Promise<boolean> {
  const result = await client.query(
    `
    WITH locked AS MATERIALIZED (
      SELECT * FROM identity.account_admin_transfer_proofs
      WHERE ${bindingSql} AND source_session_id = $6 AND id = $8 FOR UPDATE
    ), eligible AS MATERIALIZED (
      SELECT id FROM locked WHERE verified_session_id IS NOT NULL AND consumed_at IS NULL
        AND expires_at > clock_timestamp()
    )
    UPDATE identity.account_admin_transfer_proofs SET consumed_at = clock_timestamp()
    WHERE id IN (SELECT id FROM eligible) RETURNING id`,
    [...values(binding), proofId],
  );
  return result.rowCount === 1;
}
