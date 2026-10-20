import type { BookingPublicationReview } from "@vayada/product-onboarding/bookingPublicationReviewApi";

type Readiness = Extract<BookingPublicationReview["readiness"], { outcome: "evaluated" }>;
type Blocker = Readiness["groups"][number]["steps"][number]["entities"][number]["blockers"][number];

/** A readiness group that keeps the booking page from going live, with where to fix it. */
export type BookingPageItem = {
  groupId: string;
  message: string | null;
  step: Blocker["owningStepId"] | null;
  /** The setup field to open on that step, e.g. the location form (VAY-2288). */
  focus?: "location";
};

// City and country live in the hotel details form, not on the Present your hotel step.
const LOCATION_BLOCKERS = new Set([
  "hotel_public_locality_hidden",
  "hotel_public_locality_missing",
]);

type FailureCode = NonNullable<BookingPublicationReview["latestOperation"]>["failureCode"];

/** Why the last publish didn't go live, so the card can say so (VAY-2292). */
export type BookingPageFailure =
  | { kind: "operation"; code: FailureCode; operationId: string }
  | { kind: "request"; reason: "setup_changed" | "already_publishing" | "unreachable" };

export type BookingPageStatus =
  | { kind: "online"; url: string; items: BookingPageItem[] }
  | { kind: "hidden"; items: BookingPageItem[] }
  | { kind: "publishing" }
  | { kind: "ready"; readyGroups: string[] }
  | { kind: "failed"; readyGroups: string[]; failure: BookingPageFailure }
  | { kind: "not_ready"; items: BookingPageItem[]; readyGroups: string[] }
  | { kind: "waiting"; items: BookingPageItem[]; readyGroups: string[] }
  | { kind: "unavailable" };

export function bookingPageStatus(review: BookingPublicationReview): BookingPageStatus {
  const operation = review.latestOperation;
  const readiness = review.readiness.outcome === "evaluated" ? review.readiness : null;
  const items = readiness ? missingItems(readiness) : [];
  // The first publication is the go-live; later saves go live by themselves (VAY-2129), so a
  // live page stays online while such an update runs. A published page without a URL is hidden
  // from guests, e.g. when they can no longer pay the way it offers.
  if (review.activeContentRevisionId)
    return review.publishedUrl
      ? { kind: "online", url: review.publishedUrl, items }
      : { kind: "hidden", items };
  if (operation?.status === "pending" || operation?.status === "unknown")
    return { kind: "publishing" };
  if (!readiness) return { kind: "unavailable" };
  const readyGroups = readiness.groups
    .filter(({ status }) => status === "ready")
    .map(({ groupId }) => groupId);
  if (readiness.status === "ready")
    return operation?.status === "failed"
      ? {
          kind: "failed",
          readyGroups,
          failure: {
            kind: "operation",
            code: operation.failureCode,
            operationId: operation.operationId,
          },
        }
      : { kind: "ready", readyGroups };
  if (readiness.status === "pending") return { kind: "waiting", items, readyGroups };
  // One item's readiness error must not hide the items the hotel can fix.
  return readiness.status === "blocked" || items.some(({ step }) => step)
    ? { kind: "not_ready", items, readyGroups }
    : { kind: "unavailable" };
}

function missingItems(readiness: Readiness): BookingPageItem[] {
  return readiness.groups
    .filter(({ status }) => status !== "ready")
    .map((group) => {
      const blockers = group.steps.flatMap(({ entities }) =>
        entities.flatMap(({ blockers }) => blockers),
      );
      const fixable = blockers.find(({ kind }) => kind === "user_fixable");
      return {
        groupId: group.groupId,
        message: (fixable ?? blockers[0])?.message ?? null,
        step: fixable?.owningStepId ?? null,
        ...(fixable && LOCATION_BLOCKERS.has(fixable.code) ? { focus: "location" as const } : {}),
      };
    });
}
