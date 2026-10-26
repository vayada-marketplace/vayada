"use client";

import type { ProductReadinessResult, ReadinessProviderFailure } from "@vayada/domain-hotels";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BookingPublicationReview,
  PublicationAttempt,
} from "@/services/api/bookingPublicationReviewClient";
import { ApiErrorResponse } from "@/services/api/client";

import {
  clearRejectedBookingPublicationAttempt,
  readBookingPublicationAttempt,
  saveBookingPublicationAttempt,
} from "../adaptive/final/bookingPublicationAttemptStorage";

export type QuickPublicationClient = {
  load(propertyId: string, idempotencyKey?: string): Promise<BookingPublicationReview>;
  publish(attempt: PublicationAttempt): Promise<unknown>;
};

export type QuickPublicationState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "publishing" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "live"; url: string | null }>;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Where a hotel's publication stands, from the review and the request saved on this device. */
type Situation =
  | { kind: "live"; url: string | null }
  | { kind: "publishing" }
  /** A saved request the server doesn't know: it may never have arrived, so it is sent again. */
  | { kind: "unconfirmed" }
  | { kind: "failed"; message: string }
  | { kind: "blocked"; message: string }
  | { kind: "ready" }
  | { kind: "unavailable"; message: string };

const POLL_MS = 2000;
/** About 30 seconds of checking before the host is asked to try again. */
const POLL_LIMIT = 15;
const REJECTED = [
  "invalid_readiness_evidence",
  "active_content_revision_conflict",
  "publication_in_progress",
];
const TRY_AGAIN = "Something went wrong on our side. Try again in a minute.";
const CHANGED = "Your hotel changed while we were publishing. Try again.";

/** Why the booking page can't be published yet, in the hotel's words (the first open item). */
export function quickReadinessMessage(
  readiness: ProductReadinessResult | ReadinessProviderFailure,
): string | null {
  if (readiness.outcome !== "evaluated")
    return "We can't check your booking page right now. Try again in a minute.";
  if (readiness.status === "ready") return null;
  for (const group of readiness.groups)
    for (const step of group.steps)
      for (const entity of step.entities)
        for (const blocker of entity.blockers)
          return blocker.kind === "external_pending"
            ? `${blocker.message} This usually sorts itself out within a minute.`
            : blocker.message;
  return TRY_AGAIN;
}

function situationOf(
  review: BookingPublicationReview,
  saved: PublicationAttempt | null,
): Situation {
  if (review.activeContentRevisionId) return { kind: "live", url: review.publishedUrl };
  const latest = review.latestOperation;
  if (latest?.status === "pending" || latest?.status === "unknown") return { kind: "publishing" };
  if (saved) {
    const operation = review.recoveredOperation;
    if (!operation) return { kind: "unconfirmed" };
    if (operation.status === "pending" || operation.status === "unknown")
      return { kind: "publishing" };
    if (operation.status === "failed")
      return {
        kind: "failed",
        message: operation.failureCode === "source_content_changed" ? CHANGED : TRY_AGAIN,
      };
  }
  const blocked = quickReadinessMessage(review.readiness);
  if (!blocked) return { kind: "ready" };
  return review.readiness.outcome === "evaluated"
    ? { kind: "blocked", message: blocked }
    : { kind: "unavailable", message: blocked };
}

const canPublish = (review: BookingPublicationReview | null) =>
  !!review && review.readiness.outcome === "evaluated" && review.readiness.status === "ready";

/**
 * VAY-2247 step 5: publishes the booking page with the same review and publish API, and the same request
 * saved on this device, as the setup "Booking Engine" card. Then it checks until the page is live.
 */
export function useQuickPublication({
  propertyId,
  organizationId,
  client,
  storage,
}: {
  propertyId: string;
  organizationId: string;
  client: QuickPublicationClient;
  storage: Store;
}) {
  const [state, setState] = useState<QuickPublicationState>({ kind: "loading" });
  // Hosts may pass new objects on every render; only the hotel decides when to load again.
  const io = useRef({ client, storage });
  useEffect(() => {
    io.current = { client, storage };
  }, [client, storage]);
  const review = useRef<BookingPublicationReview | null>(null);
  const polls = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  /** A failure is only shown for a request sent from this page; older ones don't block a new one. */
  const sentHere = useRef(false);

  const show = useCallback((next: QuickPublicationState) => {
    if (mounted.current) setState(next);
  }, []);

  const view = useCallback((situation: Situation): QuickPublicationState => {
    switch (situation.kind) {
      case "live":
      case "publishing":
      case "ready":
        return situation;
      case "unconfirmed":
        return {
          kind: "failed",
          message: "We couldn't confirm that your booking page was published. Try again.",
        };
      case "failed":
        return sentHere.current || !canPublish(review.current) ? situation : { kind: "ready" };
      case "blocked":
      case "unavailable":
        return { kind: "failed", message: situation.message };
    }
  }, []);

  const load = useCallback(async (): Promise<Situation> => {
    try {
      const { client, storage } = io.current;
      const saved = readBookingPublicationAttempt(storage, organizationId, propertyId);
      review.current = await client.load(propertyId, saved?.idempotencyKey);
      return situationOf(review.current, saved);
    } catch (error) {
      return { kind: "unavailable", message: error instanceof Error ? error.message : TRY_AGAIN };
    }
  }, [organizationId, propertyId]);

  const check = useCallback(async () => {
    const situation = await load();
    if (situation.kind === "publishing" && polls.current >= POLL_LIMIT)
      return show({
        kind: "failed",
        message: "Publishing is taking longer than usual. Try again in a minute.",
      });
    show(view(situation));
  }, [load, show, view]);

  useEffect(() => {
    mounted.current = true;
    void check();
    return () => {
      mounted.current = false;
    };
  }, [check]);

  useEffect(() => {
    if (state.kind !== "publishing") return;
    const timer = setTimeout(() => {
      polls.current += 1;
      void check();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [state, check]);

  /** Sends a new request, or the saved one again when the server never confirmed it. */
  const send = useCallback(
    async (resend: boolean) => {
      const current = review.current;
      if (busy.current || !current) return;
      const { client, storage } = io.current;
      const saved = readBookingPublicationAttempt(storage, organizationId, propertyId);
      if (!(resend ? saved : canPublish(current))) return;
      busy.current = true;
      sentHere.current = true;
      polls.current = 0;
      show({ kind: "publishing" });
      let attempt = saved;
      try {
        if (!resend) {
          if (current.readiness.outcome !== "evaluated") return;
          attempt = {
            propertyId,
            idempotencyKey: `booking-review:${crypto.randomUUID()}`,
            body: {
              expectedActiveContentRevisionId: current.activeContentRevisionId,
              expectedSourceManifestHash: current.readiness.sourceManifestHash,
              expectedReadinessHash: current.readiness.readinessHash,
            },
          };
          await saveBookingPublicationAttempt(
            storage,
            organizationId,
            attempt,
            saved?.idempotencyKey ?? null,
          );
        }
        await client.publish(attempt!);
        show(view(await load()));
      } catch (error) {
        if (
          attempt &&
          error instanceof ApiErrorResponse &&
          error.status === 409 &&
          REJECTED.includes(String(error.data.code))
        ) {
          // The server refused this request (the hotel changed): forget it, so the next one is new.
          await clearRejectedBookingPublicationAttempt(storage, organizationId, attempt).catch(
            () => undefined,
          );
          show({ kind: "failed", message: CHANGED });
        } else {
          show({ kind: "failed", message: error instanceof Error ? error.message : TRY_AGAIN });
        }
      } finally {
        busy.current = false;
      }
    },
    [load, organizationId, propertyId, show, view],
  );

  const publish = useCallback(() => send(false), [send]);

  /** "Try again": checks again, then sends what's needed (the saved request, or a new one). */
  const retry = useCallback(async () => {
    if (busy.current) return;
    polls.current = 0;
    show({ kind: "loading" });
    const situation = await load();
    if (situation.kind === "unconfirmed") return send(true);
    if ((situation.kind === "ready" || situation.kind === "failed") && canPublish(review.current))
      return send(false);
    show(situation.kind === "failed" ? situation : view(situation));
  }, [load, send, show, view]);

  return { state, publish, retry };
}
