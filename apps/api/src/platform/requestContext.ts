export type AuthProvider = "workos" | "legacy-compat";

export type InternalUserStatus = "active" | "pending" | "suspended" | "deleted";

export type OrganizationKind =
  | "platform"
  | "hotel_group"
  | "creator_workspace"
  | "affiliate_partner";

export type OrganizationStatus = "active" | "suspended" | "archived";

export type MembershipStatus = "active" | "pending" | "inactive" | "suspended";

export type Product = "platform" | "marketplace" | "booking" | "pms" | "affiliate";

export type ResourceType =
  | "platform"
  | "booking_hotel"
  | "pms_hotel"
  | "hotel_profile"
  | "hotel_listing"
  | "creator_profile"
  | "affiliate"
  | "payout_account";

export type ResourceRelationship = "owner" | "operator" | "promotes" | "billing_account";

export type PermissionKey =
  | "platform.user.suspend"
  | "booking.settings.manage"
  | "booking.reservation.read"
  | "pms.booking.update"
  | "pms.finance.read"
  | "marketplace.collaboration.review"
  | "marketplace.profile.manage"
  | "affiliate.payout.manage";

export type EntitlementStatus = "active" | "suspended" | "expired";

export type RequestSource = "web" | "admin" | "api" | "agent" | "migration";

export type ProviderIdentity = {
  provider: AuthProvider;
  providerUserId: string;
  sessionId?: string;
  providerOrganizationId?: string;
};

export type RequestActor = {
  internalUserId: string;
  providerIdentity: ProviderIdentity;
  email: string;
  status: InternalUserStatus;
};

export type SelectedOrganization = {
  organizationId: string;
  workosOrgId?: string;
  kind: OrganizationKind;
  status: OrganizationStatus;
};

export type ActiveMembership = {
  membershipId: string;
  status: MembershipStatus;
  roleKey: string;
  workosMembershipId?: string;
  workosRoleSlugs: string[];
  permissions: PermissionKey[];
};

export type LinkedResource = {
  product: Product;
  resourceType: ResourceType;
  resourceId: string;
  relationship: ResourceRelationship;
  status: "active" | "suspended" | "archived";
};

export type ProductEntitlement = {
  product: Product;
  key: string;
  status: EntitlementStatus;
  resource?: Pick<LinkedResource, "product" | "resourceType" | "resourceId">;
};

export type CompatibilityInput =
  | {
      kind: "legacy-jwt";
      userId: string;
    }
  | {
      kind: "x-hotel-id";
      hotelId: string;
      resolvedAs: Pick<LinkedResource, "product" | "resourceType" | "resourceId">;
    };

export type RequestAuditMetadata = {
  requestId: string;
  correlationId?: string;
  source: RequestSource;
  sourceIp?: string;
  userAgent?: string;
  receivedAt: string;
  compatibilityInputs?: CompatibilityInput[];
};

export type RequestContext = {
  actor: RequestActor;
  selectedOrganization: SelectedOrganization;
  membership: ActiveMembership;
  linkedResources: LinkedResource[];
  entitlements: ProductEntitlement[];
  locale: string;
  currency: string;
  audit: RequestAuditMetadata;
};

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
