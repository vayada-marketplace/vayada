import {
  readLegacyOwnershipTargetRow,
  type AdoptionQueryClient,
} from "./channexAdoptionTargetRows.js";

export type LegacyOwnerIdentityEvidence = {
  userId: string;
  organizationId: string;
  externalIdentityId: string;
  externalIdentitySha256: string;
  workosUserId: string;
  workosOrgId: string;
};
/** Structural subset of backend-auth VerifiedSession; never populate from request JSON. */
export type VerifiedLegacyOwnerSession = {
  workosUserId: string;
  workosOrgId: string | null;
  expiresAt: number;
};

/**
 * Check database bindings of an ALREADY verified WorkOS session. This does not
 * validate JWT signatures, issuer/audience, or provider-side session revocation.
 * Caller must use backend-auth verification, authenticated approval evidence,
 * and the same REPEATABLE READ/SERIALIZABLE transaction as ownership checks,
 * or READ COMMITTED with retained relation fences over all ownership/identity rows.
 * Pending/suspended migration state still needs the separate PMS disposition;
 * identity_matches grants no access and cannot approve Marketplace or a claim.
 */
export async function verifyLegacyCurrentOwnerIdentity(
  client: AdoptionQueryClient,
  expected: LegacyOwnerIdentityEvidence,
  session: VerifiedLegacyOwnerSession,
): Promise<
  | {
      outcome: "identity_matches";
      userStatus: "active" | "pending";
      organizationStatus: "active" | "suspended";
    }
  | { outcome: "blocked"; reason: string }
> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (
    ![expected.userId, expected.organizationId, expected.externalIdentityId].every((id) =>
      uuid.test(id),
    ) ||
    !/^[0-9a-f]{64}$/.test(expected.externalIdentitySha256) ||
    !expected.workosUserId?.trim() ||
    !expected.workosOrgId?.trim() ||
    session.workosUserId !== expected.workosUserId ||
    session.workosOrgId !== expected.workosOrgId ||
    !Number.isSafeInteger(session.expiresAt) ||
    session.expiresAt <= Math.floor(Date.now() / 1000)
  )
    return { outcome: "blocked", reason: "identity_input_mismatch" };
  const identities = await client.query<{
    id: string;
    userId: string;
    providerUserId: string | null;
    userStatus: string | null;
  }>(
    `SELECT e.id::text, e.user_id::text AS "userId", e.provider_user_id AS "providerUserId", u.status AS "userStatus"
    FROM identity.external_identities e LEFT JOIN identity.users u ON u.id = e.user_id
    WHERE e.provider = 'workos' AND (e.provider_user_id = $1 OR e.user_id = $2::uuid)
    ORDER BY e.id`,
    [expected.workosUserId, expected.userId],
  );
  const identity = identities.rows[0];
  if (
    identities.rows.length !== 1 ||
    !identity ||
    identity.id !== expected.externalIdentityId ||
    identity.userId !== expected.userId ||
    identity.providerUserId !== expected.workosUserId ||
    (identity.userStatus !== "active" && identity.userStatus !== "pending")
  )
    return { outcome: "blocked", reason: "current_identity_conflict" };
  const organizations = await client.query<{
    id: string;
    workosOrgId: string | null;
    kind: string;
    status: string;
  }>(
    `SELECT id::text, workos_org_id AS "workosOrgId", kind, status FROM identity.organizations
    WHERE id = $1::uuid OR workos_org_id = $2 ORDER BY id`,
    [expected.organizationId, expected.workosOrgId],
  );
  const organization = organizations.rows[0];
  if (
    organizations.rows.length !== 1 ||
    !organization ||
    organization.id !== expected.organizationId ||
    organization.workosOrgId !== expected.workosOrgId ||
    organization.kind !== "hotel_group" ||
    (organization.status !== "active" && organization.status !== "suspended")
  )
    return { outcome: "blocked", reason: "current_organization_conflict" };
  const fingerprint = await readLegacyOwnershipTargetRow(
    client,
    "identity.external_identities",
    expected.externalIdentityId,
  );
  if (fingerprint.rowStateSha256 !== expected.externalIdentitySha256)
    return { outcome: "blocked", reason: "current_identity_drift" };
  // A slow read must not extend an otherwise expired verified session.
  if (session.expiresAt <= Math.floor(Date.now() / 1000))
    return { outcome: "blocked", reason: "identity_input_mismatch" };
  return {
    outcome: "identity_matches",
    userStatus: identity.userStatus,
    organizationStatus: organization.status,
  };
}
