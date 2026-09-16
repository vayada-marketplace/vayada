import type pg from "pg";
import { staffAccessRevision, type StaffAccessRevisionRow } from "./staffAccessRevision.js";

export type AccountAdmin = {
  membershipId: string;
  name: string | null;
  email: string;
  roleKey: string;
  active: boolean;
  revision: string;
};

type AccountAdminRow = StaffAccessRevisionRow & Omit<AccountAdmin, "revision">;

// Include legacy ownership aliases and suspended owners; never pick one arbitrarily.
export async function listAccountAdmins(
  pool: pg.Pool,
  organizationId: string,
): Promise<AccountAdmin[]> {
  const result = await pool.query<AccountAdminRow>(
    `SELECT membership.id, membership.id AS "membershipId", person.name, person.email,
            membership.role_key AS "roleKey",
            (membership.status = 'active' AND person.status = 'active') AS active,
            membership.role_key, membership.role_definition_id, membership.permission_overrides,
            membership.property_access_mode, membership.access_origin, membership.status,
            membership.updated_at::text AS updated_at,
            membership.pms_access_enabled, membership.booking_access_enabled,
            CASE WHEN definition.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', definition.id, 'name', definition.name, 'revision', definition.revision::text,
              'securityClass', definition.security_class, 'baseRoleKey', definition.base_role_key,
              'presetKey', definition.preset_key, 'defaultPermissions', definition.default_permissions
            ) END AS role_definition,
            ARRAY(SELECT assignment.property_id::text
                  FROM identity.membership_property_assignments assignment
                  WHERE assignment.membership_id = membership.id ORDER BY assignment.property_id) AS property_ids,
            ARRAY(SELECT permission_key FROM identity.role_permission_grants
                  WHERE organization_kind = 'hotel_group'
                    AND role_key = membership.role_key ORDER BY permission_key) AS role_permissions
     FROM identity.organization_memberships membership
     JOIN identity.users person ON person.id = membership.user_id
     JOIN identity.organizations organization ON organization.id = membership.organization_id
     LEFT JOIN identity.organization_roles definition
       ON definition.id = membership.role_definition_id AND definition.organization_id = membership.organization_id
     WHERE organization.id = $1 AND organization.kind = 'hotel_group' AND organization.status = 'active'
       AND membership.role_key IN ('hotel_owner', 'owner', 'operator')
       AND membership.status IN ('active', 'suspended')
     ORDER BY membership.created_at, membership.id`,
    [organizationId],
  );
  return result.rows.map((row) => ({
    membershipId: row.membershipId,
    name: row.name,
    email: row.email,
    roleKey: row.roleKey,
    active: row.active,
    revision: staffAccessRevision(row),
  }));
}
