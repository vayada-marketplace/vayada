import { createHash } from "node:crypto";

import { SETUP_TRACKS, type SetupTrack } from "@vayada/domain-hotels";

import type {
  PropertySetupOwnerStateProviderPort,
  PropertySetupOwnerStateRequest,
  PropertySetupOwnerStateResult,
} from "./propertySetupRouteState.js";

export type PropertySetupLifecycleScope = Readonly<{
  organizationId: string;
  propertyId: string;
  actorUserId: string;
}>;

export const BOOKING_SETUP_LIFECYCLE_PHASES = [
  "not_started",
  "publishing",
  "published",
  "source_content_changed",
  "publication_failed",
  "publication_unknown",
] as const;

export type BookingSetupLifecyclePhase = (typeof BOOKING_SETUP_LIFECYCLE_PHASES)[number];

type LifecycleStatus<
  TProduct extends "booking",
  TPhase extends string,
> = PropertySetupLifecycleScope &
  Readonly<{
    product: TProduct;
    phase: TPhase;
    /** Opaque owner revision; it must change whenever the lifecycle projection changes. */
    sourceRevision: string;
  }>;

export type BookingSetupLifecycleStatus = LifecycleStatus<"booking", BookingSetupLifecyclePhase>;

export interface BookingSetupLifecycleStatusPort {
  getBookingSetupLifecycleStatus(
    scope: PropertySetupLifecycleScope,
  ): Promise<BookingSetupLifecycleStatus>;
}

export type PropertySetupReviewLifecycleStateOptions = Readonly<{
  booking?: BookingSetupLifecycleStatusPort;
}>;

/**
 * Projects only submission/publication lifecycle progress for the Review step.
 * Product readiness groups remain owned by their product aggregates and never
 * enter this provider.
 */
export function createPropertySetupReviewLifecycleStateProvider(
  options: PropertySetupReviewLifecycleStateOptions,
): PropertySetupOwnerStateProviderPort {
  return {
    async getOwnerState(request) {
      try {
        if (!validReviewRequest(request)) return { outcome: "provider_failure" };
        const scope = Object.freeze({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          actorUserId: request.actorUserId,
        });
        const statuses = await Promise.all(
          request.selectedTracks.map(async (track) => {
            const expectedProduct = productForTrack(track);
            const status = await readBookingLifecycle(options, scope);
            assertLifecycleStatus(status, scope);
            if (status.product !== expectedProduct) {
              throw new TypeError("Review lifecycle provider returned another product");
            }
            return status;
          }),
        );

        const blockers = statuses.flatMap(lifecycleBlockers);
        const state = reviewState(statuses, blockers.length > 0);
        const sourceRevision = aggregateReviewRevision(request.selectedTracks, statuses);

        return {
          outcome: "found",
          facts: [
            Object.freeze({
              organizationId: request.organizationId,
              propertyId: request.propertyId,
              stepId: "review",
              product: "hotel_catalog",
              ownerDomain: "hotel_catalog",
              state,
              sourceRevision,
              currentBaseRevisions: Object.freeze({}),
              blockers: blockers.map((blocker) => ({ ...blocker })),
            }),
          ],
        } satisfies PropertySetupOwnerStateResult;
      } catch {
        return { outcome: "provider_failure" };
      }
    },
  };
}

type ReviewLifecycleStatus = BookingSetupLifecycleStatus;

const PRODUCT_BY_TRACK = {
  hotel_operations: "booking",
} as const satisfies Record<SetupTrack, "booking">;

function productForTrack(track: SetupTrack): "booking" {
  const product = PRODUCT_BY_TRACK[track];
  if (!product) throw new TypeError("Review lifecycle track is unsupported");
  return product;
}

function readBookingLifecycle(
  options: PropertySetupReviewLifecycleStateOptions,
  scope: PropertySetupLifecycleScope,
): Promise<BookingSetupLifecycleStatus> {
  if (!options.booking) throw new Error("Booking lifecycle provider missing");
  return options.booking.getBookingSetupLifecycleStatus(scope);
}

function validReviewRequest(request: PropertySetupOwnerStateRequest): boolean {
  return (
    nonEmpty(request.organizationId) &&
    nonEmpty(request.propertyId) &&
    nonEmpty(request.actorUserId) &&
    request.stepIds.length === 1 &&
    request.stepIds[0] === "review" &&
    Number.isSafeInteger(request.expectedTrackRevision) &&
    request.expectedTrackRevision >= 0 &&
    request.selectedTracks.length > 0 &&
    new Set(request.selectedTracks).size === request.selectedTracks.length &&
    request.selectedTracks.every((track) => SETUP_TRACKS.includes(track)) &&
    SETUP_TRACKS.filter((track) => request.selectedTracks.includes(track)).every(
      (track, index) => request.selectedTracks[index] === track,
    )
  );
}

function assertLifecycleStatus(
  status: ReviewLifecycleStatus,
  scope: PropertySetupLifecycleScope,
): void {
  if (
    status.organizationId !== scope.organizationId ||
    status.propertyId !== scope.propertyId ||
    status.actorUserId !== scope.actorUserId ||
    !nonEmpty(status.sourceRevision)
  ) {
    throw new TypeError("Review lifecycle status is outside its authorized scope");
  }
  const validPhase =
    status.product === "booking" &&
    BOOKING_SETUP_LIFECYCLE_PHASES.includes(status.phase as BookingSetupLifecyclePhase);
  if (!validPhase) throw new TypeError("Review lifecycle status has an unsupported phase");
}

function reviewState(statuses: readonly ReviewLifecycleStatus[], blocked: boolean) {
  if (blocked) return "blocked" as const;
  if (statuses.every(({ phase }) => phase === "not_started")) return "not_started" as const;
  if (statuses.every(ownerLaunchActionComplete)) return "complete" as const;
  return "saved" as const;
}

function ownerLaunchActionComplete({ phase }: ReviewLifecycleStatus): boolean {
  return phase === "published";
}

function lifecycleBlockers(status: ReviewLifecycleStatus) {
  return bookingBlockers(status);
}

function bookingBlockers(status: BookingSetupLifecycleStatus) {
  const definitions = {
    source_content_changed: {
      code: "booking_publication_source_changed",
      message: "Setup changed while the booking page was publishing. Review it and publish again.",
      kind: "user_fixable",
    },
    publication_failed: {
      code: "booking_publication_failed",
      message:
        "The booking page could not be published. Retry from Review when the service recovers.",
      kind: "system_error",
    },
    publication_unknown: {
      code: "booking_publication_status_unknown",
      message: "The booking page publication result is not confirmed yet. Retry its status.",
      kind: "system_error",
    },
  } as const;
  const definition = definitions[status.phase as keyof typeof definitions];
  return definition ? [blocker("booking", status.sourceRevision, definition)] : [];
}

function blocker(
  ownerDomain: "booking",
  sourceRevision: string,
  definition: Readonly<{
    code: string;
    message: string;
    kind: "user_fixable" | "external_pending" | "system_error";
  }>,
) {
  return {
    ...definition,
    product: ownerDomain,
    ownerDomain,
    owningStepId: "review" as const,
    sourceRevision,
  };
}

function aggregateReviewRevision(
  selectedTracks: readonly SetupTrack[],
  statuses: readonly ReviewLifecycleStatus[],
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        selectedTracks,
        sources: statuses.map(({ product, sourceRevision }) => ({ product, sourceRevision })),
      }),
    )
    .digest("hex");
  return `review-lifecycle:sha256:${digest}`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
