import pg from "pg";

import type {
  OrganizationKind,
  PermissionKey,
  ResourceRelationship,
  ProductEntitlement,
  RequestContext,
  ResourceType,
  Product,
} from "@vayada/backend-auth";

export type RolePermissionRepository = {
  findPermissionsForRole(
    organizationKind: OrganizationKind,
    roleKey: string,
  ): Promise<PermissionKey[]>;
  close?(): Promise<void>;
};

export type AuthorizationResolution = {
  permissions: PermissionKey[];
  entitlements?: ProductEntitlement[];
};

export type AuthorizationResolver = (context: RequestContext) => Promise<AuthorizationResolution>;

export type AuthorizationRepositoryConfig = {
  connectionString: string;
  max?: number;
};

export type ResourceRequirement = {
  product: Product;
  resourceType: ResourceType;
  resourceId: string;
  allowedRelationships: readonly ResourceRelationship[];
};

export type ResourceAccessRequirement = {
  permission: PermissionKey;
  resource: ResourceRequirement;
};

export class AuthorizationError extends Error {
  readonly statusCode = 403;

  constructor(message = "The authenticated user is not authorized for this resource.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function createPgRolePermissionRepository(
  config: AuthorizationRepositoryConfig,
): RolePermissionRepository {
  if (!config.connectionString.trim()) {
    throw new Error("AuthorizationRepositoryConfig.connectionString must not be empty");
  }

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findPermissionsForRole(organizationKind, roleKey) {
      const result = await pool.query<{ permission_key: PermissionKey }>(
        `SELECT permission_key
         FROM identity.role_permission_grants
         WHERE organization_kind = $1 AND role_key = $2
         ORDER BY permission_key`,
        [organizationKind, roleKey],
      );
      return result.rows.map((row) => row.permission_key);
    },
    async close() {
      await pool.end();
    },
  };
}

export function createAuthorizationResolver(
  repository: RolePermissionRepository,
): AuthorizationResolver {
  return async (context) => ({
    permissions: await repository.findPermissionsForRole(
      context.selectedOrganization.kind,
      context.membership.roleKey,
    ),
  });
}

export function hasPermission(context: RequestContext, permission: PermissionKey): boolean {
  return context.membership.permissions.includes(permission);
}

export function hasActiveLinkedResource(
  context: RequestContext,
  requirement: ResourceRequirement,
): boolean {
  return context.linkedResources.some(
    (resource) =>
      resource.status === "active" &&
      resource.product === requirement.product &&
      resource.resourceType === requirement.resourceType &&
      resource.resourceId === requirement.resourceId &&
      requirement.allowedRelationships.includes(resource.relationship),
  );
}

export function canAccessResource(
  context: RequestContext,
  requirement: ResourceAccessRequirement,
): boolean {
  return (
    hasPermission(context, requirement.permission) &&
    hasActiveLinkedResource(context, requirement.resource)
  );
}

export function requirePermission(
  context: RequestContext,
  permission: PermissionKey,
): RequestContext {
  if (!hasPermission(context, permission)) {
    throw new AuthorizationError(`Missing required permission: ${permission}`);
  }
  return context;
}

export function requireResourceAccess(
  context: RequestContext,
  requirement: ResourceAccessRequirement,
): RequestContext {
  if (!canAccessResource(context, requirement)) {
    throw new AuthorizationError(
      `Missing ${requirement.permission} access to ${requirement.resource.product}:${requirement.resource.resourceType}:${requirement.resource.resourceId}`,
    );
  }
  return context;
}
