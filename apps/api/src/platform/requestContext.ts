// RequestContext types are defined in packages/backend-auth and re-exported here
// so existing imports within apps/api remain stable.
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
} from "@vayada/backend-auth";

import type { LinkedResource, PermissionKey, RequestContext } from "@vayada/backend-auth";

// Fixture types remain local — they reference RequestContext and are test-only.
export type ResourceAccessRequirement = {
  permission: PermissionKey;
  resource: Pick<LinkedResource, "product" | "resourceType" | "resourceId">;
};

export type RequestContextFixtureCase = {
  name: string;
  scope: "hotel" | "creator" | "affiliate" | "platform";
  context: RequestContext;
  requirement: ResourceAccessRequirement;
  expected: "allowed" | "denied";
  reason: string;
};
