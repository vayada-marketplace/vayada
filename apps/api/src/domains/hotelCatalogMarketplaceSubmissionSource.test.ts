import { expect, it, vi } from "vitest";
import { createHotelCatalogMarketplaceSubmissionSource } from "./hotelCatalogMarketplaceSubmissionSource.js";
const propertyId = "22222222-2222-4222-8222-222222222222";
const scope = { propertyId, organizationId: "org", actorUserId: "actor" };
function harness() {
  const profile = {
    propertyId,
    profileRevision: 1,
    profile: {
      displayName: "Test hotel",
      propertyType: "hotel",
      location: {
        streetAddress: "Test Street 1",
        postalCode: "10115",
        city: "Berlin",
        countryCode: "DE",
        timezone: "Europe/Berlin",
        latitude: 52,
        longitude: 13,
        localityPublic: true,
        geoPublic: false,
        mapDisplayMode: "hidden" as const,
      },
      contacts: [
        {
          channelType: "email" as const,
          value: "hotel@example.com",
          purpose: "general" as const,
          isPublic: false,
        },
        {
          channelType: "phone" as const,
          value: "+4930123456",
          purpose: "general" as const,
          isPublic: false,
        },
      ],
    },
  };
  const publicProfile = {
    propertyId,
    profileRevision: 1,
    publicProfile: {
      locale: "en",
      shortDescription: null,
      longDescription: null,
      media: [
        {
          mediaObjectId: "33333333-3333-4333-8333-333333333333",
          mediaType: "logo" as const,
          url: "https://media.example/logo.png",
          altText: null,
          sortOrder: 0,
        },
      ],
    },
  };
  const presentation = {
    readModel: {
      contractVersion: "hotel-catalog-step1.v1" as const,
      propertyId,
      displayName: "Test hotel",
      profileRevision: 1,
      supportedLocales: ["en" as const],
      profile: {
        locale: "en" as const,
        shortDescription:
          "A quiet hotel beside the park with comfortable rooms and friendly service.",
        publicSlug: "test-hotel",
        amenities: { reviewed: false, keys: [] },
        media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
      },
      baseRevisions: {
        "hotel_catalog.profile": "profile:1",
        "hotel_catalog.media": "profile:1",
        "hotel_catalog.amenities": "profile:1",
      },
    },
    presentationAssignments: [],
  };
  const step1 = { getState: vi.fn().mockResolvedValue(presentation) };
  const profiles = {
    getPropertyProfile: vi.fn().mockResolvedValue(profile),
    getPublicPropertyProfile: vi.fn().mockResolvedValue(publicProfile),
  };
  return {
    source: createHotelCatalogMarketplaceSubmissionSource({ step1, profiles }),
    step1,
    profiles,
    profile,
    publicProfile,
    presentation,
  };
}
it("allows optional photos and amenities to remain empty", async () => {
  const h = harness();
  const evidence = await h.source.getSubmissionEvidence(scope);
  expect(evidence.group.status).toBe("ready");
  expect(evidence.snapshot.media).toHaveLength(1);
  expect(h.step1.getState).toHaveBeenCalledWith(scope);
  expect(h.profiles.getPropertyProfile).toHaveBeenCalledWith(scope);
});
it("blocks missing prerequisite facts with owning-step evidence", async () => {
  const h = harness();
  h.profile.profile.location.latitude = null as unknown as number;
  h.profile.profile.contacts = [];
  h.publicProfile.publicProfile.media = [];
  const evidence = await h.source.getSubmissionEvidence(scope);
  expect(evidence.group.status).toBe("blocked");
  expect(evidence.group.steps[0]?.entities[0]?.blockers.map((value) => value.code)).toEqual([
    "hotel_location_incomplete",
    "hotel_email_missing",
    "hotel_phone_missing",
    "hotel_logo_missing",
  ]);
  expect(
    evidence.group.steps[0]?.entities[0]?.blockers.every(
      (value) => value.owningStepId === "present_hotel",
    ),
  ).toBe(true);
});
it("blocks an unanswered summary and missing public address", async () => {
  const h = harness();
  h.presentation.readModel.profile.shortDescription = null as unknown as string;
  h.presentation.readModel.profile.publicSlug = null as unknown as string;
  const evidence = await h.source.getSubmissionEvidence(scope);
  expect(evidence.group.steps[0]?.entities[0]?.blockers.map((value) => value.code)).toEqual([
    "hotel_summary_incomplete",
    "hotel_public_slug_missing",
  ]);
});
it("rejects a foreign scope or mismatched owner revisions", async () => {
  const h = harness();
  h.publicProfile.propertyId = "other";
  await expect(h.source.getSubmissionEvidence(scope)).rejects.toThrow("unavailable");
  h.publicProfile.propertyId = propertyId;
  h.publicProfile.profileRevision = 2;
  await expect(h.source.getSubmissionEvidence(scope)).rejects.toThrow("changed");
});
it("detects media approval drift even without a profile revision change", async () => {
  const h = harness();
  h.profiles.getPublicPropertyProfile.mockResolvedValueOnce(structuredClone(h.publicProfile));
  h.publicProfile.publicProfile.media = [];
  await expect(h.source.getSubmissionEvidence(scope)).rejects.toThrow("changed");
});
it("includes public media changes in the source identity", async () => {
  const h = harness();
  const before = await h.source.getSubmissionEvidence(scope);
  h.publicProfile.publicProfile.media[0]!.url = "https://media.example/replaced.png";
  const after = await h.source.getSubmissionEvidence(scope);
  expect(before.source.revision).not.toBe(after.source.revision);
  expect(before.snapshot.media[0]?.url).toBe("https://media.example/logo.png");
});
it("does not manufacture missing fields after provider failure", async () => {
  const h = harness();
  h.step1.getState.mockRejectedValue(new Error("provider unavailable"));
  await expect(h.source.getSubmissionEvidence(scope)).rejects.toThrow("provider unavailable");
});
