import pg from "pg";

export type IdentityUser = {
  userId: string;
  email: string;
  status: string;
};

export type IdentityOrganization = {
  organizationId: string;
  workosOrgId: string | null;
  kind: string;
  status: string;
};

export type IdentityMembership = {
  membershipId: string;
  status: string;
  roleKey: string;
  workosMembershipId: string | null;
  workosRoleSlugs: string[];
};

export type IdentityResourceLink = {
  product: string;
  resourceType: string;
  resourceId: string;
  relationship: string;
  status: string;
};

/** Read-only identity queries needed to resolve a RequestContext. */
export interface IdentityRepository {
  findUserByProviderUserId(provider: string, providerUserId: string): Promise<IdentityUser | null>;

  findOrganizationByWorkosOrgId(workosOrgId: string): Promise<IdentityOrganization | null>;

  findActiveMembership(userId: string, organizationId: string): Promise<IdentityMembership | null>;

  findLinkedResources(organizationId: string): Promise<IdentityResourceLink[]>;
}

/** Postgres-backed implementation querying the identity schema. */
export function createPgIdentityRepository(pool: pg.Pool): IdentityRepository {
  return {
    async findUserByProviderUserId(provider, providerUserId) {
      const result = await pool.query<{ user_id: string; email: string; status: string }>(
        `SELECT u.id AS user_id, u.email, u.status
         FROM identity.external_identities ei
         JOIN identity.users u ON u.id = ei.user_id
         WHERE ei.provider = $1 AND ei.provider_user_id = $2
         LIMIT 1`,
        [provider, providerUserId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { userId: row.user_id, email: row.email, status: row.status };
    },

    async findOrganizationByWorkosOrgId(workosOrgId) {
      const result = await pool.query<{
        id: string;
        workos_org_id: string | null;
        kind: string;
        status: string;
      }>(
        `SELECT id, workos_org_id, kind, status
         FROM identity.organizations
         WHERE workos_org_id = $1
         LIMIT 1`,
        [workosOrgId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        organizationId: row.id,
        workosOrgId: row.workos_org_id,
        kind: row.kind,
        status: row.status,
      };
    },

    async findActiveMembership(userId, organizationId) {
      const result = await pool.query<{
        id: string;
        status: string;
        role_key: string;
        workos_membership_id: string | null;
        workos_role_slugs: string[];
      }>(
        `SELECT id, status, role_key, workos_membership_id, workos_role_slugs
         FROM identity.organization_memberships
         WHERE user_id = $1 AND organization_id = $2
         LIMIT 1`,
        [userId, organizationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        membershipId: row.id,
        status: row.status,
        roleKey: row.role_key,
        workosMembershipId: row.workos_membership_id,
        workosRoleSlugs: row.workos_role_slugs,
      };
    },

    async findLinkedResources(organizationId) {
      const result = await pool.query<{
        product: string;
        resource_type: string;
        resource_id: string;
        relationship: string;
        status: string;
      }>(
        `SELECT product, resource_type, resource_id, relationship, status
         FROM identity.organization_resource_links
         WHERE organization_id = $1 AND status = 'active'`,
        [organizationId],
      );
      return result.rows.map((row) => ({
        product: row.product,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        relationship: row.relationship,
        status: row.status,
      }));
    },
  };
}
