import { describe, expect, it, vi } from "vitest";

import {
  createPropertySetupReviewLifecycleStateProvider,
  type BookingSetupLifecyclePhase,
} from "./platform/propertySetupReviewLifecycleState.js";
import type { PropertySetupOwnerStateRequest } from "./platform/propertySetupRouteState.js";

const scope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  propertyId: "22222222-2222-4222-8222-222222222222",
  actorUserId: "33333333-3333-4333-8333-333333333333",
} as const;

describe("property setup Review lifecycle provider", () => {
  it("keeps an accepted Booking publication as saved until Distribution activates it", async () => {
    const provider = createPropertySetupReviewLifecycleStateProvider({
      booking: bookingPort("publishing", "booking:attempt-4:pending"),
    });

    await expect(provider.getOwnerState(request(["hotel_operations"]))).resolves.toMatchObject({
      outcome: "found",
      facts: [{ stepId: "review", state: "saved", blockers: [] }],
    });
  });

  it("distinguishes untouched, in-flight, and published Booking lifecycles", async () => {
    const cases = [
      { bookingPhase: "not_started" as const, expected: "not_started" },
      { bookingPhase: "publishing" as const, expected: "saved" },
      { bookingPhase: "published" as const, expected: "complete" },
    ];

    for (const item of cases) {
      const provider = createPropertySetupReviewLifecycleStateProvider({
        booking: bookingPort(item.bookingPhase, `booking:${item.bookingPhase}`),
      });
      const result = await provider.getOwnerState(request(["hotel_operations"]));
      expect(result).toMatchObject({
        outcome: "found",
        facts: [{ state: item.expected }],
      });
    }
  });

  it("returns structured Review-owned blockers", async () => {
    const provider = createPropertySetupReviewLifecycleStateProvider({
      booking: bookingPort("publication_failed", "booking:attempt-8:failed"),
    });

    const result = await provider.getOwnerState(request(["hotel_operations"]));

    expect(result).toMatchObject({
      outcome: "found",
      facts: [
        {
          state: "blocked",
          blockers: [
            {
              code: "booking_publication_failed",
              product: "booking",
              ownerDomain: "booking",
              owningStepId: "review",
              kind: "system_error",
              sourceRevision: "booking:attempt-8:failed",
            },
          ],
        },
      ],
    });
  });

  it("binds the Review revision to selected tracks and exact owner lifecycle revisions", async () => {
    const first = createPropertySetupReviewLifecycleStateProvider({
      booking: bookingPort("published", "booking:r4:active"),
    });
    const equivalent = createPropertySetupReviewLifecycleStateProvider({
      booking: bookingPort("published", "booking:r4:active"),
    });
    const changed = createPropertySetupReviewLifecycleStateProvider({
      booking: bookingPort("published", "booking:r5:active"),
    });
    const operations = request(["hotel_operations"]);

    const firstRevision = revision(await first.getOwnerState(operations));
    expect(revision(await equivalent.getOwnerState(operations))).toBe(firstRevision);
    expect(revision(await changed.getOwnerState(operations))).not.toBe(firstRevision);
    expect(firstRevision).toMatch(/^review-lifecycle:sha256:[0-9a-f]{64}$/);
  });

  it("fails closed for missing, rejected, or malformed lifecycle facts", async () => {
    const missing = createPropertySetupReviewLifecycleStateProvider({});
    await expect(missing.getOwnerState(request(["hotel_operations"]))).resolves.toEqual({
      outcome: "provider_failure",
    });

    const rejected = createPropertySetupReviewLifecycleStateProvider({
      booking: {
        getBookingSetupLifecycleStatus: vi.fn(async () => {
          throw new Error("provider stack: connection refused");
        }),
      },
    });
    const rejectedResult = await rejected.getOwnerState(request(["hotel_operations"]));
    expect(rejectedResult).toEqual({
      outcome: "provider_failure",
    });
    expect(JSON.stringify(rejectedResult)).not.toContain("provider stack");

    const malformed = createPropertySetupReviewLifecycleStateProvider({
      booking: {
        getBookingSetupLifecycleStatus: vi.fn(async () => ({
          ...bookingStatus("published", "booking:r4:active"),
          propertyId: "another-property",
        })),
      },
    });
    await expect(malformed.getOwnerState(request(["hotel_operations"]))).resolves.toEqual({
      outcome: "provider_failure",
    });

    const wrongProduct = createPropertySetupReviewLifecycleStateProvider({
      booking: {
        getBookingSetupLifecycleStatus: vi.fn(async () => ({
          ...scope,
          product: "marketplace" as never,
          phase: "published" as const,
          sourceRevision: "marketplace:r4:active",
        })),
      },
    });
    await expect(wrongProduct.getOwnerState(request(["hotel_operations"]))).resolves.toEqual({
      outcome: "provider_failure",
    });
  });

  it("rejects a request for any step or track shape outside Review", async () => {
    const provider = createPropertySetupReviewLifecycleStateProvider({
      booking: bookingPort("published", "booking:r4:active"),
    });
    const invalid = [
      { ...request(["hotel_operations"]), stepIds: ["payments"] as const },
      {
        ...request(["hotel_operations"]),
        selectedTracks: ["hotel_operations", "hotel_operations"] as const,
      },
      { ...request(["hotel_operations"]), selectedTracks: ["retired_track" as never] },
      { ...request(["hotel_operations"]), expectedTrackRevision: -1 },
    ];

    for (const item of invalid) {
      await expect(provider.getOwnerState(item)).resolves.toEqual({
        outcome: "provider_failure",
      });
    }
  });
});

function request(
  selectedTracks: PropertySetupOwnerStateRequest["selectedTracks"],
): PropertySetupOwnerStateRequest {
  return {
    ...scope,
    selectedTracks,
    expectedTrackRevision: 4,
    stepIds: ["review"],
  };
}

function bookingPort(phase: BookingSetupLifecyclePhase, sourceRevision: string) {
  return {
    getBookingSetupLifecycleStatus: vi.fn(async () => bookingStatus(phase, sourceRevision)),
  };
}

function bookingStatus(phase: BookingSetupLifecyclePhase, sourceRevision: string) {
  return {
    ...scope,
    product: "booking" as const,
    phase,
    sourceRevision,
  };
}

function revision(
  result: Awaited<
    ReturnType<ReturnType<typeof createPropertySetupReviewLifecycleStateProvider>["getOwnerState"]>
  >,
) {
  if (result.outcome !== "found") throw new Error("Expected lifecycle fact");
  return result.facts[0]!.sourceRevision;
}
