"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PropertySetupStepId } from "@vayada/domain-hotels";
import { ApiErrorResponse } from "@/services/api/client";
import {
  marketplaceSubmissionReviewClient as client,
  type MarketplaceSubmissionReview,
  type MarketplaceSubmissionAttempt,
} from "@/services/api/marketplaceSubmissionReviewClient";
import {
  AdaptiveStepCard,
  AdaptiveSaveError,
  adaptivePrimaryButtonClass,
  adaptiveSecondaryButtonClass,
} from "../AdaptiveStepPrimitives";
import { adaptiveStepErrorMessage } from "../adaptiveSetupStepState";
import { ProductReadinessGroups } from "./ProductReadinessGroups";
import {
  readMarketplaceSubmissionAttempt,
  saveMarketplaceSubmissionAttempt,
  clearRejectedMarketplaceSubmissionAttempt,
} from "./marketplaceSubmissionAttemptStorage";
type Props = {
  propertyId: string;
  organizationId: string;
  onEdit: (step: PropertySetupStepId, entityId?: string) => void;
};
export function MarketplaceReviewCard(props: Props) {
  return (
    <ScopedMarketplaceReviewCard key={`${props.organizationId}:${props.propertyId}`} {...props} />
  );
}
function ScopedMarketplaceReviewCard({ propertyId, organizationId, onEdit }: Props) {
  const [review, setReview] = useState<MarketplaceSubmissionReview | null>(null);
  const [attempt, setAttempt] = useState<MarketplaceSubmissionAttempt | null>(null);
  const saved = useRef<MarketplaceSubmissionAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [readable, setReadable] = useState(false);
  const [rejectedKey, setRejectedKey] = useState<string | null>(null);
  const active = useRef(false);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setReadable(false);
    setError(null);
    try {
      const stored = readMarketplaceSubmissionAttempt(
        window.localStorage,
        organizationId,
        propertyId,
      );
      saved.current = stored;
      setAttempt(stored);
      const next = await client.load(propertyId, stored?.idempotencyKey);
      if (mounted.current) {
        setReview(next);
        setReadable(true);
      }
    } catch (cause) {
      if (mounted.current) setError(adaptiveStepErrorMessage(cause));
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [organizationId, propertyId]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  const pending =
    review?.latestSubmission?.status === "pending" ||
    review?.recoveredSubmission?.status === "pending";
  const unknown = !!attempt && !!review && !review.recoveredSubmission && !pending;
  const rejected = !!attempt && rejectedKey === attempt.idempotencyKey;
  const suspended = review?.activeSubmission?.status === "suspended";
  const published = review?.activeSubmission?.status === "active";
  async function submit(retry = false) {
    if (active.current || !review || !readable) return;
    active.current = true;
    setBusy(true);
    setError(null);
    let requestKey: string | null = null;
    try {
      let next = saved.current;
      if (
        readMarketplaceSubmissionAttempt(window.localStorage, organizationId, propertyId)
          ?.idempotencyKey !== next?.idempotencyKey
      )
        throw new Error("The submission request changed in another tab. Refresh its status.");
      if (!retry) {
        if (
          pending ||
          suspended ||
          review.readiness.outcome !== "evaluated" ||
          review.readiness.status !== "ready"
        )
          throw new Error("Refresh Marketplace readiness before submitting.");
        next = {
          propertyId,
          idempotencyKey: `marketplace-review:${crypto.randomUUID()}`,
          body: {
            expectedLatestSubmissionRevisionId: review.latestSubmission?.revisionId ?? null,
            expectedSourceManifestHash: review.readiness.sourceManifestHash,
            expectedReadinessHash: review.readiness.readinessHash,
          },
        };
        await saveMarketplaceSubmissionAttempt(
          window.localStorage,
          organizationId,
          next,
          saved.current?.idempotencyKey ?? null,
        );
        saved.current = next;
        setAttempt(next);
        setRejectedKey(null);
        setReview((current) => (current ? { ...current, recoveredSubmission: null } : current));
      }
      if (!next) throw new Error("Refresh to restore the saved submission request.");
      requestKey = next.idempotencyKey;
      const accepted = await client.submit(next);
      if (!mounted.current) return;
      setRejectedKey(null);
      setReview((current) =>
        current
          ? { ...current, latestSubmission: accepted, recoveredSubmission: accepted }
          : current,
      );
      const refreshed = await client.load(propertyId, next.idempotencyKey);
      if (mounted.current) setReview(refreshed);
    } catch (cause) {
      if (mounted.current) {
        setError(adaptiveStepErrorMessage(cause));
        if (
          cause instanceof ApiErrorResponse &&
          cause.status === 409 &&
          [
            "invalid_readiness_evidence",
            "submission_revision_conflict",
            "submission_pending_review",
          ].includes(String(cause.data.code))
        )
          setRejectedKey(requestKey);
      }
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function reviewLatest() {
    const previous = saved.current;
    if (active.current || !previous || !rejected) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await client.load(propertyId, previous.idempotencyKey);
      if (!mounted.current) return;
      setReview(next);
      if (next.recoveredSubmission || next.latestSubmission?.status === "pending") return;
      await clearRejectedMarketplaceSubmissionAttempt(
        window.localStorage,
        organizationId,
        previous,
      );
      saved.current = null;
      setAttempt(null);
      setRejectedKey(null);
    } catch (cause) {
      if (mounted.current) setError(adaptiveStepErrorMessage(cause));
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const latest = review?.latestSubmission;
  const canSubmit =
    readable && !pending && !unknown && !suspended && review?.readiness.status === "ready";
  return (
    <AdaptiveStepCard>
      <h2 className="text-xl font-semibold">Creator Marketplace</h2>
      <p className="mt-2 text-sm text-gray-600">
        Submit your hotel profile for Vayada review. Booking Engine publication is separate.
      </p>
      {error && <AdaptiveSaveError message={error} onRetry={() => void refresh()} />}
      {!review ? (
        <p role="status" className="mt-5 text-sm">
          {busy ? "Loading Marketplace review…" : "Marketplace review is unavailable."}
        </p>
      ) : (
        <>
          <p role="status" className="mt-5 font-semibold">
            {pending
              ? "Pending review"
              : unknown
                ? "Submission response unconfirmed"
                : suspended
                  ? "Suspended"
                  : latest?.status === "changes_requested"
                    ? "Changes requested"
                    : latest?.status === "rejected"
                      ? "Submission rejected"
                      : published
                        ? "Published"
                        : latest?.status === "approved"
                          ? "Approved · awaiting publication"
                          : review.readiness.status === "ready"
                            ? "Ready to submit"
                            : review.readiness.status === "error"
                              ? "Temporarily unavailable"
                              : "Needs attention"}
          </p>
          {pending && (
            <p className="mt-2 text-sm text-gray-600">
              Your profile was submitted. Vayada will review this saved version. You can leave setup
              and return to check its status.
            </p>
          )}
          {unknown && (
            <p className="mt-2 text-sm text-gray-600">
              {rejected
                ? "The server did not accept this request. Review the latest settings before submitting again."
                : "Check its status or retry the saved submission to avoid sending a second request."}
            </p>
          )}
          {suspended && (
            <p className="mt-2 text-sm text-gray-600">
              Your profile is not public. Contact Vayada about reinstatement; editing your profile
              does not restore publication.
            </p>
          )}
          {(latest?.status === "changes_requested" || latest?.status === "rejected") && (
            <div className="mt-3 text-sm">
              <p>
                {latest.decisionReason ??
                  "Review your hotel profile and collaboration preferences before submitting again."}
              </p>
              <button
                type="button"
                className="mt-2 font-semibold text-primary-700"
                onClick={() => onEdit("present_hotel", propertyId)}
              >
                Edit hotel profile
              </button>
            </div>
          )}
          {published && (
            <p className="mt-4 text-sm text-gray-600">
              Your approved profile is active. Its public Marketplace page is currently unavailable.
            </p>
          )}
          <ProductReadinessGroups readiness={review.readiness} onEdit={onEdit} />
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              className={adaptiveSecondaryButtonClass}
              onClick={() => void refresh()}
            >
              {busy ? "Checking…" : "Refresh Marketplace status"}
            </button>
            {unknown ? (
              <button
                type="button"
                disabled={busy || !readable}
                className={adaptivePrimaryButtonClass}
                onClick={() => void (rejected ? reviewLatest() : submit(true))}
              >
                {rejected ? "Review latest settings" : "Retry saved submission request"}
              </button>
            ) : canSubmit ? (
              <button
                type="button"
                disabled={busy}
                className={adaptivePrimaryButtonClass}
                onClick={() => void submit()}
              >
                {latest ? "Resubmit to Marketplace" : "Submit to Marketplace"}
              </button>
            ) : null}
          </div>
        </>
      )}
    </AdaptiveStepCard>
  );
}
