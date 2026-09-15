import type pg from "pg";

export type AccountAdmin = {
  membershipId: string;
  name: string | null;
  email: string;
  roleKey: string;
  active: boolean;
};

// Include legacy ownership aliases and suspended owners; never pick one arbitrarily.
export async function listAccountAdmins(
  pool: pg.Pool,
  organizationId: string,
): Promise<AccountAdmin[]> {
  const result = await pool.query<AccountAdmin>(
    `SELECT membership.id AS "membershipId", person.name, person.email,
            membership.role_key AS "roleKey",
            (membership.status = 'active' AND person.status = 'active') AS active
     FROM identity.organization_memberships membership
     JOIN identity.users person ON person.id = membership.user_id
     JOIN identity.organizations organization ON organization.id = membership.organization_id
     WHERE organization.id = $1 AND organization.kind = 'hotel_group' AND organization.status = 'active'
       AND membership.role_key IN ('hotel_owner', 'owner', 'operator')
       AND membership.status IN ('active', 'suspended')
     ORDER BY membership.created_at, membership.id`,
    [organizationId],
  );
  return result.rows;
}
