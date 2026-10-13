"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErrorResponse } from "@/services/api/client";
import type { PropertySetupStepId } from "@vayada/domain-hotels";
import {
  bookingPublicationReviewClient as client,
  type BookingPublicationReview,
  type PublicationAttempt,
} from "@/services/api/bookingPublicationReviewClient";
import {
  AdaptiveSaveError,
  AdaptiveStepCard,
  adaptivePrimaryButtonClass,
  adaptiveSecondaryButtonClass,
} from "../AdaptiveStepPrimitives";
import { adaptiveStepErrorMessage } from "../adaptiveSetupStepState";
import { ProductReadinessGroups } from "./ProductReadinessGroups";
import {
  clearRejectedBookingPublicationAttempt,
  readBookingPublicationAttempt,
  saveBookingPublicationAttempt,
} from "./bookingPublicationAttemptStorage";
type Props = {
  propertyId: string;
  organizationId: string;
  onEdit: (step: PropertySetupStepId, entityId?: string) => void;
};
const POLL_LIMIT = 5;
export function BookingReviewCard(props: Props) {
  return <ScopedBookingReviewCard key={`${props.organizationId}:${props.propertyId}`} {...props} />;
}
function ScopedBookingReviewCard({
  propertyId,
  organizationId,
  onEdit,
}: {
  propertyId: string;
  organizationId: string;
  onEdit: (step: PropertySetupStepId, entityId?: string) => void;
}) {
  const [review, setReview] = useState<BookingPublicationReview | null>(null);
  const [attempt, setAttempt] = useState<PublicationAttempt | null>(null);
  const savedAttempt = useRef<PublicationAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const mounted = useRef(false);
  const [pollCount, setPollCount] = useState(0);
  const [storageReady, setStorageReady] = useState(false);
  const [rejectedKey, setRejectedKey] = useState<string | null>(null);
  const rejected = !!attempt && rejectedKey === attempt.idempotencyKey;
  const refresh = useCallback(async () => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    setStorageReady(false);
    try {
      const stored = readBookingPublicationAttempt(window.localStorage, organizationId, propertyId);
      savedAttempt.current = stored;
      setAttempt(stored);
      const next = await client.load(propertyId, stored?.idempotencyKey);
      if (mounted.current) {
        setReview(next);
        setStorageReady(true);
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
  const latestPending =
    review?.latestOperation?.status === "pending" || review?.latestOperation?.status === "unknown";
  const operation = latestPending
    ? review?.latestOperation
    : attempt
      ? review?.recoveredOperation
      : review?.latestOperation;
  const pending = operation?.status === "pending" || operation?.status === "unknown";
  const automaticChecksStopped = pollCount >= POLL_LIMIT && !busy;
  useEffect(() => {
    if (!pending || pollCount >= POLL_LIMIT) return;
    const timer = setTimeout(() => {
      setPollCount((value) => value + 1);
      void refresh();
    }, 2000);
    return () => clearTimeout(timer);
  }, [pending, pollCount, refresh]);
  async function publish(retry = false) {
    if (active.current || !review || !storageReady) return;
    active.current = true;
    setBusy(true);
    setError(null);
    setPollCount(0);
    let requestKey: string | null = null;
    try {
      let next = savedAttempt.current;
      const storedNow = readBookingPublicationAttempt(
        window.localStorage,
        organizationId,
        propertyId,
      );
      if (storedNow?.idempotencyKey !== next?.idempotencyKey)
        throw new Error(
          "The saved publication request changed in another tab. Refresh its status before continuing.",
        );
      if (!retry) {
        if (review.readiness.outcome !== "evaluated" || review.readiness.status !== "ready")
          throw new Error("Refresh Booking readiness before publishing.");
        next = {
          propertyId,
          idempotencyKey: `booking-review:${crypto.randomUUID()}`,
          body: {
            expectedActiveContentRevisionId: review.activeContentRevisionId,
            expectedSourceManifestHash: review.readiness.sourceManifestHash,
            expectedReadinessHash: review.readiness.readinessHash,
          },
        };
        await saveBookingPublicationAttempt(
          window.localStorage,
          organizationId,
          next,
          savedAttempt.current?.idempotencyKey ?? null,
        );
        savedAttempt.current = next;
        setAttempt(next);
        setReview((current) => (current ? { ...current, recoveredOperation: null } : current));
        setRejectedKey(null);
      }
      if (!next)
        throw new Error("The publication request could not be restored. Refresh to recover it.");
      requestKey = next.idempotencyKey;
      const accepted = await client.publish(next);
      if (!mounted.current) return;
      setRejectedKey(null);
      if (mounted.current)
        setReview((current) =>
          current
            ? { ...current, recoveredOperation: accepted, latestOperation: accepted }
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
            "active_content_revision_conflict",
            "publication_in_progress",
          ].includes(String(cause.data.code))
        )
          setRejectedKey(requestKey);
      }
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function reviewLatestSettings() {
    const previous = savedAttempt.current;
    if (active.current || !previous || !rejected) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await client.load(propertyId, previous.idempotencyKey);
      if (!mounted.current) return;
      setReview(next);
      if (
        next.recoveredOperation ||
        next.latestOperation?.status === "pending" ||
        next.latestOperation?.status === "unknown"
      )
        return;
      await clearRejectedBookingPublicationAttempt(window.localStorage, organizationId, previous);
      savedAttempt.current = null;
      setAttempt(null);
      setRejectedKey(null);
    } catch (cause) {
      if (mounted.current) setError(adaptiveStepErrorMessage(cause));
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const unknownRequest = !!attempt && !!review && !review.recoveredOperation && !latestPending;
  // The first publication is the hotel's go-live; later saves go live by themselves (VAY-2129).
  const published = !!review?.activeContentRevisionId;
  // Guests can't open setup pages until the booking site switches over to them (VAY-2134).
  const waitingForSite = published && review?.publicSite === "waiting_for_switch";
  const canPublish =
    !published &&
    review?.readiness.outcome === "evaluated" &&
    review.readiness.status === "ready" &&
    storageReady &&
    !pending &&
    !unknownRequest;
  return (
    <AdaptiveStepCard>
      <h2 className="text-xl font-semibold">Booking Engine</h2>
      <p className="mt-2 text-sm text-gray-600">
        Publish your guest booking page independently of Marketplace review.
      </p>
      {error && <AdaptiveSaveError message={error} onRetry={() => void refresh()} />}
      {!review ? (
        <p role="status" className="mt-5 text-sm">
          {busy ? "Loading Booking review…" : "Booking review is unavailable."}
        </p>
      ) : (
        <>
          <p role="status" className="mt-5 font-semibold">
            {pending
              ? automaticChecksStopped
                ? "Publication still pending"
                : published
                  ? "Updating booking page…"
                  : "Publishing booking page…"
              : unknownRequest
                ? "Publication response unconfirmed"
                : operation?.status === "failed"
                  ? published
                    ? "Update failed · previous page remains published"
                    : "Publication failed"
                  : published
                    ? waitingForSite
                      ? "Published · guests can't see it yet"
                      : review.readiness.status === "ready"
                        ? "Live"
                        : "Live · needs attention"
                    : review.readiness.status === "ready"
                      ? "Ready to publish"
                      : review.readiness.status === "pending"
                        ? "Waiting"
                        : review.readiness.status === "error"
                          ? "Temporarily unavailable"
                          : "Needs attention"}
          </p>
          {published && !pending && !unknownRequest && operation?.status !== "failed" && (
            <p className="mt-2 text-sm text-gray-600">
              {waitingForSite
                ? `Your booking page is published. Guests can't open it yet because we're still switching the booking site over.${
                    review.readiness.status === "ready"
                      ? ""
                      : " Fix the items below so guests can book."
                  }`
                : review.readiness.status === "ready"
                  ? "Your booking page is live. Changes you save go live automatically."
                  : "Your booking page is live, but guests may not be able to book until the items below are fixed. Changes you save go live automatically."}
            </p>
          )}
          {!published && review.publicSite === "waiting_for_switch" && (
            <p className="mt-2 text-sm text-gray-600">
              Guests can open a published page once we finish switching the booking site over.
            </p>
          )}
          {pending && (
            <p className="mt-2 text-sm text-gray-600">
              {automaticChecksStopped
                ? "Your request is saved. Automatic checking stopped. Use Refresh Booking status to check the existing operation."
                : "Your request is saved. We’ll check the existing operation; you can leave setup and return."}
            </p>
          )}
          {unknownRequest && (
            <p className="mt-2 text-sm text-gray-600">
              {rejected
                ? "The server did not accept this request. Review the latest settings before creating another request."
                : "The request may still be processing. Check its status or retry the same request."}
            </p>
          )}
          {operation?.status === "failed" && (
            <p className="mt-2 text-sm text-gray-600">
              {operation.failureCode === "source_content_changed"
                ? "Hotel settings changed before publication. Review the latest settings before trying again."
                : "The booking page could not be updated. Refresh readiness before trying again."}
            </p>
          )}
          {published && !waitingForSite && review.publishedUrl && (
            <a
              href={review.publishedUrl}
              target="_blank"
              rel="noreferrer"
              className={`${adaptiveSecondaryButtonClass} mt-4 inline-flex`}
            >
              Open booking page
            </a>
          )}
          <ProductReadinessGroups readiness={review.readiness} onEdit={onEdit} />
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              className={adaptiveSecondaryButtonClass}
              disabled={busy}
              onClick={() => {
                setPollCount(0);
                void refresh();
              }}
            >
              {busy ? "Checking…" : "Refresh Booking status"}
            </button>
            {unknownRequest ? (
              <button
                type="button"
                disabled={busy}
                className={adaptivePrimaryButtonClass}
                onClick={() => void (rejected ? reviewLatestSettings() : publish(true))}
              >
                {rejected ? "Review latest settings" : "Retry saved publication request"}
              </button>
            ) : canPublish ? (
              <button
                type="button"
                disabled={busy}
                className={adaptivePrimaryButtonClass}
                onClick={() => void publish()}
              >
                Publish booking page
              </button>
            ) : null}
          </div>
        </>
      )}
    </AdaptiveStepCard>
  );
}
