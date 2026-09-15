import type { QueryResultRow } from "pg";
import {
  parseStaffPermissionOverrides,
  resolveTeamRolePermissions,
  validateStaffPermissionOverrides,
  type PermissionKey,
  type TeamRolePolicy,
} from "@vayada/backend-auth";

// Call after locking the active actor, membership and organization scope.
export async function lockPmsInboxRolePermissions(
  client: {
    query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[] }>;
  },
  organizationId: string,
  actor: { roleKey: string; permissionOverrides: unknown; roleDefinitionId?: string | null },
): Promise<Set<string> | null> {
  const grants = await client.query<{ permissionKey: PermissionKey }>(
    `SELECT permission_key AS "permissionKey" FROM identity.role_permission_grants
     WHERE organization_kind = 'hotel_group' AND role_key = $1 FOR SHARE`,
    [actor.roleKey],
  );
  const rolePermissions = grants.rows.map((row) => row.permissionKey);
  if (actor.roleDefinitionId != null) {
    const result = await client.query<{
      security_class: TeamRolePolicy["securityClass"];
      base_role_key: string;
      preset_key: string | null;
      default_permissions: unknown;
    }>(
      `SELECT security_class, base_role_key, preset_key, default_permissions FROM identity.organization_roles
       WHERE id = $1::uuid AND organization_id = $2::uuid FOR SHARE`,
      [actor.roleDefinitionId, organizationId],
    );
    const row = result.rows[0];
    if (!row || row.base_role_key !== actor.roleKey) return null;
    const permissions = resolveTeamRolePermissions(
      {
        securityClass: row.security_class,
        baseRoleKey: row.base_role_key,
        presetKey: row.preset_key,
        defaultPermissions: row.default_permissions,
      },
      actor.permissionOverrides,
      rolePermissions,
    );
    return permissions ? new Set(permissions) : null;
  }
  const effective = new Set<string>(rolePermissions);
  if (actor.permissionOverrides !== null && actor.permissionOverrides !== undefined) {
    const overrides = parseStaffPermissionOverrides(actor.permissionOverrides);
    if (
      !overrides ||
      validateStaffPermissionOverrides({
        roleKey: actor.roleKey,
        rolePermissions,
        permissionOverrides: overrides,
      }).length
    )
      return null;
    for (const permission of overrides.grant) effective.add(permission);
    for (const permission of overrides.deny) effective.delete(permission);
  }
  return effective;
}
