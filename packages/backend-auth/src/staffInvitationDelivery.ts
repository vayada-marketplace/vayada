import pg from "pg";

import type { RepositoryConfig } from "./repository.js";

export type StaffInvitationProviderRole = "hotel_admin" | "hotel_member";

export type StaffInvitationDeliveryClaim = {
  invitationId: string;
  email: string;
  organizationId: string;
  inviterUserId: string;
  roleSlug: StaffInvitationProviderRole;
};

export type StaffInvitationProviderResponse = {
  invitationId: string;
  email: string;
  organizationId: string;
  inviterUserId: string;
  roleSlug: StaffInvitationProviderRole;
  state: "pending";
  expiresAt: string;
};

export interface StaffInvitationProvider {
  sendInvitation(
    input: StaffInvitationDeliveryClaim & { expiresInDays: 7 },
  ): Promise<StaffInvitationProviderResponse>;
  revokeInvitation(providerInvitationId: string): Promise<"revoked" | "not_pending">;
}

export interface StaffInvitationDeliveryRepository {
  claim(invitationId: string): Promise<StaffInvitationDeliveryClaim | null>;
  markDelivered(
    invitationId: string,
    providerInvitationId: string,
    expiresAt: Date,
  ): Promise<boolean>;
  markUnknown(invitationId: string): Promise<void>;
  // Replaced intents (Team "Resend") whose WorkOS invitation still needs revoking, claimed for one
  // attempt: the one `replacedBy` replaced, or the due ones for the retry sweep.
  claimReplacedRevocations(input: { replacedBy?: string }): Promise<ReplacedInvitationRevocation[]>;
  markProviderRevoked(revocation: ReplacedInvitationRevocation): Promise<void>;
}

export type ReplacedInvitationRevocation = {
  invitationId: string;
  providerInvitationId: string;
};

type ClaimRow = {
  invitation_id: string;
  email: string;
  organization_id: string;
  inviter_user_id: string;
  role_key: "hotel_manager" | "front_desk" | "housekeeping" | "hotel_custom" | "external_owner";
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgStaffInvitationDeliveryRepository(config: RepositoryConfig) {
  if (!config.connectionString.trim()) {
    throw new Error("Staff invitation delivery repository connectionString must not be empty");
  }
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async claim(invitationId: string): Promise<StaffInvitationDeliveryClaim | null> {
      if (!uuidPattern.test(invitationId)) return null;
      const result = await pool.query<ClaimRow>(
        `UPDATE identity.staff_invitations invitation
         SET delivery_state = 'sending', delivery_attempted_at = now(), updated_at = now()
         FROM identity.organizations organization,
              identity.organization_memberships inviter_membership,
              identity.users inviter,
              identity.external_identities provider_identity
         WHERE invitation.id = $1::uuid
           AND invitation.status = 'pending' AND invitation.delivery_state = 'ready'
           AND invitation.role_key IN ('hotel_manager', 'front_desk', 'housekeeping', 'hotel_custom', 'external_owner')
           AND organization.id = invitation.organization_id
           AND organization.kind = 'hotel_group' AND organization.status = 'active'
           AND organization.workos_org_id IS NOT NULL AND btrim(organization.workos_org_id) <> ''
           AND inviter_membership.id = invitation.inviter_membership_id
           AND inviter_membership.organization_id = invitation.organization_id
           AND inviter_membership.user_id = invitation.inviter_user_id
           AND inviter_membership.status = 'active'
           AND inviter_membership.workos_membership_id IS NOT NULL
           AND btrim(inviter_membership.workos_membership_id) <> ''
           AND inviter.id = invitation.inviter_user_id AND inviter.status = 'active'
           AND provider_identity.user_id = invitation.inviter_user_id
           AND provider_identity.provider = 'workos'
           AND provider_identity.provider_user_id IS NOT NULL
           AND btrim(provider_identity.provider_user_id) <> ''
           AND (SELECT count(*) FROM identity.external_identities candidate
                WHERE candidate.user_id = invitation.inviter_user_id
                  AND candidate.provider = 'workos'
                  AND candidate.provider_user_id IS NOT NULL
                  AND btrim(candidate.provider_user_id) <> '') = 1
         RETURNING invitation.id AS invitation_id, invitation.email,
                   organization.workos_org_id AS organization_id,
                   provider_identity.provider_user_id AS inviter_user_id,
                   invitation.role_key`,
        [invitationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        invitationId: row.invitation_id,
        email: row.email,
        organizationId: row.organization_id,
        inviterUserId: row.inviter_user_id,
        roleSlug: row.role_key === "hotel_manager" ? "hotel_admin" : "hotel_member",
      };
    },

    async markDelivered(
      invitationId: string,
      providerInvitationId: string,
      expiresAt: Date,
    ): Promise<boolean> {
      if (
        !uuidPattern.test(invitationId) ||
        !providerInvitationId.trim() ||
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= Date.now()
      ) {
        return false;
      }
      const result = await pool.query(
        `UPDATE identity.staff_invitations
         SET delivery_state = 'delivered', provider_invitation_id = $2,
             expires_at = $3, updated_at = now()
         WHERE id = $1::uuid AND status = 'pending' AND delivery_state = 'sending'
           AND provider_invitation_id IS NULL AND expires_at IS NULL
         RETURNING id`,
        [invitationId, providerInvitationId.trim(), expiresAt],
      );
      return result.rowCount === 1;
    },

    async markUnknown(invitationId: string): Promise<void> {
      if (!uuidPattern.test(invitationId)) return;
      await pool.query(
        `UPDATE identity.staff_invitations
         SET delivery_state = 'unknown', updated_at = now()
         WHERE id = $1::uuid AND status = 'pending' AND delivery_state = 'sending'
           AND provider_invitation_id IS NULL AND expires_at IS NULL`,
        [invitationId],
      );
    },

    // Due: revoked in Vayada, sent to WorkOS, not yet confirmed revoked there, not expired, and its
    // replacement was delivered (so the invitee has a working link). Each claim is a five-minute
    // lease, so parallel workers make one attempt and a failing one backs off.
    async claimReplacedRevocations(input: {
      replacedBy?: string;
    }): Promise<ReplacedInvitationRevocation[]> {
      if (input.replacedBy !== undefined && !uuidPattern.test(input.replacedBy)) return [];
      const result = await pool.query<{ id: string; provider_invitation_id: string }>(
        `WITH due AS (
           SELECT replaced.id
           FROM identity.staff_invitations replaced
           JOIN identity.staff_invitations replacement
             ON replacement.supersedes_invitation_id = replaced.id
            AND replacement.organization_id = replaced.organization_id
           WHERE replaced.status = 'revoked' AND replaced.provider_invitation_id IS NOT NULL
             AND replaced.provider_revoked_at IS NULL AND replaced.expires_at > now()
             AND replacement.provider_invitation_id IS NOT NULL
             AND ($1::uuid IS NULL OR replacement.id = $1::uuid)
             AND (replaced.provider_revoke_attempted_at IS NULL
               OR replaced.provider_revoke_attempted_at < now() - interval '5 minutes')
           ORDER BY replaced.provider_revoke_attempted_at NULLS FIRST, replaced.id
           LIMIT 25
           FOR UPDATE OF replaced SKIP LOCKED
         )
         UPDATE identity.staff_invitations invitation
         SET provider_revoke_attempted_at = now()
         FROM due WHERE invitation.id = due.id
         RETURNING invitation.id::text AS id, invitation.provider_invitation_id`,
        [input.replacedBy ?? null],
      );
      return result.rows.map((row) => ({
        invitationId: row.id,
        providerInvitationId: row.provider_invitation_id,
      }));
    },

    async markProviderRevoked(revocation: ReplacedInvitationRevocation): Promise<void> {
      if (!uuidPattern.test(revocation.invitationId)) return;
      await pool.query(
        `UPDATE identity.staff_invitations
         SET provider_revoked_at = now()
         WHERE id = $1::uuid AND provider_invitation_id = $2 AND provider_revoked_at IS NULL`,
        [revocation.invitationId, revocation.providerInvitationId],
      );
    },

    close: () => pool.end(),
  } satisfies StaffInvitationDeliveryRepository & { close(): Promise<void> };
}

export function createStaffInvitationDeliveryCoordinator(input: {
  repository: StaffInvitationDeliveryRepository;
  provider: StaffInvitationProvider;
}) {
  return {
    // The retry sweep for replaced invitations whose WorkOS revoke has not been confirmed.
    revokeReplacedInvitations: () => revokeReplacedInvitations(input),
    async deliver(invitationId: string) {
      const claim = await input.repository.claim(invitationId);
      if (!claim) return { outcome: "not_ready" as const, invitationId };
      try {
        const response = await input.provider.sendInvitation({ ...claim, expiresInDays: 7 });
        const providerInvitationId = response.invitationId.trim();
        const expiresAt = matchingProviderExpiry(claim, response);
        if (
          !providerInvitationId ||
          !expiresAt ||
          !(await input.repository.markDelivered(
            claim.invitationId,
            providerInvitationId,
            expiresAt,
          ))
        ) {
          await input.repository.markUnknown(claim.invitationId);
          return { outcome: "unknown" as const, invitationId: claim.invitationId };
        }
        const replacedRevocation = await revokeReplacedInvitations(input, claim.invitationId);
        return {
          outcome: "delivered" as const,
          invitationId: claim.invitationId,
          providerInvitationId,
          ...(replacedRevocation ? { replacedRevocation } : {}),
        };
      } catch {
        await input.repository.markUnknown(claim.invitationId);
        return { outcome: "unknown" as const, invitationId: claim.invitationId };
      }
    },
  };
}

// A replaced intent is already revoked in Vayada, and acceptance of it grants nothing; revoking it
// in WorkOS too keeps its emailed link from activating a WorkOS membership. Tried right after the
// replacement is out, so a failure never costs the invitee their new invitation; whatever fails is
// left unconfirmed for the retry sweep (revokeReplacedInvitations without `replacedBy`).
async function revokeReplacedInvitations(
  input: { repository: StaffInvitationDeliveryRepository; provider: StaffInvitationProvider },
  replacedBy?: string,
): Promise<"revoked" | "failed" | undefined> {
  let revocations: ReplacedInvitationRevocation[];
  try {
    revocations = await input.repository.claimReplacedRevocations({ replacedBy });
  } catch {
    return "failed";
  }
  if (revocations.length === 0) return undefined;
  const outcomes = await Promise.allSettled(
    revocations.map(async (revocation) => {
      // "not_pending" (accepted, expired, already revoked, gone) is as final as "revoked".
      await input.provider.revokeInvitation(revocation.providerInvitationId);
      await input.repository.markProviderRevoked(revocation);
    }),
  );
  return outcomes.every((outcome) => outcome.status === "fulfilled") ? "revoked" : "failed";
}

function matchingProviderExpiry(
  claim: StaffInvitationDeliveryClaim,
  response: StaffInvitationProviderResponse,
): Date | null {
  const expiresAt = new Date(response.expiresAt);
  if (
    response.state !== "pending" ||
    response.email.trim().toLowerCase() !== claim.email ||
    response.organizationId !== claim.organizationId ||
    response.inviterUserId !== claim.inviterUserId ||
    response.roleSlug !== claim.roleSlug ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now()
  ) {
    return null;
  }
  return expiresAt;
}
