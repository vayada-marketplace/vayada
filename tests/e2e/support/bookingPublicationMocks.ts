import type { Page, Route } from "@playwright/test";
import {
  createProductReadinessResult,
  READINESS_GROUP_IDS_BY_PRODUCT,
} from "@vayada/domain-hotels";

/** The publication review behind Booking Admin's "Your booking page" card (VAY-2187). */
export type BookingPublicationMockState =
  | "online"
  | "ready"
  | "not_ready"
  | "publishing"
  | "failed";

export type BookingReadinessBlockerMock = {
  groupId: (typeof READINESS_GROUP_IDS_BY_PRODUCT.booking)[number];
  step:
    | "present_hotel"
    | "booking_design"
    | "rooms"
    | "pricing"
    | "calendar"
    | "guest_experience"
    | "payments";
  message: string;
  code?: string;
};

export const BOOKING_PUBLICATION_PATH =
  /\/api\/hotel-setup\/properties\/[^/]+\/publications\/booking(?:\?|$)/;
const ACTIVE_REVISION_ID = "5e4a0ae6-2899-49b3-8cb3-07d249cae3b2";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";

export async function bookingReadinessMock(
  propertyId: string,
  blockers: BookingReadinessBlockerMock[] = [],
) {
  const source = {
    ownerDomain: "booking" as const,
    entityType: "settings",
    entityId: propertyId,
    revision: "1",
  };
  return createProductReadinessResult({
    contractVersion: "onboarding-product-readiness.v1",
    propertyId,
    product: "booking",
    status: blockers.length ? "blocked" : "ready",
    sourceManifest: {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [source],
    },
    groups: READINESS_GROUP_IDS_BY_PRODUCT.booking.map((groupId) => {
      const blocker = blockers.find((item) => item.groupId === groupId);
      const status = blocker ? ("blocked" as const) : ("ready" as const);
      const owningStepId = blocker?.step ?? "booking_design";
      return {
        groupId,
        status,
        steps: [
          {
            owningStepId,
            status,
            entities: [
              {
                source,
                status,
                blockers: blocker
                  ? [
                      {
                        kind: "user_fixable" as const,
                        code: blocker.code ?? "e2e_blocker",
                        message: blocker.message,
                        product: "booking" as const,
                        groupId,
                        owningStepId,
                        source,
                      },
                    ]
                  : [],
              },
            ],
          },
        ],
      };
    }),
    evaluatedAt: "2026-10-14T08:00:00.000Z",
  });
}

export async function bookingPublicationReviewMock(
  propertyId: string,
  state: BookingPublicationMockState,
  blockers: BookingReadinessBlockerMock[] = [],
) {
  const now = "2026-10-14T08:00:00.000Z";
  const online = state === "online";
  const operation =
    state === "publishing" || state === "failed"
      ? {
          operationId: OPERATION_ID,
          propertyId,
          status: state === "publishing" ? "pending" : "failed",
          expectedActiveContentRevisionId: null,
          resultContentRevisionId: null,
          failureCode: state === "failed" ? "projection_failed" : null,
          requestedAt: now,
          updatedAt: now,
          completedAt: state === "failed" ? now : null,
        }
      : online
        ? {
            operationId: OPERATION_ID,
            propertyId,
            status: "succeeded",
            expectedActiveContentRevisionId: null,
            resultContentRevisionId: ACTIVE_REVISION_ID,
            failureCode: null,
            requestedAt: now,
            updatedAt: now,
            completedAt: now,
          }
        : null;
  return {
    contractVersion: "booking-publication-review.v1",
    propertyId,
    activeContentRevisionId: online ? ACTIVE_REVISION_ID : null,
    publishedUrl: online ? "https://hotel-alpenrose.booking.vayada.com" : null,
    publicSite: "serving",
    latestOperation: operation,
    recoveredOperation: null,
    readiness: await bookingReadinessMock(propertyId, state === "not_ready" ? blockers : []),
  };
}

export function publicationOperationMock(propertyId: string) {
  const now = "2026-10-14T08:00:00.000Z";
  return {
    operationId: OPERATION_ID,
    propertyId,
    status: "pending",
    expectedActiveContentRevisionId: null,
    resultContentRevisionId: null,
    failureCode: null,
    requestedAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

/** Booking Admin calls apps/api cross-origin; answer the preflight its custom headers need. */
export function fulfillPublication(route: Route, init: { status?: number; json?: unknown }) {
  const headers = {
    "Access-Control-Allow-Origin": route.request().headers()["origin"] ?? "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Credentials": "true",
  };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
  return route.fulfill({ status: init.status ?? 200, headers, json: init.json });
}

export async function mockBookingPublication(
  page: Page,
  propertyId: string,
  state: BookingPublicationMockState = "online",
): Promise<void> {
  const review = await bookingPublicationReviewMock(propertyId, state);
  await page.route(BOOKING_PUBLICATION_PATH, (route) =>
    fulfillPublication(route, { json: review }),
  );
}
