// Types
export type {
  ActiveMembership,
  AuthProvider,
  EntitlementStatus,
  InternalUserStatus,
  LinkedResource,
  MembershipStatus,
  OrganizationKind,
  OrganizationStatus,
  PermissionKey,
  Product,
  ProductEntitlement,
  ProviderIdentity,
  RequestActor,
  RequestAuditMetadata,
  RequestContext,
  RequestSource,
  ResourceRelationship,
  ResourceType,
  SelectedOrganization,
} from "./types.js";

// Errors
export { AuthError, UnauthorizedError, type AuthErrorCode } from "./errors.js";

// Token verification
export {
  createFakeVerifier,
  createWorkOSVerifier,
  extractBearerToken,
  type TokenVerifier,
  type VerifiedSession,
  type WorkOSVerifierConfig,
} from "./verify.js";

// Identity repository
export {
  createPgIdentityRepository,
  type IdentityMembership,
  type IdentityOrganization,
  type IdentityRepository,
  type IdentityResourceLink,
  type IdentityUser,
  type RepositoryConfig,
} from "./repository.js";

// RequestContext resolution
export {
  resolveRequestContext,
  type AuthorizationResolution,
  type AuthorizationResolver,
  type ResolveOptions,
} from "./resolve.js";

// Fastify plugin
export {
  backendAuthPlugin,
  getAuthContext,
  requireAuthContext,
  type BackendAuthPluginOptions,
} from "./plugin.js";
