/**
 * @vayada/domain-marketplace
 *
 * Typed contracts for Marketplace domain operations. These interfaces define
 * the boundary between Marketplace and downstream domains (Finance/Affiliate)
 * so that Marketplace collaboration acceptance never opens PMS raw tables
 * directly.
 *
 * VAY-653: Replace Marketplace-to-PMS affiliate provisioning cross-DB write.
 */

// ---------------------------------------------------------------------------
// Shared scalar types
// ---------------------------------------------------------------------------

export type MarketplaceUtcDateTime = string;
export type MarketplaceDecimalAmount = string;
export type MarketplaceCurrencyCode = string;

// ---------------------------------------------------------------------------
// Collaboration lifecycle
// ---------------------------------------------------------------------------

export const COLLABORATION_STATUSES = [
  "pending",
  "accepted",
  "active",
  "completed",
  "cancelled",
  "rejected",
] as const;

export type CollaborationStatus = (typeof COLLABORATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Affiliate / referral contract
// ---------------------------------------------------------------------------

/**
 * Ownership of affiliate provisioning contract version.
 * Increment when the command shape changes in a breaking way.
 */
export const MARKETPLACE_AFFILIATE_CONTRACT_VERSION = "marketplace-affiliate.v1" as const;

export type MarketplaceAffiliateContractVersion = typeof MARKETPLACE_AFFILIATE_CONTRACT_VERSION;

/**
 * The status an affiliate can be in after provisioning.
 * Mirrors downstream Finance/affiliate domain — kept minimal here.
 */
export const AFFILIATE_PROVISIONING_STATUSES = ["provisioned", "already_exists", "failed"] as const;

export type AffiliateProvisioningStatus = (typeof AFFILIATE_PROVISIONING_STATUSES)[number];

/**
 * Audit context attached to every command emitted by Marketplace.
 */
export type MarketplaceCommandAudit = {
  requestId: string;
  correlationId: string;
  causationId?: string;
  /** Internal Vayada organization ID for the hotel business. */
  organizationId: string;
  /** Internal Vayada organization ID for the creator workspace. */
  creatorOrganizationId: string;
  actorType: "creator" | "hotel_user" | "platform_admin" | "system";
  actorId?: string;
  source: "marketplace_web" | "marketplace_admin" | "job_retry" | "migration" | "test";
  occurredAt: MarketplaceUtcDateTime;
};

// ---------------------------------------------------------------------------
// ProvisionCollaborationAffiliateCommand
//
// Emitted by Marketplace when a collaboration is accepted and an affiliate
// referral link is needed. The Finance/affiliate domain owns provisioning;
// Marketplace never touches PMS tables.
// ---------------------------------------------------------------------------

/**
 * Creator identity fields needed so the downstream domain can create the
 * affiliate record without calling back into Marketplace.
 */
export type AffiliateCreatorIdentity = {
  creatorId: string;
  creatorName: string | null;
  creatorEmail: string | null;
  /** Comma-separated "Platform: @handle" pairs, e.g. "Instagram: @ada". */
  socialMediaSummary?: string | null;
};

/**
 * Hotel-side resource references. Marketplace owns the `marketplaceHotelProfileId`;
 * downstream Finance/affiliate domain resolves the canonical `propertyId` and
 * `pmsHotelId` via the organization resource link — it never receives them from
 * Marketplace directly, to avoid cross-domain coupling.
 */
export type AffiliateHotelReference = {
  /** Marketplace hotel profile ID (Marketplace's authoritative resource). */
  marketplaceHotelProfileId: string;
  /** Internal organization ID of the hotel group (from RequestContext). */
  organizationId: string;
};

/**
 * Commission terms agreed in the collaboration offer.
 * Expressed as a decimal percentage string, e.g. "5.00".
 * The downstream domain applies its own floor/cap rules.
 */
export type AffiliateCommissionTerms = {
  commissionPct: MarketplaceDecimalAmount;
  currency?: MarketplaceCurrencyCode | null;
};

/**
 * Derives a stable `commandId` from an idempotency key.
 *
 * `commandId` identifies this specific command envelope; `idempotencyKey`
 * scopes deduplication in the downstream domain. Both are derived from the
 * collaboration ID so that retries carry the same identifiers end-to-end.
 *
 * @example
 * const idempotencyKey = buildAffiliateProvisioningIdempotencyKey({ collaborationId });
 * const commandId = buildAffiliateProvisioningCommandId({ idempotencyKey });
 * // commandId === `cmd:${idempotencyKey}`
 */
export function buildAffiliateProvisioningCommandId(input: { idempotencyKey: string }): string {
  return `cmd:${input.idempotencyKey}`;
}

/**
 * Command: Marketplace requests affiliate provisioning when a collaboration
 * is accepted. This is the single typed boundary that replaces the cross-DB
 * write in `affiliate.py`.
 *
 * Idempotency guarantee: downstream domain must treat commands with the same
 * `idempotencyKey` as a no-op after the first successful processing.
 *
 * Derive `commandId` deterministically using `buildAffiliateProvisioningCommandId`
 * and `idempotencyKey` using `buildAffiliateProvisioningIdempotencyKey` so that
 * retries carry the same identifiers without caller-side state.
 */
export type ProvisionCollaborationAffiliateCommand = {
  contractVersion: MarketplaceAffiliateContractVersion;
  commandId: string;
  idempotencyKey: string;
  audit: MarketplaceCommandAudit;
  collaboration: {
    collaborationId: string;
    status: Extract<CollaborationStatus, "accepted">;
    acceptedAt: MarketplaceUtcDateTime;
  };
  creator: AffiliateCreatorIdentity;
  hotel: AffiliateHotelReference;
  commissionTerms: AffiliateCommissionTerms;
};

// ---------------------------------------------------------------------------
// AffiliateProvisioningResult
//
// Returned to (or consumed by) Marketplace after the command is processed.
// Marketplace stores the referral output on the collaboration row; it never
// touches the affiliate table itself.
// ---------------------------------------------------------------------------

/**
 * Public referral output that Marketplace UI and Booking attribution consume.
 * Owned by the Finance/affiliate domain; delivered back through this contract.
 */
export type CollaborationReferralOutput = {
  /** Stable affiliate ID in the Finance/affiliate domain. */
  affiliateId: string;
  /** Short referral code used in booking URLs, e.g. "aB3xQ1yZ". */
  referralCode: string;
  /** Fully-qualified referral link for the booking surface. */
  referralLink: string;
  /** ISO 8601 timestamp when this affiliate record was provisioned. */
  provisionedAt: MarketplaceUtcDateTime;
};

export type AffiliateProvisioningResult =
  | {
      contractVersion: MarketplaceAffiliateContractVersion;
      commandId: string;
      idempotencyKey: string;
      collaborationId: string;
      status: Extract<AffiliateProvisioningStatus, "provisioned" | "already_exists">;
      referralOutput: CollaborationReferralOutput;
      error?: never;
    }
  | {
      contractVersion: MarketplaceAffiliateContractVersion;
      commandId: string;
      idempotencyKey: string;
      collaborationId: string;
      status: Extract<AffiliateProvisioningStatus, "failed">;
      referralOutput?: never;
      error: AffiliateProvisioningError;
    };

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

export const AFFILIATE_PROVISIONING_ERROR_CODES = [
  "HOTEL_NOT_FOUND",
  "CREATOR_NOT_FOUND",
  "DUPLICATE_AFFILIATE",
  "COMMISSION_INVALID",
  "RETRYABLE_DOWNSTREAM_FAILURE",
  "IDEMPOTENCY_CONFLICT",
  "VALIDATION_FAILED",
] as const;

export type AffiliateProvisioningErrorCode = (typeof AFFILIATE_PROVISIONING_ERROR_CODES)[number];

export type AffiliateProvisioningError = {
  code: AffiliateProvisioningErrorCode;
  retryable: boolean;
  sanitizedMessage: string;
};

// ---------------------------------------------------------------------------
// Service port — the interface Marketplace calls; Finance/affiliate implements
// ---------------------------------------------------------------------------

/**
 * The typed port Marketplace calls when a collaboration is accepted and
 * requires affiliate/referral provisioning.
 *
 * Finance/affiliate domain provides a concrete implementation. Marketplace
 * depends only on this interface — never on PMS tables, `PMS_DATABASE_URL`,
 * or any PMS-internal adapter.
 */
export interface CollaborationAffiliatePort {
  /**
   * Provision an affiliate and return referral output for the collaboration.
   * Implementations must be idempotent on `command.idempotencyKey`.
   */
  provisionAffiliate(
    command: ProvisionCollaborationAffiliateCommand,
  ): Promise<AffiliateProvisioningResult>;
}

// ---------------------------------------------------------------------------
// Idempotency key helper
// ---------------------------------------------------------------------------

/**
 * Builds a stable idempotency key for affiliate provisioning from a
 * collaboration ID. Callers should pass this into `commandId` derivation
 * and the command's `idempotencyKey` field.
 */
export function buildAffiliateProvisioningIdempotencyKey(input: {
  collaborationId: string;
}): string {
  return `marketplace.affiliate.provision:collaboration:${input.collaborationId}:v1`;
}

// ---------------------------------------------------------------------------
// Collaboration acceptance event — emitted by Marketplace
// ---------------------------------------------------------------------------

/**
 * Domain event published when a collaboration transitions to `accepted`.
 * Downstream subscribers (Finance/affiliate, notifications, analytics) react
 * to this event rather than being directly called by the collaboration router.
 *
 * This event is an immutable snapshot of the acceptance facts. It must NOT
 * carry provisioning output — that arrives later via AffiliateProvisionedEvent
 * once the Finance/affiliate domain completes its work.
 */
export type CollaborationAcceptedEvent = {
  readonly eventType: "marketplace.collaboration.accepted";
  readonly eventId: string;
  /** The command or action that caused this event. */
  readonly causationId?: string;
  readonly collaborationId: string;
  readonly creatorId: string;
  readonly marketplaceHotelProfileId: string;
  readonly organizationId: string;
  readonly acceptedAt: MarketplaceUtcDateTime;
  /** Whether affiliate provisioning was requested as part of this acceptance. */
  readonly affiliateProvisioningRequested: boolean;
  readonly audit: Readonly<MarketplaceCommandAudit>;
};

// ---------------------------------------------------------------------------
// AffiliateProvisionedEvent — emitted after provisioning completes
// ---------------------------------------------------------------------------

/**
 * Domain event published when the Finance/affiliate domain successfully
 * provisions an affiliate for a collaboration. This is a separate, immutable
 * snapshot carrying the referral output — it must not be conflated with
 * CollaborationAcceptedEvent, which records only the acceptance facts.
 *
 * Marketplace stores the referral output on the collaboration row upon
 * receiving this event. It never writes the affiliate table itself.
 */
export type AffiliateProvisionedEvent = {
  readonly eventType: "marketplace.affiliate.provisioned";
  readonly eventId: string;
  /** The commandId from the ProvisionCollaborationAffiliateCommand that triggered provisioning. */
  readonly causationId: string;
  readonly collaborationId: string;
  readonly idempotencyKey: string;
  readonly referralOutput: Readonly<CollaborationReferralOutput>;
  readonly audit: Readonly<MarketplaceCommandAudit>;
};
