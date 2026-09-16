import type pg from "pg";

type InventoryRow = {
  organizationId: string;
  organizationStatus: string;
  ownerCount: number;
  activeCanonicalOwnerCount: number;
  legacyOwnerCount: number;
  restrictedOwnerCount: number;
};

export async function runAccountAdminPreflight(client: pg.Client) {
  const result = await client.query<InventoryRow>(
    `SELECT organization.id AS "organizationId", organization.status AS "organizationStatus",
       count(membership.id)::int AS "ownerCount",
       count(membership.id) FILTER (WHERE membership.role_key = 'hotel_owner'
         AND membership.status = 'active' AND person.status = 'active')::int AS "activeCanonicalOwnerCount",
       count(membership.id) FILTER (WHERE membership.role_key IN ('owner', 'operator'))::int AS "legacyOwnerCount",
       count(membership.id) FILTER (WHERE membership.role_key = 'hotel_owner' AND (
         membership.property_access_mode <> 'all' OR membership.access_origin <> 'agency'
         OR NOT membership.pms_access_enabled OR NOT membership.booking_access_enabled
         OR (membership.permission_overrides IS NOT NULL AND membership.permission_overrides <> '{"grant":[],"deny":[]}'::jsonb)
         OR (membership.role_definition_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM identity.organization_roles definition
           WHERE definition.id = membership.role_definition_id AND definition.organization_id = organization.id
             AND definition.preset_key = 'account_admin' AND definition.security_class = 'account_admin'
             AND definition.base_role_key = 'hotel_owner' AND definition.default_permissions = '[]'::jsonb
         ))
       ))::int AS "restrictedOwnerCount"
     FROM identity.organizations organization
     LEFT JOIN identity.organization_memberships membership ON membership.organization_id = organization.id
       AND membership.role_key IN ('hotel_owner', 'owner', 'operator')
     LEFT JOIN identity.users person ON person.id = membership.user_id
     WHERE organization.kind = 'hotel_group'
     GROUP BY organization.id, organization.status ORDER BY organization.id`,
  );
  const exceptions = result.rows.filter(
    (row) =>
      row.ownerCount !== 1 ||
      row.activeCanonicalOwnerCount !== 1 ||
      row.legacyOwnerCount > 0 ||
      row.restrictedOwnerCount > 0,
  );
  return {
    contractVersion: "account-admin-preflight.v1" as const,
    status: exceptions.length ? ("blocked" as const) : ("ready" as const),
    organizationCount: result.rows.length,
    exceptions,
  };
}
