import type {
  AuthProvider,
  InternalUserStatus,
  MembershipStatus,
  OrganizationKind,
  OrganizationStatus,
  PermissionKey,
  Product,
  RequestSource,
  ResourceRelationship,
  ResourceType,
} from "./types.js";

export const identityLifecycleCommandTypes = [
  "identity.user.create",
  "identity.user.profile.update",
  "identity.user.email.update",
  "identity.user.status.update",
  "identity.user.suspend",
  "identity.user.delete",
  "identity.access.grant",
  "identity.access.revoke",
  "identity.recovery.flow.create",
  "identity.invite.affiliate.create",
  "identity.invite.customer.create",
] as const;

export type IdentityLifecycleCommandType = (typeof identityLifecycleCommandTypes)[number];

export const identityLifecycleEventTypes = [
  "identity.user.created",
  "identity.user.profile.updated",
  "identity.user.email.updated",
  "identity.user.status.updated",
  "identity.user.suspended",
  "identity.user.deleted",
  "identity.access.granted",
  "identity.access.revoked",
  "identity.recovery.flow.created",
  "identity.invite.affiliate.created",
  "identity.invite.customer.created",
] as const;

export type IdentityLifecycleEventType = (typeof identityLifecycleEventTypes)[number];

export type IdentityCommandActor =
  | {
      kind: "user";
      userId: string;
      organizationId?: string;
    }
  | {
      kind: "system";
      service: string;
    }
  | {
      kind: "migration";
      runId: string;
    };

export type IdentityCommandAudit = {
  actor: IdentityCommandActor;
  source: RequestSource;
  requestId: string;
  correlationId?: string;
  reason: string;
  requestedAt: string;
};

export type OrganizationCommandInput = {
  organizationId?: string;
  kind: OrganizationKind;
  name: string;
  slug?: string;
  status?: OrganizationStatus;
  workosOrgId?: string;
  workosExternalId?: string;
};

export type MembershipCommandInput = {
  organizationId?: string;
  userId?: string;
  status?: MembershipStatus;
  roleKey: string;
  permissionKeys?: readonly PermissionKey[];
  workosMembershipId?: string;
  workosRoleSlugs?: readonly string[];
  invitedAt?: string;
};

export type ResourceLinkCommandInput = {
  organizationId?: string;
  product: Product;
  resourceType: ResourceType;
  resourceId: string;
  relationship: ResourceRelationship;
  status?: "active" | "suspended" | "archived";
};

export type ProductResourceReference = {
  product: Product;
  resourceType: ResourceType;
  resourceId: string;
};

export type PermissionGrantCommandInput = {
  organizationKind: OrganizationKind;
  roleKey: string;
  permissionKey: PermissionKey;
};

export type ConsentCommandInput = {
  termsVersion?: string;
  privacyVersion?: string;
  marketingConsent?: boolean;
  acceptedAt?: string;
};

export type CreateIdentityUserPayload = {
  email: string;
  name?: string;
  initialStatus: InternalUserStatus;
  providerIdentity?: {
    provider: AuthProvider;
    providerUserId?: string;
    providerEmailVerified?: boolean;
  };
  consent?: ConsentCommandInput;
  organization?: OrganizationCommandInput;
  membership?: MembershipCommandInput;
  resourceLinks?: readonly ResourceLinkCommandInput[];
};

export type UpdateIdentityUserProfilePayload = {
  userId: string;
  name?: string;
};

export type UpdateIdentityUserEmailPayload = {
  userId: string;
  email: string;
  providerEmailVerified?: boolean;
};

export type UpdateIdentityUserStatusPayload = {
  userId: string;
  status: InternalUserStatus;
};

export type SuspendIdentityUserPayload = {
  userId: string;
  reason: string;
  suspendMemberships?: boolean;
  suspendResourceLinks?: boolean;
};

export type DeleteIdentityUserPayload = {
  userId: string;
  mode: "soft_delete" | "privacy_erasure";
  retainAuditUntil?: string;
};

export type GrantIdentityAccessPayload = {
  userId: string;
  organization: OrganizationCommandInput;
  membership: MembershipCommandInput;
  resourceLinks?: readonly ResourceLinkCommandInput[];
  permissionGrants?: readonly PermissionGrantCommandInput[];
};

export type RevokeIdentityAccessPayload = {
  userId: string;
  organizationId: string;
  membershipStatus?: Extract<MembershipStatus, "inactive" | "suspended">;
  resourceLinks?: readonly ProductResourceReference[];
  permissionGrants?: readonly PermissionGrantCommandInput[];
};

export type RecoveryFlowKind =
  | "account_recovery"
  | "password_reset"
  | "email_verification"
  | "email_change";

export type CreateIdentityRecoveryFlowPayload = {
  flowKind: RecoveryFlowKind;
  userId?: string;
  email?: string;
  newEmail?: string;
  redirectUrl?: string;
};

export type CreateAffiliateInvitePayload = {
  email: string;
  name?: string;
  organization: OrganizationCommandInput;
  membership: MembershipCommandInput;
  affiliateResourceLink: ResourceLinkCommandInput & {
    product: "affiliate";
    resourceType: "affiliate";
  };
};

export type CreateCustomerInvitePayload = {
  email: string;
  name?: string;
  bookingReference?: {
    bookingId?: string;
    hotelResource?: ProductResourceReference & {
      product: "booking";
      resourceType: "booking_hotel";
    };
  };
  // Customer accounts do not imply hotel ownership or staff membership.
  membership?: never;
  resourceLinks?: never;
};

export type IdentityLifecycleCommandBase<
  TCommandType extends IdentityLifecycleCommandType,
  TPayload,
> = {
  commandType: TCommandType;
  commandId: string;
  idempotencyKey: string;
  audit: IdentityCommandAudit;
  payload: TPayload;
};

export type CreateIdentityUserCommand = IdentityLifecycleCommandBase<
  "identity.user.create",
  CreateIdentityUserPayload
>;

export type UpdateIdentityUserProfileCommand = IdentityLifecycleCommandBase<
  "identity.user.profile.update",
  UpdateIdentityUserProfilePayload
>;

export type UpdateIdentityUserEmailCommand = IdentityLifecycleCommandBase<
  "identity.user.email.update",
  UpdateIdentityUserEmailPayload
>;

export type UpdateIdentityUserStatusCommand = IdentityLifecycleCommandBase<
  "identity.user.status.update",
  UpdateIdentityUserStatusPayload
>;

export type SuspendIdentityUserCommand = IdentityLifecycleCommandBase<
  "identity.user.suspend",
  SuspendIdentityUserPayload
>;

export type DeleteIdentityUserCommand = IdentityLifecycleCommandBase<
  "identity.user.delete",
  DeleteIdentityUserPayload
>;

export type GrantIdentityAccessCommand = IdentityLifecycleCommandBase<
  "identity.access.grant",
  GrantIdentityAccessPayload
>;

export type RevokeIdentityAccessCommand = IdentityLifecycleCommandBase<
  "identity.access.revoke",
  RevokeIdentityAccessPayload
>;

export type CreateIdentityRecoveryFlowCommand = IdentityLifecycleCommandBase<
  "identity.recovery.flow.create",
  CreateIdentityRecoveryFlowPayload
>;

export type CreateAffiliateInviteCommand = IdentityLifecycleCommandBase<
  "identity.invite.affiliate.create",
  CreateAffiliateInvitePayload
>;

export type CreateCustomerInviteCommand = IdentityLifecycleCommandBase<
  "identity.invite.customer.create",
  CreateCustomerInvitePayload
>;

export type IdentityLifecycleCommand =
  | CreateIdentityUserCommand
  | UpdateIdentityUserProfileCommand
  | UpdateIdentityUserEmailCommand
  | UpdateIdentityUserStatusCommand
  | SuspendIdentityUserCommand
  | DeleteIdentityUserCommand
  | GrantIdentityAccessCommand
  | RevokeIdentityAccessCommand
  | CreateIdentityRecoveryFlowCommand
  | CreateAffiliateInviteCommand
  | CreateCustomerInviteCommand;

export type IdentityLifecycleEvent = {
  eventType: IdentityLifecycleEventType;
  eventId: string;
  commandId: string;
  idempotencyKey: string;
  userId?: string;
  organizationId?: string;
  resourceLinks?: readonly ResourceLinkCommandInput[];
  occurredAt: string;
  audit: IdentityCommandAudit;
};

export type IdentityLifecycleCommandResult = {
  status: "accepted" | "idempotent_replay";
  commandId: string;
  idempotencyKey: string;
  userId?: string;
  organizationId?: string;
  events: readonly IdentityLifecycleEvent[];
};

export interface IdentityLifecycleCommandBus {
  execute(command: IdentityLifecycleCommand): Promise<IdentityLifecycleCommandResult>;
}

export function identityLifecycleIdempotencyScope(command: IdentityLifecycleCommand): string {
  return `${command.commandType}:${command.idempotencyKey}`;
}
