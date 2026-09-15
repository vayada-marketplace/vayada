import pg from "pg";
import type { RepositoryConfig } from "./repository.js";
import {
  teamRolePermissionCeiling,
  validateTeamRoleDefaults,
  type TeamRolePolicy,
} from "./teamRolePolicy.js";

export type TeamRole = TeamRolePolicy & {
  id: string;
  name: string;
  description: string;
  revision: string;
  memberCount: number;
  invitationCount: number;
  allowedPermissions: readonly string[];
  immutable: boolean;
};

export function createPgTeamRoleRepository(config: RepositoryConfig) {
  if (!config.connectionString.trim())
    throw new Error("Team role connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });
  return {
    async list(organizationId: string): Promise<TeamRole[]> {
      const result = await pool.query<{
        id: string;
        name: string;
        description: string;
        revision: string;
        security_class: TeamRolePolicy["securityClass"];
        base_role_key: string;
        preset_key: string | null;
        default_permissions: unknown;
        member_count: number;
        invitation_count: number;
      }>(
        `SELECT role.id, role.name, role.description, role.revision::text,
          role.security_class, role.base_role_key, role.preset_key, role.default_permissions,
          (SELECT count(*)::int FROM identity.organization_memberships member
           WHERE member.organization_id = role.organization_id AND member.role_definition_id = role.id
             AND member.status IN ('active', 'suspended')) AS member_count,
          (SELECT count(*)::int FROM identity.staff_invitations invite
           WHERE invite.organization_id = role.organization_id AND invite.role_definition_id = role.id
             AND invite.status = 'pending' AND (invite.expires_at IS NULL OR invite.expires_at > now())) AS invitation_count
         FROM identity.organization_roles role
         JOIN identity.organizations organization ON organization.id = role.organization_id
         WHERE role.organization_id = $1 AND organization.kind = 'hotel_group' AND organization.status = 'active'
         ORDER BY (role.preset_key = 'account_admin') DESC NULLS LAST, role.created_at, role.id`,
        [organizationId],
      );
      return result.rows.map((row) => {
        const policy: TeamRolePolicy = {
          securityClass: row.security_class,
          baseRoleKey: row.base_role_key,
          presetKey: row.preset_key,
          defaultPermissions: row.default_permissions,
        };
        if (!validateTeamRoleDefaults(policy))
          throw new Error("Team role configuration is unavailable");
        return {
          ...policy,
          id: row.id,
          name: row.name,
          description: row.description,
          revision: row.revision,
          memberCount: row.member_count,
          invitationCount: row.invitation_count,
          allowedPermissions: teamRolePermissionCeiling(policy)!,
          immutable: row.security_class === "account_admin",
        };
      });
    },
    async close() {
      await pool.end();
    },
  };
}
