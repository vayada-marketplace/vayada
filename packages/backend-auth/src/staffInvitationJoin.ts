import pg from "pg";

import type { RepositoryConfig } from "./repository.js";

// What the invitee sees before joining (VAY-2274). Hotel names come from the catalog, never the
// WorkOS organization name, which is generated from the owner's signup email.
export type StaffInvitationJoinDetails = {
  email: string;
  inviteeName: string | null;
  inviterName: string;
  roleKey: string;
  roleName: string | null;
  hotelNames: string[];
};

export type StaffInvitationJoinRepository = {
  findCurrent(input: {
    providerInvitationId: string;
    workosOrganizationId: string;
  }): Promise<StaffInvitationJoinDetails | null>;
};

type JoinRow = {
  email: string;
  invitee_name: string | null;
  inviter_name: string;
  role_key: string;
  role_name: string | null;
  hotel_names: string[];
};

export function createPgStaffInvitationJoinRepository(config: RepositoryConfig) {
  if (!config.connectionString.trim()) throw new Error("connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    // Only the current, delivered, unexpired intent of an active hotel group answers; a replaced or
    // revoked provider invitation reads as missing.
    async findCurrent(input): Promise<StaffInvitationJoinDetails | null> {
      const providerInvitationId = input.providerInvitationId.trim();
      const workosOrganizationId = input.workosOrganizationId.trim();
      if (!providerInvitationId || !workosOrganizationId) return null;
      const result = await pool.query<JoinRow>(
        `SELECT invitation.email, invitation.display_name AS invitee_name,
                invitation.inviter_name_snapshot AS inviter_name,
                invitation.role_key, definition.name AS role_name,
                ARRAY(
                  SELECT property.display_name
                  FROM identity.organization_resource_links link
                  JOIN hotel_catalog.properties property ON property.id::text = link.resource_id
                  WHERE link.organization_id = invitation.organization_id
                    AND link.product = 'hotel_catalog' AND link.resource_type = 'property'
                    AND link.relationship IN ('owner', 'operator') AND link.status = 'active'
                    AND (invitation.property_access_mode = 'all' OR property.id IN (
                      SELECT assignment.property_id
                      FROM identity.staff_invitation_property_assignments assignment
                      WHERE assignment.invitation_id = invitation.id))
                  ORDER BY property.display_name, property.id
                ) AS hotel_names
         FROM identity.staff_invitations invitation
         JOIN identity.organizations organization ON organization.id = invitation.organization_id
         LEFT JOIN identity.organization_roles definition
           ON definition.organization_id = invitation.organization_id
          AND definition.id = invitation.role_definition_id
         WHERE invitation.provider_invitation_id = $1 AND organization.workos_org_id = $2
           AND invitation.status = 'pending' AND invitation.delivery_state = 'delivered'
           AND invitation.expires_at > now()
           AND organization.kind = 'hotel_group' AND organization.status = 'active'`,
        [providerInvitationId, workosOrganizationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        email: row.email,
        inviteeName: row.invitee_name,
        inviterName: row.inviter_name,
        roleKey: row.role_key,
        roleName: row.role_name,
        hotelNames: row.hotel_names,
      };
    },
    close: () => pool.end(),
  } satisfies StaffInvitationJoinRepository & { close(): Promise<void> };
}
