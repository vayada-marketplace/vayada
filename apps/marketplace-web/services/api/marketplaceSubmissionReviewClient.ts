import {
  createProductReadinessResult,
  MARKETPLACE_MODERATION_STATUSES,
  MARKETPLACE_ACTIVATION_STATUSES,
  type MarketplaceModerationStatus,
  type MarketplaceActivationStatus,
  type ProductReadinessResult,
  type ReadinessProviderFailure,
} from "@vayada/domain-hotels";
import { targetApiClient } from "./targetClient";
export type MarketplaceSubmissionReceipt = {
  revisionId: string;
  propertyId: string;
  revisionNumber: number;
  status: MarketplaceModerationStatus;
  submittedAt: string;
  decisionReason: string | null;
};
export type MarketplaceSubmissionReview = {
  contractVersion: "marketplace-submission-review.v1";
  propertyId: string;
  latestSubmission: MarketplaceSubmissionReceipt | null;
  recoveredSubmission: MarketplaceSubmissionReceipt | null;
  activeSubmission: { revisionId: string; status: MarketplaceActivationStatus } | null;
  readiness: ProductReadinessResult | ReadinessProviderFailure;
};
export type MarketplaceSubmissionAttempt = {
  propertyId: string;
  idempotencyKey: string;
  body: {
    expectedLatestSubmissionRevisionId: string | null;
    expectedSourceManifestHash: string;
    expectedReadinessHash: string;
  };
};
type Http = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  post<T>(path: string, value?: unknown, options?: RequestInit): Promise<T>;
};
export function createMarketplaceSubmissionReviewClient(http: Http) {
  return {
    async load(propertyId: string, idempotencyKey?: string): Promise<MarketplaceSubmissionReview> {
      if (!uuid(propertyId)) throw invalid();
      const raw = await http.get<MarketplaceSubmissionReview>(
        `${path(propertyId)}/submission-review`,
        {
          cache: "no-store",
          ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
        },
      );
      if (
        !raw ||
        raw.contractVersion !== "marketplace-submission-review.v1" ||
        raw.propertyId !== propertyId
      )
        throw invalid();
      const latestSubmission =
        raw.latestSubmission === null ? null : receipt(raw.latestSubmission, propertyId);
      const recoveredSubmission =
        raw.recoveredSubmission === null ? null : receipt(raw.recoveredSubmission, propertyId);
      if (
        raw.activeSubmission !== null &&
        (!raw.activeSubmission ||
          !uuid(raw.activeSubmission.revisionId) ||
          !MARKETPLACE_ACTIVATION_STATUSES.includes(raw.activeSubmission.status))
      )
        throw invalid();
      const readiness = raw.readiness;
      if (
        !readiness ||
        readiness.propertyId !== propertyId ||
        readiness.product !== "marketplace" ||
        readiness.contractVersion !== "onboarding-product-readiness.v1"
      )
        throw invalid();
      if (readiness.outcome === "evaluated") {
        const verified = await createProductReadinessResult(readiness);
        if (
          verified.sourceManifestHash !== readiness.sourceManifestHash ||
          verified.readinessHash !== readiness.readinessHash ||
          verified.groups.length !== 2 ||
          !verified.groups.some((group) => group.groupId === "marketplace.hotel_profile") ||
          !verified.groups.some(
            (group) => group.groupId === "marketplace.collaboration_preferences",
          )
        )
          throw invalid();
        return { ...raw, latestSubmission, recoveredSubmission, readiness: verified };
      }
      if (
        readiness.outcome !== "provider_failure" ||
        readiness.status !== "error" ||
        readiness.error?.kind !== "system_error" ||
        !["system", "provider"].includes(readiness.error.errorSource) ||
        typeof readiness.error.message !== "string" ||
        !readiness.error.retryable
      )
        throw invalid();
      return { ...raw, latestSubmission, recoveredSubmission };
    },
    async submit(attempt: MarketplaceSubmissionAttempt): Promise<MarketplaceSubmissionReceipt> {
      if (
        !uuid(attempt.propertyId) ||
        !attempt.idempotencyKey.trim() ||
        attempt.idempotencyKey.length > 200 ||
        !(
          attempt.body.expectedLatestSubmissionRevisionId === null ||
          uuid(attempt.body.expectedLatestSubmissionRevisionId)
        ) ||
        !hash(attempt.body.expectedSourceManifestHash) ||
        !hash(attempt.body.expectedReadinessHash)
      )
        throw invalid();
      const result = receipt(
        await http.post(`${path(attempt.propertyId)}/submissions`, attempt.body, {
          headers: { "Idempotency-Key": attempt.idempotencyKey },
        }),
        attempt.propertyId,
      );
      if (result.status !== "pending") throw invalid();
      return result;
    },
  };
}
export const marketplaceSubmissionReviewClient =
  createMarketplaceSubmissionReviewClient(targetApiClient);
function path(id: string) {
  return `/api/marketplace/properties/${encodeURIComponent(id)}`;
}
function receipt(raw: unknown, propertyId: string): MarketplaceSubmissionReceipt {
  if (!raw || typeof raw !== "object") throw invalid();
  const value = raw as MarketplaceSubmissionReceipt;
  if (
    value.propertyId !== propertyId ||
    !uuid(value.revisionId) ||
    !Number.isSafeInteger(value.revisionNumber) ||
    value.revisionNumber < 1 ||
    !MARKETPLACE_MODERATION_STATUSES.includes(value.status) ||
    typeof value.submittedAt !== "string" ||
    !Number.isFinite(Date.parse(value.submittedAt)) ||
    !(value.decisionReason === null || typeof value.decisionReason === "string")
  )
    throw invalid();
  return value;
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
function hash(value: unknown) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
function invalid() {
  return new Error("Marketplace review could not be verified. Refresh and try again.");
}
