import pg from "pg";

import type {
  InternalUserStatus,
  MembershipStatus,
  OrganizationKind,
  OrganizationStatus,
} from "./types.js";

export type IdentityUser = {
  userId: string;
  email: string;
  status: InternalUserStatus;
};

export type IdentityOrganization = {
  organizationId: string;
  workosOrgId: string | null;
  kind: OrganizationKind;
  status: OrganizationStatus;
};

export type IdentityMembership = {
  membershipId: string;
  status: MembershipStatus;
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

export type RepositoryConfig = {
  connectionString: string;
  /** Maximum number of connections in the pool. Defaults to pg's default (10). */
  max?: number;
};

/**
 * Creates a Postgres-backed IdentityRepository that manages its own connection
 * pool internally. Accepts a connection string rather than a pre-built pool so
 * callers do not need to create and manage a separate pool alongside any other
 * database clients used by apps/api.
 */
export function createPgIdentityRepository(config: RepositoryConfig): IdentityRepository {
  if (!config.connectionString.trim()) {
    throw new Error("RepositoryConfig.connectionString must not be empty");
  }

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findUserByProviderUserId(provider, providerUserId) {
      const result = await pool.query<{
        user_id: string;
        email: string;
        status: InternalUserStatus;
      }>(
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
        kind: OrganizationKind;
        status: OrganizationStatus;
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
        status: MembershipStatus;
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
