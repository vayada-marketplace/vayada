import {
  BOOKING_DESIGN_CONTRACT_VERSION,
  BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
  BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
} from "@vayada/domain-booking";
import { HOTEL_CATALOG_STEP1_CONTRACT_VERSION } from "@vayada/domain-hotels";
import { describe, expect, it, vi } from "vitest";

import type { HotelCatalogStep1State } from "./domains/hotelCatalogStep1Repository.js";
import { createPropertySetupBookingStateProvider } from "./platform/propertySetupBookingState.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";

describe("property setup Booking owner state", () => {
  it("returns the stable exact design and Catalog manifest", async () => {
    const provider = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign: vi.fn(async () => design(2)) },
      catalog: { getState: vi.fn(async () => catalog()) },
    });

    await expect(provider.getOwnerState(request(["booking_design"]))).resolves.toMatchObject({
      outcome: "found",
      facts: [
        {
          state: "complete",
          sourceRevision: "design:2",
          currentBaseRevisions: {
            "booking.design": "design:2",
            "hotel_catalog.profile": "profile:5",
            "hotel_catalog.media": "profile:5",
          },
        },
      ],
    });
  });

  it("consumes only the confirmed guest-rule revision without pricing dependencies", async () => {
    const provider = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign: vi.fn(async () => design(2)) },
      catalog: { getState: vi.fn(async () => catalog()) },
      guestRules: { read: vi.fn(async () => guestEvidence()) },
    });

    await expect(
      provider.getOwnerState(request(["booking_design", "guest_experience"])),
    ).resolves.toMatchObject({
      outcome: "found",
      facts: [
        { stepId: "booking_design", sourceRevision: "design:2" },
        {
          stepId: "guest_experience",
          state: "complete",
          sourceRevision: `guest-choices:${propertyId}`,
          currentBaseRevisions: { "booking.guest_experience": `guest-choices:${propertyId}` },
        },
      ],
    });
  });

  it("maps only the typed first-visit absence source to not started", async () => {
    const absent = null;
    const provider = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign: vi.fn(async () => design(2)) },
      catalog: { getState: vi.fn(async () => catalog()) },
      guestRules: { read: vi.fn(async () => absent) },
    });

    await expect(
      provider.getOwnerState(request(["booking_design", "guest_experience"])),
    ).resolves.toMatchObject({
      outcome: "found",
      facts: [
        { stepId: "booking_design", state: "complete" },
        {
          stepId: "guest_experience",
          state: "not_started",
          sourceRevision: "guest-choices:absent",
          currentBaseRevisions: { "booking.guest_experience": "guest-choices:absent" },
        },
      ],
    });
  });

  it("fails closed on a Booking design revision race", async () => {
    const getCurrentDesign = vi
      .fn()
      .mockResolvedValueOnce(design(2))
      .mockResolvedValueOnce(design(3));
    const provider = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign },
      catalog: { getState: vi.fn(async () => catalog()) },
    });

    await expect(provider.getOwnerState(request(["booking_design"]))).resolves.toEqual({
      outcome: "provider_failure",
    });
    expect(getCurrentDesign).toHaveBeenCalledTimes(2);
  });

  it("fails before owner reads when required guest evidence is absent", async () => {
    const getCurrentDesign = vi.fn(async () => design(2));
    const provider = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign },
      catalog: { getState: vi.fn(async () => catalog()) },
    });

    await expect(
      provider.getOwnerState(request(["booking_design", "guest_experience"])),
    ).resolves.toEqual({ outcome: "provider_failure" });
    expect(getCurrentDesign).not.toHaveBeenCalled();
  });

  it("fails closed on a guest-policy evidence race", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(guestEvidence())
      .mockResolvedValueOnce({
        ...guestEvidence(),
        revision: actorUserId,
      });
    const guestRace = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign: vi.fn(async () => design(2)) },
      catalog: { getState: vi.fn(async () => catalog()) },
      guestRules: { read },
    });
    await expect(
      guestRace.getOwnerState(request(["booking_design", "guest_experience"])),
    ).resolves.toEqual({ outcome: "provider_failure" });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("authorizes guest-rule scope and rejects malformed or unavailable rules", async () => {
    const read = vi.fn().mockResolvedValue(guestEvidence());
    const provider = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign: vi.fn() },
      catalog: { getState: vi.fn() },
      guestRules: { read },
    });
    expect((await provider.getOwnerState(request(["guest_experience"]))).outcome).toBe("found");
    expect(read).toHaveBeenCalledWith({ organizationId, propertyId, actorUserId });
    for (const value of [
      undefined,
      { revision: "guest-policy:1", choices: guestEvidence().choices },
      { revision: propertyId, choices: {} },
    ]) {
      read.mockResolvedValue(value);
      expect(await provider.getOwnerState(request(["guest_experience"]))).toEqual({
        outcome: "provider_failure",
      });
    }
    read.mockRejectedValue(new Error("guest_choices_denied"));
    expect(await provider.getOwnerState(request(["guest_experience"]))).toEqual({
      outcome: "provider_failure",
    });
  });
});

function request(stepIds: ("booking_design" | "guest_experience")[]) {
  return {
    organizationId,
    propertyId,
    actorUserId,
    selectedTracks: ["hotel_operations"] as const,
    expectedTrackRevision: 3,
    stepIds,
  };
}

function guestEvidence() {
  return {
    revision: propertyId,
    choices: {
      defaultGuestLanguage: "en" as const,
      childrenEnabled: false,
      adultAgeThreshold: null,
      phoneRequired: true,
      arrivalTimeEnabled: false,
      specialRequestsEnabled: true,
      checkInTime: "15:00",
      checkOutTime: "11:00",
    },
  };
}

function design(revision: number) {
  return {
    contractVersion: BOOKING_DESIGN_CONTRACT_VERSION,
    propertyId,
    revision,
    choices: {
      primaryColor: BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
      fontPairing: BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
    },
    createdAt: "2026-08-04T12:00:00.000Z",
  };
}

function catalog(): HotelCatalogStep1State {
  return {
    readModel: {
      contractVersion: HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
      propertyId,
      displayName: "Hotel Example",
      profileRevision: 5,
      supportedLocales: ["en"],
      profile: {
        locale: "en",
        shortDescription: "A".repeat(50),
        publicSlug: "hotel-example",
        amenities: { reviewed: true, keys: [] },
        media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
      },
      baseRevisions: {
        "hotel_catalog.profile": "profile:5",
        "hotel_catalog.media": "profile:5",
        "hotel_catalog.amenities": "profile:5",
      },
    },
    presentationAssignments: [],
  };
}
