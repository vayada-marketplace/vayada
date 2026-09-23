import pg from "pg";

import { parseStaffPermissionOverrides, validateStaffInviteAccess } from "./lifecycle.js";
import type { RepositoryConfig } from "./repository.js";
import { resolveTeamRolePermissions, type TeamRolePolicy } from "./teamRolePolicy.js";
import {
  authorizeStaffInvitationAcceptance,
  enqueueInboxAssignmentReconciliation,
} from "./staffInvitations.js";

export type StaffInvitationAcceptanceEvent = {
  providerEventId: string;
  providerInvitationId: string;
  providerUserId: string;
  providerOrganizationId: string;
  invitationEmail: string;
};

type RejectionReason =
  | "invalid_event"
  | "invitation_not_found"
  | "provider_context_mismatch"
  | "invitation_not_current"
  | "invitation_expired"
  | "organization_inactive"
  | "user_inactive"
  | "provider_identity_mismatch"
  | "invitation_access_invalid"
  | "membership_protected";

export type StaffInvitationAcceptanceResult =
  | { outcome: "accepted" | "idempotent_replay"; invitationId: string; membershipId: string }
  | { outcome: "deferred"; reason: "identity_not_found" }
  | { outcome: "rejected"; reason: RejectionReason };

type InvitationRow = {
  inviter_user_id: string;
  role_definition_id: string | null;
  role_definition: (TeamRolePolicy & { id: string }) | null;
  pms_access_enabled: boolean;
  booking_access_enabled: boolean;
  id: string;
  organization_id: string;
  email: string;
  role_key: string;
  permission_overrides: unknown;
  property_access_mode: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  delivery_state: string;
  is_expired: boolean;
  accepted_user_id: string | null;
  accepted_membership_id: string | null;
  request_id: string;
  correlation_id: string | null;
  organization_kind: string;
  organization_status: string;
  workos_org_id: string | null;
  property_ids: string[];
};

type IdentityRow = {
  user_id: string;
  status: string;
  name: string | null;
  provider_email: string | null;
  provider_email_verified: boolean;
};

export function createPgStaffInvitationAcceptanceRepository(config: RepositoryConfig) {
  if (!config.connectionString.trim()) throw new Error("connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async reconcile(raw: StaffInvitationAcceptanceEvent): Promise<StaffInvitationAcceptanceResult> {
      const event = normalizeEvent(raw);
      if (!event) return { outcome: "rejected", reason: "invalid_event" };
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT organization.id FROM identity.organizations organization
           JOIN identity.staff_invitations invitation ON invitation.organization_id = organization.id
           WHERE invitation.provider_invitation_id = $1 FOR UPDATE OF organization`,
          [event.providerInvitationId],
        );
        const invitation = (
          await client.query<InvitationRow>(
            `SELECT invitation.id, invitation.organization_id, invitation.email, invitation.role_key,
                    invitation.inviter_user_id,
                    invitation.role_definition_id,
                    CASE WHEN definition.id IS NULL THEN NULL ELSE jsonb_build_object(
                      'id', definition.id, 'securityClass', definition.security_class,
                      'baseRoleKey', definition.base_role_key, 'presetKey', definition.preset_key,
                      'defaultPermissions', definition.default_permissions
                    ) END AS role_definition,
                    invitation.permission_overrides, invitation.property_access_mode, invitation.status,
                    invitation.pms_access_enabled, invitation.booking_access_enabled,
                    invitation.delivery_state, invitation.expires_at <= now() AS is_expired,
                    invitation.accepted_user_id, invitation.accepted_membership_id,
                    invitation.request_id, invitation.correlation_id,
                    organization.kind AS organization_kind, organization.status AS organization_status,
                    organization.workos_org_id,
                    ARRAY(SELECT property_id::text
                          FROM identity.staff_invitation_property_assignments
                          WHERE invitation_id = invitation.id ORDER BY property_id) AS property_ids
             FROM identity.staff_invitations invitation
             JOIN identity.organizations organization ON organization.id = invitation.organization_id
             LEFT JOIN identity.organization_roles definition
               ON definition.organization_id = invitation.organization_id AND definition.id = invitation.role_definition_id
             WHERE invitation.provider_invitation_id = $1
             FOR UPDATE OF invitation, organization`,
            [event.providerInvitationId],
          )
        ).rows[0];
        if (!invitation) {
          await client.query("ROLLBACK");
          return { outcome: "rejected", reason: "invitation_not_found" };
        }
        const reject = async (reason: RejectionReason, identity?: IdentityRow) => {
          await audit(client, invitation, event, "rejected", reason, identity);
          await client.query("COMMIT");
          return { outcome: "rejected" as const, reason };
        };

        if (
          invitation.workos_org_id !== event.providerOrganizationId ||
          invitation.email !== event.invitationEmail
        )
          return reject("provider_context_mismatch");
        if (invitation.status === "pending" && invitation.is_expired) {
          await client.query(
            "UPDATE identity.staff_invitations SET status = 'expired', updated_at = now() WHERE id = $1",
            [invitation.id],
          );
          return reject("invitation_expired");
        }

        const identity = (
          await client.query<IdentityRow>(
            `SELECT external.user_id, users.status, users.name, external.provider_email,
                    external.provider_email_verified
             FROM identity.external_identities external
             JOIN identity.users users ON users.id = external.user_id
             WHERE external.provider = 'workos' AND external.provider_user_id = $1
             FOR SHARE OF external, users`,
            [event.providerUserId],
          )
        ).rows[0];
        if (invitation.status === "accepted") {
          if (
            identity?.user_id === invitation.accepted_user_id &&
            invitation.accepted_membership_id
          ) {
            await client.query("ROLLBACK");
            return {
              outcome: "idempotent_replay",
              invitationId: invitation.id,
              membershipId: invitation.accepted_membership_id,
            };
          }
          return reject("invitation_not_current", identity);
        }
        if (invitation.status !== "pending" || invitation.delivery_state !== "delivered") {
          return reject("invitation_not_current", identity);
        }
        if (!identity) {
          await client.query("ROLLBACK");
          return { outcome: "deferred", reason: "identity_not_found" };
        }
        if (
          invitation.organization_kind !== "hotel_group" ||
          invitation.organization_status !== "active"
        ) {
          return reject("organization_inactive", identity);
        }
        if (identity.status !== "active") return reject("user_inactive", identity);
        if (
          !identity.provider_email_verified ||
          identity.provider_email?.trim().toLowerCase() !== invitation.email
        ) {
          return reject("provider_identity_mismatch", identity);
        }

        if (
          !(await authorizeStaffInvitationAcceptance(
            client,
            invitation.organization_id,
            invitation.inviter_user_id,
            identity.user_id,
            invitation.id,
          ))
        )
          return reject("invitation_access_invalid", identity);
        const overrides = parseStaffPermissionOverrides(invitation.permission_overrides);
        if (
          !overrides ||
          (invitation.role_key === "external_owner" && invitation.role_definition_id === null) ||
          validateStaffInviteAccess({
            roleKey: invitation.role_key,
            propertyAccessMode: invitation.property_access_mode,
            propertyIds: invitation.property_ids,
            permissionOverrides: overrides,
          }).filter(
            (issue) =>
              invitation.role_definition_id === null || issue !== "missing_required_permission",
          ).length ||
          (invitation.role_definition_id !== null &&
            (!invitation.role_definition ||
              invitation.role_definition.id !== invitation.role_definition_id ||
              invitation.role_definition.baseRoleKey !== invitation.role_key ||
              !resolveTeamRolePermissions(invitation.role_definition, overrides)))
        )
          return reject("invitation_access_invalid", identity);
        const linkedPropertyIds = await loadLinkedStaffInvitationPropertyIds(
          client,
          invitation.id,
          invitation.organization_id,
        );
        if (new Set(linkedPropertyIds).size !== invitation.property_ids.length) {
          return reject("invitation_access_invalid", identity);
        }

        const membershipId = (
          await client.query<{ id: string }>(
            `INSERT INTO identity.organization_memberships
               (organization_id, user_id, status, role_key, permission_overrides,
                property_access_mode, access_origin, invited_at, pms_access_enabled, booking_access_enabled, role_definition_id)
             VALUES ($1, $2, 'active', $3, $4::jsonb, $7, 'agency', now(), $5, $6, $8)
             ON CONFLICT (organization_id, user_id) DO UPDATE SET
               status = 'active', role_key = EXCLUDED.role_key,
               permission_overrides = EXCLUDED.permission_overrides,
               role_definition_id = EXCLUDED.role_definition_id,
               property_access_mode = EXCLUDED.property_access_mode,
               pms_access_enabled = EXCLUDED.pms_access_enabled,
               booking_access_enabled = EXCLUDED.booking_access_enabled,
               invited_at = COALESCE(identity.organization_memberships.invited_at, EXCLUDED.invited_at),
               updated_at = now()
             WHERE identity.organization_memberships.status <> 'suspended'
               AND identity.organization_memberships.role_definition_id IS NULL
               AND identity.organization_memberships.access_origin = 'agency'
               AND identity.organization_memberships.role_key NOT IN ('hotel_owner', 'owner', 'operator', 'external_owner')
             RETURNING id`,
            [
              invitation.organization_id,
              identity.user_id,
              invitation.role_key,
              JSON.stringify(overrides),
              invitation.pms_access_enabled,
              invitation.booking_access_enabled,
              invitation.property_access_mode,
              invitation.role_definition_id,
            ],
          )
        ).rows[0]?.id;
        if (!membershipId) return reject("membership_protected", identity);

        await client.query(
          "DELETE FROM identity.membership_property_assignments WHERE membership_id = $1",
          [membershipId],
        );
        await client.query(
          `INSERT INTO identity.membership_property_assignments (membership_id, property_id)
           SELECT $1, property_id FROM identity.staff_invitation_property_assignments WHERE invitation_id = $2`,
          [membershipId, invitation.id],
        );
        await client.query(
          `UPDATE identity.staff_invitations SET status = 'accepted', accepted_user_id = $2,
             accepted_membership_id = $3, updated_at = now() WHERE id = $1 AND status = 'pending'`,
          [invitation.id, identity.user_id, membershipId],
        );
        await audit(client, invitation, event, "accepted", undefined, identity, membershipId);
        await enqueueInboxAssignmentReconciliation(client, {
          organizationId: invitation.organization_id,
          membershipId,
          idempotencyId: invitation.id,
          correlationId: invitation.correlation_id ?? invitation.request_id,
          commandId: event.providerEventId,
          reason: "role_permissions_changed",
        });
        await client.query("COMMIT");
        return { outcome: "accepted", invitationId: invitation.id, membershipId };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function loadLinkedStaffInvitationPropertyIds(
  client: pg.PoolClient | pg.Client,
  invitationId: string,
  organizationId: string,
): Promise<string[]> {
  // The caller locks the parent invitation, which serializes its immutable assignments.
  // Only mutable organization links need row locks while their scope is validated.
  const linked = await client.query<{ property_id: string }>(
    `SELECT assignment.property_id::text
     FROM identity.staff_invitation_property_assignments assignment
     JOIN identity.organization_resource_links link
       ON link.organization_id = $2 AND link.product = 'hotel_catalog'
      AND link.resource_type = 'property' AND link.resource_id = assignment.property_id::text
      AND link.relationship IN ('owner', 'operator') AND link.status = 'active'
     WHERE assignment.invitation_id = $1 FOR SHARE OF link`,
    [invitationId, organizationId],
  );
  return linked.rows.map(({ property_id }) => property_id);
}

function normalizeEvent(
  event: StaffInvitationAcceptanceEvent,
): StaffInvitationAcceptanceEvent | null {
  const fields = [
    event.providerEventId,
    event.providerInvitationId,
    event.providerUserId,
    event.providerOrganizationId,
    event.invitationEmail,
  ];
  if (fields.some((value) => typeof value !== "string" || !value.trim())) return null;
  return {
    ...event,
    providerEventId: event.providerEventId.trim(),
    providerInvitationId: event.providerInvitationId.trim(),
    providerUserId: event.providerUserId.trim(),
    providerOrganizationId: event.providerOrganizationId.trim(),
    invitationEmail: event.invitationEmail.trim().toLowerCase(),
  };
}

async function audit(
  client: pg.PoolClient,
  invitation: InvitationRow,
  event: StaffInvitationAcceptanceEvent,
  outcome: "accepted" | "rejected",
  reason?: string,
  identity?: IdentityRow,
  membershipId?: string,
) {
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, organization_id,
        actor_type, actor_user_id, target_resource_product, target_resource_type,
        target_resource_id, correlation_id, redacted_payload, retention_class, privacy_scope)
     VALUES ($1, 'identity', $2, now(), 'organization', $3, $4, $5,
             'identity', 'staff_invitation', $6, $7, $8::jsonb, 'security', 'confidential')
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `staff-invitation-acceptance:${event.providerEventId}:${reason ?? outcome}`,
      `staff_invitation.${outcome}`,
      invitation.organization_id,
      identity ? "user" : "provider",
      identity?.user_id ?? null,
      invitation.id,
      invitation.correlation_id,
      JSON.stringify({
        outcome,
        reason,
        actorNameSnapshot: identity?.name ?? null,
        requestId: invitation.request_id,
        membershipId,
        providerEventId: event.providerEventId,
        propertyIds: invitation.property_ids,
        propertyAccessMode: invitation.property_access_mode,
        roleDefinitionId: invitation.role_definition_id,
        productAccess: {
          pms: invitation.pms_access_enabled,
          booking: invitation.booking_access_enabled,
        },
      }),
    ],
  );
}
