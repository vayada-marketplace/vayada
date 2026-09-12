import {
  createProductReadinessResult,
  type ProductReadinessResult,
  type ReadinessProviderFailure,
} from "@vayada/domain-hotels";
import {
  BOOKING_PUBLICATION_OPERATION_STATUSES,
  BOOKING_PUBLICATION_FAILURE_CODES,
  type BookingPublicationOperation,
} from "@vayada/domain-booking";
import { targetApiClient } from "./targetClient";
export type BookingPublicationReview = {
  contractVersion: "booking-publication-review.v1";
  propertyId: string;
  activeContentRevisionId: string | null;
  latestOperation: BookingPublicationOperation | null;
  recoveredOperation: BookingPublicationOperation | null;
  readiness: ProductReadinessResult | ReadinessProviderFailure;
};
export type PublicationAttempt = {
  propertyId: string;
  idempotencyKey: string;
  body: {
    expectedActiveContentRevisionId: string | null;
    expectedSourceManifestHash: string;
    expectedReadinessHash: string;
  };
};
type Http = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  post<T>(path: string, value?: unknown, options?: RequestInit): Promise<T>;
};
export function createBookingPublicationReviewClient(http: Http) {
  return {
    async load(
      propertyId: string,
      idempotencyKey?: string,
      options?: RequestInit,
    ): Promise<BookingPublicationReview> {
      const raw = await http.get<BookingPublicationReview>(path(propertyId), {
        ...options,
        cache: "no-store",
        ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
      });
      if (
        !raw ||
        raw.contractVersion !== "booking-publication-review.v1" ||
        raw.propertyId !== propertyId ||
        !nullableUuid(raw.activeContentRevisionId)
      )
        throw invalid();
      const latestOperation =
        raw.latestOperation === null ? null : operation(raw.latestOperation, propertyId);
      const recoveredOperation =
        raw.recoveredOperation === null ? null : operation(raw.recoveredOperation, propertyId);
      const readiness = raw.readiness;
      if (
        !readiness ||
        readiness.contractVersion !== "onboarding-product-readiness.v1" ||
        readiness.propertyId !== propertyId ||
        readiness.product !== "booking"
      )
        throw invalid();
      if (readiness.outcome === "evaluated") {
        let verified: ProductReadinessResult;
        try {
          verified = await createProductReadinessResult(readiness);
        } catch {
          throw invalid();
        }
        if (
          verified.readinessHash !== readiness.readinessHash ||
          verified.sourceManifestHash !== readiness.sourceManifestHash
        )
          throw invalid();
        return { ...raw, latestOperation, recoveredOperation, readiness: verified };
      }
      if (
        readiness.outcome !== "provider_failure" ||
        readiness.status !== "error" ||
        readiness.error?.kind !== "system_error" ||
        !["provider", "system"].includes(readiness.error.errorSource) ||
        typeof readiness.error.message !== "string" ||
        !readiness.error.retryable
      )
        throw invalid();
      return { ...raw, latestOperation, recoveredOperation };
    },
    async publish(attempt: PublicationAttempt): Promise<BookingPublicationOperation> {
      if (
        !uuid(attempt.propertyId) ||
        !attempt.idempotencyKey.trim() ||
        attempt.idempotencyKey.length > 200 ||
        !nullableUuid(attempt.body.expectedActiveContentRevisionId) ||
        !hash(attempt.body.expectedSourceManifestHash) ||
        !hash(attempt.body.expectedReadinessHash)
      )
        throw invalid();
      const result = operation(
        await http.post<unknown>(path(attempt.propertyId), attempt.body, {
          headers: { "Idempotency-Key": attempt.idempotencyKey },
        }),
        attempt.propertyId,
      );
      if (result.expectedActiveContentRevisionId !== attempt.body.expectedActiveContentRevisionId)
        throw invalid();
      return result;
    },
  };
}
export const bookingPublicationReviewClient = createBookingPublicationReviewClient(targetApiClient);
function path(id: string) {
  return `/api/hotel-setup/properties/${encodeURIComponent(id)}/publications/booking`;
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
function nullableUuid(value: unknown) {
  return value === null || uuid(value);
}
function hash(value: unknown) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
function date(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function operation(raw: unknown, propertyId: string): BookingPublicationOperation {
  if (!raw || typeof raw !== "object") throw invalid();
  const value = raw as BookingPublicationOperation;
  if (
    value.propertyId !== propertyId ||
    !uuid(value.operationId) ||
    !BOOKING_PUBLICATION_OPERATION_STATUSES.includes(value.status) ||
    !nullableUuid(value.expectedActiveContentRevisionId) ||
    !nullableUuid(value.resultContentRevisionId) ||
    !(
      value.failureCode === null || BOOKING_PUBLICATION_FAILURE_CODES.includes(value.failureCode)
    ) ||
    !date(value.requestedAt) ||
    !date(value.updatedAt) ||
    !(value.completedAt === null || date(value.completedAt))
  )
    throw invalid();
  if (
    value.status === "succeeded" &&
    (!value.resultContentRevisionId || !value.completedAt || value.failureCode)
  )
    throw invalid();
  if (
    value.status === "failed" &&
    (!value.completedAt || !value.failureCode || value.resultContentRevisionId)
  )
    throw invalid();
  if (
    ["pending", "unknown"].includes(value.status) &&
    (value.completedAt || value.resultContentRevisionId)
  )
    throw invalid();
  return value;
}
function invalid() {
  return new Error(
    "Booking review data is invalid or belongs to another hotel. Refresh and try again.",
  );
}
