import { describe, expect, it } from "vitest";
import type { BookingPublicationReview } from "@vayada/product-onboarding/bookingPublicationReviewApi";

import { bookingPageStatus } from "./bookingPageStatus";

const GROUPS = [
  "booking.hotel_profile",
  "booking.page_style",
  "booking.rooms",
  "booking.pricing",
  "booking.calendar",
  "booking.guest_experience",
  "booking.payments",
];

type Blocked = Record<string, { kind: string; step: string; message: string; code?: string }>;

function review({
  status = "ready",
  blocked = {},
  published = false,
  hidden = false,
  operation = null,
  readinessFailed = false,
}: {
  status?: "ready" | "blocked" | "pending" | "error";
  blocked?: Blocked;
  published?: boolean;
  hidden?: boolean;
  operation?: "pending" | "unknown" | "failed" | "succeeded" | null;
  readinessFailed?: boolean;
} = {}): BookingPublicationReview {
  return {
    activeContentRevisionId: published ? "11111111-1111-4111-8111-111111111111" : null,
    publishedUrl: published && !hidden ? "https://hotel-alpenrose.booking.vayada.com" : null,
    latestOperation: operation ? { status: operation } : null,
    readiness: readinessFailed
      ? { outcome: "provider_failure", status: "error" }
      : {
          outcome: "evaluated",
          status,
          groups: GROUPS.map((groupId) => {
            const blocker = blocked[groupId];
            return {
              groupId,
              status: blocker
                ? blocker.kind === "external_pending"
                  ? "pending"
                  : "blocked"
                : "ready",
              steps: [
                {
                  owningStepId: blocker?.step ?? "present_hotel",
                  entities: [
                    {
                      blockers: blocker
                        ? [
                            {
                              kind: blocker.kind,
                              code: blocker.code ?? "test_blocker",
                              owningStepId: blocker.step,
                              message: blocker.message,
                            },
                          ]
                        : [],
                    },
                  ],
                },
              ],
            };
          }),
        },
  } as unknown as BookingPublicationReview;
}

describe("bookingPageStatus", () => {
  it("is online with its link once the first publication went live", () => {
    expect(bookingPageStatus(review({ published: true }))).toEqual({
      kind: "online",
      url: "https://hotel-alpenrose.booking.vayada.com",
      items: [],
    });
  });

  it("stays online but lists what needs fixing when readiness slips after go-live", () => {
    const status = bookingPageStatus(
      review({
        published: true,
        status: "blocked",
        blocked: {
          "booking.payments": {
            kind: "user_fixable",
            step: "payments",
            message: "Choose how guests can pay.",
          },
        },
      }),
    );
    expect(status).toEqual({
      kind: "online",
      url: "https://hotel-alpenrose.booking.vayada.com",
      items: [
        { groupId: "booking.payments", message: "Choose how guests can pay.", step: "payments" },
      ],
    });
  });

  it.each([
    "hotel_public_locality_hidden",
    "hotel_public_locality_missing",
    // The time zone sits next to the country (VAY-2292).
    "hotel_timezone_missing",
    "hotel_timezone_invalid",
  ])("sends %s to the location form (VAY-2288)", (code) => {
    const status = bookingPageStatus(
      review({
        status: "blocked",
        blocked: {
          "booking.hotel_profile": {
            kind: "user_fixable",
            step: "present_hotel",
            message: "Turn on 'Show city and country publicly' so guests see where you are.",
            code,
          },
        },
      }),
    );
    expect(status).toMatchObject({
      kind: "not_ready",
      items: [{ groupId: "booking.hotel_profile", step: "present_hotel", focus: "location" }],
    });
  });

  it("is hidden, not online, when a published page has no guest URL", () => {
    expect(bookingPageStatus(review({ published: true, hidden: true }))).toEqual({
      kind: "hidden",
      items: [],
    });
  });

  it("offers publishing when every item is ready", () => {
    expect(bookingPageStatus(review())).toEqual({ kind: "ready", readyGroups: GROUPS });
  });

  it("shows a failed first publication while readiness is still ready", () => {
    expect(bookingPageStatus(review({ operation: "failed" }))).toEqual({
      kind: "failed",
      readyGroups: GROUPS,
    });
  });

  it.each(["pending", "unknown"] as const)("is publishing while the operation is %s", (op) => {
    expect(bookingPageStatus(review({ operation: op }))).toEqual({ kind: "publishing" });
  });

  it("stays online while a save updates the live page", () => {
    expect(bookingPageStatus(review({ operation: "pending", published: true })).kind).toBe(
      "online",
    );
  });

  it("lists missing items with the setup step that fixes each one", () => {
    const status = bookingPageStatus(
      review({
        status: "blocked",
        blocked: {
          "booking.calendar": {
            kind: "user_fixable",
            step: "calendar",
            message: "Open your calendar and confirm your starting availability.",
          },
          "booking.rooms": {
            kind: "external_pending",
            step: "rooms",
            message: "Your hotel photos are still being processed.",
          },
        },
      }),
    );
    expect(status).toEqual({
      kind: "not_ready",
      items: [
        {
          groupId: "booking.rooms",
          message: "Your hotel photos are still being processed.",
          step: null,
        },
        {
          groupId: "booking.calendar",
          message: "Open your calendar and confirm your starting availability.",
          step: "calendar",
        },
      ],
      readyGroups: GROUPS.filter((id) => id !== "booking.rooms" && id !== "booking.calendar"),
    });
  });

  it("waits while readiness is still being processed", () => {
    expect(bookingPageStatus(review({ status: "pending" })).kind).toBe("waiting");
  });

  it.each([{ readinessFailed: true }, { status: "error" as const }])(
    "cannot tell before go-live when readiness is unavailable (%o)",
    (input) => {
      expect(bookingPageStatus(review(input))).toEqual({ kind: "unavailable" });
    },
  );

  it("keeps fixable items when another item's readiness check errors", () => {
    const status = bookingPageStatus(
      review({
        status: "error",
        blocked: {
          "booking.calendar": {
            kind: "user_fixable",
            step: "calendar",
            message: "Open your calendar and confirm your starting availability.",
          },
        },
      }),
    );
    expect(status.kind).toBe("not_ready");
  });

  it("stays online when readiness is unavailable after go-live", () => {
    expect(bookingPageStatus(review({ published: true, readinessFailed: true })).kind).toBe(
      "online",
    );
  });
});
