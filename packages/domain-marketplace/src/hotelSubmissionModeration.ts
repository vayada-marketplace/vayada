import {
  MARKETPLACE_CREATOR_MODERATION_AUTHORIZATION,
  isMarketplaceCreatorModerationReason,
} from "./creatorProfileModeration.js";

export const MARKETPLACE_HOTEL_SUBMISSION_MODERATION_CONTRACT_VERSION =
  "marketplace-hotel-submission-moderation.v1" as const;

/** Same operators who moderate creator profiles review hotel submissions. */
export const MARKETPLACE_HOTEL_SUBMISSION_MODERATION_AUTHORIZATION =
  MARKETPLACE_CREATOR_MODERATION_AUTHORIZATION;

/** No permanent rejection yet: "request_changes" lets the hotel fix and resubmit. */
export const MARKETPLACE_HOTEL_SUBMISSION_DECISIONS = ["approve", "request_changes"] as const;

export type MarketplaceHotelSubmissionDecision =
  (typeof MARKETPLACE_HOTEL_SUBMISSION_DECISIONS)[number];

export type MarketplaceHotelSubmissionDecisionRequest =
  | { decision: "approve" }
  | { decision: "request_changes"; note: string };

export type MarketplaceHotelSubmissionDecisionResponse = {
  contractVersion: typeof MARKETPLACE_HOTEL_SUBMISSION_MODERATION_CONTRACT_VERSION;
  revisionId: string;
  propertyId: string;
  revisionNumber: number;
  status: "approved" | "changes_requested";
  note: string | null;
  decidedByUserId: string;
  decidedAt: string;
  /** Marketplace-web path of the now-public profile; null when nothing was published. */
  publicPath: string | null;
};

export type MarketplaceHotelSubmissionModerationErrorCode =
  | "submission_not_found"
  | "submission_already_decided"
  | "submission_superseded"
  | "property_unavailable"
  | "marketplace_profile_unavailable"
  | "marketplace_publication_suspended"
  | "marketplace_entitlement_inactive"
  | "submission_snapshot_invalid"
  | "idempotency_key_conflict";

export type MarketplaceHotelSubmissionDecisionResult =
  | { ok: true; response: MarketplaceHotelSubmissionDecisionResponse }
  | { ok: false; error: { code: MarketplaceHotelSubmissionModerationErrorCode } };

export type MarketplaceHotelSubmissionDecisionCommand = {
  revisionId: string;
  idempotencyKey: string;
  request: MarketplaceHotelSubmissionDecisionRequest;
  audit: {
    actorUserId: string;
    actorOrganizationId: string;
    requestId: string;
    correlationId: string | null;
    requestedAt: string;
  };
};

/** The note is shown to the hotel in setup: one line, 1-1,000 characters. */
export function isMarketplaceHotelSubmissionNote(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    isMarketplaceCreatorModerationReason(value)
  );
}

export function parseMarketplaceHotelSubmissionDecisionRequest(
  value: unknown,
): MarketplaceHotelSubmissionDecisionRequest | "invalid_decision" | "invalid_note" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid_decision";
  const raw = value as Record<string, unknown>;
  if (raw.decision === "approve" && Object.keys(raw).length === 1) return { decision: "approve" };
  if (raw.decision !== "request_changes" || Object.keys(raw).length !== 2)
    return "invalid_decision";
  return isMarketplaceHotelSubmissionNote(raw.note)
    ? { decision: "request_changes", note: raw.note }
    : "invalid_note";
}
