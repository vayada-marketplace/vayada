import { describe, expect, it } from "vitest";

import {
  ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
  SETUP_TRACK_COMPONENT_PRODUCTS,
  OFFERED_SETUP_TRACKS,
  SETUP_TRACKS,
  isSetupTrack,
  isSetupTaskLaunchable,
  normalizeStoredSetupTracks,
  parseAdaptiveHotelSetupStatus,
  parseUpdateTracksRequest,
  type AdaptiveHotelSetupStatus,
  type UpdateTracksRequest,
} from "./adaptiveHotelSetup.js";

describe("adaptive hotel setup contracts", () => {
  it("exposes Hotel Operations as the only setup track (VAY-2270)", () => {
    expect(SETUP_TRACKS).toEqual(["hotel_operations"]);
    expect(isSetupTrack("hotel_operations")).toBe(true);
    expect(isSetupTrack("creator_marketplace")).toBe(false);
  });

  it("offers every setup track and reads the retired Creator Marketplace track as absent", () => {
    expect(OFFERED_SETUP_TRACKS).toEqual(SETUP_TRACKS);
    expect(normalizeStoredSetupTracks(["hotel_operations", "creator_marketplace"])).toEqual([
      "hotel_operations",
    ]);
    expect(normalizeStoredSetupTracks(["creator_marketplace"])).toEqual([]);
    expect(normalizeStoredSetupTracks(["creator_marketplace", "hotel_operations", "pms"])).toEqual([
      "hotel_operations",
    ]);
    expect(normalizeStoredSetupTracks([])).toEqual([]);
  });

  it.each(["pms", "booking", "marketplace", "unknown", null, undefined])(
    "rejects component product name %s as a setup track",
    (value) => {
      expect(isSetupTrack(value)).toBe(false);
    },
  );

  it("maps Hotel Operations to PMS and Booking as one bundle", () => {
    expect(SETUP_TRACK_COMPONENT_PRODUCTS).toEqual({ hotel_operations: ["pms", "booking"] });
  });

  it("keeps canonical tracks and component mappings immutable at runtime", () => {
    expect(Object.isFrozen(SETUP_TRACKS)).toBe(true);
    expect(Object.isFrozen(SETUP_TRACK_COMPONENT_PRODUCTS)).toBe(true);
    expect(Object.isFrozen(SETUP_TRACK_COMPONENT_PRODUCTS.hotel_operations)).toBe(true);

    expect(() => (SETUP_TRACKS as unknown as string[]).push("booking")).toThrow(TypeError);
    expect(() =>
      (SETUP_TRACK_COMPONENT_PRODUCTS.hotel_operations as unknown as string[]).push("marketplace"),
    ).toThrow(TypeError);

    expect(isSetupTrack("booking")).toBe(false);
  });

  it("parses and canonicalizes an update request", () => {
    const request = parseUpdateTracksRequest({
      selectedTracks: ["hotel_operations"],
      expectedRevision: 0,
    });

    expect(request).toEqual({
      selectedTracks: ["hotel_operations"],
      expectedRevision: 0,
    } satisfies UpdateTracksRequest);
  });

  it.each([
    null,
    {},
    { selectedTracks: [], expectedRevision: 0 },
    { selectedTracks: ["hotel_operations", "hotel_operations"], expectedRevision: 0 },
    { selectedTracks: ["booking"], expectedRevision: 0 },
    { selectedTracks: ["creator_marketplace"], expectedRevision: 0 },
    { selectedTracks: ["hotel_operations", "creator_marketplace"], expectedRevision: 0 },
    { selectedTracks: ["hotel_operations"], expectedRevision: -1 },
    { selectedTracks: ["hotel_operations"], expectedRevision: 0.5 },
    { selectedTracks: ["hotel_operations"], expectedRevision: 2_147_483_647 },
    { selectedTracks: ["hotel_operations"], expectedRevision: "0" },
    { selectedTracks: ["hotel_operations"], expectedRevision: 0, unexpected: true },
  ])("rejects an invalid update request: %j", (value) => {
    expect(parseUpdateTracksRequest(value)).toBeNull();
  });

  it("rejects sparse setup-track arrays", () => {
    const selectedTracks: unknown[] = [];
    selectedTracks.length = 1;

    expect(parseUpdateTracksRequest({ selectedTracks, expectedRevision: 0 })).toBeNull();
  });

  it("parses a valid adaptive hotel setup status", () => {
    const status: AdaptiveHotelSetupStatus = {
      contractVersion: ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
      organization: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        displayName: "Alpenrose Hotel Group",
        websiteUrl: null,
        selectedTracks: ["hotel_operations"],
        trackRevision: 1,
        canManageTracks: true,
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "active",
            components: [
              { product: "pms", access: "active" },
              { product: "booking", access: "active" },
            ],
            allowedActions: ["manage_service"],
          },
        ],
      },
      propertySelection: {
        state: "no_property",
        selectedPropertyId: null,
        availableProperties: [],
      },
      entryDecision: null,
      setupPlan: null,
      updatedAt: "2026-07-26T12:00:00.000Z",
    };

    expect(parseAdaptiveHotelSetupStatus(status)).toEqual(status);
  });

  it.each([
    { contractVersion: "shared-hotel-setup-status.v1" },
    { unexpected: true },
    { organization: { selectedTracks: ["booking"] } },
    { propertySelection: { state: "selected_property" } },
    { organization: { tracks: [{ provisioning: "ready" }] } },
    { entryDecision: { decision: "redirect" } },
    {
      entryDecision: {
        requestedProduct: "booking",
        propertyId: null,
        decision: "enter",
        destinationRouteKey: null,
        reasonCode: null,
      },
    },
    {
      organization: {
        selectedTracks: ["hotel_operations"],
        canManageTracks: true,
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "active",
            components: [
              { product: "pms", access: "active" },
              { product: "booking", access: "suspended" },
            ],
            allowedActions: ["manage_service"],
          },
        ],
      },
    },
  ])("rejects malformed, contradictory, or unknown adaptive status fields: %j", (override) => {
    const valid = parseAdaptiveHotelSetupStatus({
      contractVersion: ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
      organization: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        displayName: "Alpenrose Hotel Group",
        websiteUrl: null,
        selectedTracks: [],
        trackRevision: 0,
        canManageTracks: false,
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "not_selected",
            components: [
              { product: "pms", access: "absent" },
              { product: "booking", access: "absent" },
            ],
            allowedActions: [],
          },
        ],
      },
      propertySelection: {
        state: "no_property",
        selectedPropertyId: null,
        availableProperties: [],
      },
      entryDecision: null,
      setupPlan: null,
      updatedAt: "2026-07-26T12:00:00.000Z",
    });
    expect(valid).not.toBeNull();

    const value = structuredClone(valid!);
    Object.assign(value, override);
    if (override.organization) Object.assign(value.organization, override.organization);
    if (override.propertySelection)
      Object.assign(value.propertySelection, override.propertySelection);
    if (override.entryDecision) value.entryDecision = override.entryDecision as never;

    expect(parseAdaptiveHotelSetupStatus(value)).toBeNull();
  });

  describe("setup plan (VAY-2175)", () => {
    const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const task = (taskId: string, track: string, owner: string, route: string) => ({
      taskId,
      propertyId,
      track,
      requirementOwnerDomain: owner,
      destinationRouteKey: route,
      callerCapability: "allowed",
      ownerProgress: "not_started",
      readiness: "actionable",
      actionableBy: "owner",
      reasonCodes: [],
      sourceRevision: "1",
      freshness: "fresh",
      evaluatedAt: "2026-07-26T12:00:00.000Z",
    });
    const basics = task(
      "shared_identity",
      "shared",
      "hotel_catalog",
      "hotel_catalog.shared_identity",
    );
    const status = (setupPlan: Record<string, unknown>): Record<string, any> => ({
      contractVersion: ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
      organization: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        displayName: "Alpenrose Hotel Group",
        websiteUrl: null,
        selectedTracks: ["hotel_operations"],
        trackRevision: 1,
        canManageTracks: true,
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "active",
            components: [
              { product: "pms", access: "active" },
              { product: "booking", access: "active" },
            ],
            allowedActions: ["manage_service"],
          },
        ],
      },
      propertySelection: {
        state: "single_property",
        selectedPropertyId: propertyId,
        availableProperties: [
          {
            propertyId,
            publicId: "hotel-alpenrose",
            displayName: "Hotel Alpenrose",
            locationSummary: "Munich, DE",
          },
        ],
      },
      entryDecision: null,
      setupPlan: { propertyId, ...setupPlan },
      updatedAt: "2026-07-26T12:00:00.000Z",
    });

    it("accepts the hotel-basics plan", () => {
      const value = status({ tasks: [basics] });
      expect(parseAdaptiveHotelSetupStatus(value)).toEqual(value);
    });

    it("accepts the old full plan the API still sends, without reading its other tasks and keys", () => {
      const value = status({
        planRevision: "tracks:1",
        tasks: [
          basics,
          task(
            "rooms_rates_availability",
            "hotel_operations",
            "pms",
            "pms.rooms_rates_availability",
          ),
          task(
            "guest_settings_policies",
            "hotel_operations",
            "booking",
            "booking.guest_settings_policies",
          ),
          task("billing_plan", "hotel_operations", "finance", "finance.billing_plan"),
          task("payment", "hotel_operations", "finance", "finance.payment"),
          task(
            "direct_booking_publication",
            "hotel_operations",
            "distribution",
            "distribution.direct_booking_publication",
          ),
        ],
        // No longer checked against the tasks: nothing reads them.
        recommendedTaskId: "payment",
        ownerProgress: { complete: 3, total: 6 },
        launchReadiness: { operationsUse: "ready", directBookingPublish: "ready" },
      });
      expect(parseAdaptiveHotelSetupStatus(value)).toEqual(value);
    });

    it.each([
      ["a malformed task", { tasks: [{ ...basics, readiness: "not_a_readiness" }] }],
      ["no hotel-basics task while a track is selected", { tasks: [] }],
      ["the same task twice", { tasks: [basics, basics] }],
      ["another property's task", { tasks: [{ ...basics, propertyId: "other-property" }] }],
      // The retired Marketplace tasks are unknown task IDs now.
      ["a retired Marketplace task", { tasks: [basics, { ...basics, taskId: "public_profile" }] }],
      ["an unknown plan key", { tasks: [basics], marketplacePublish: "not_applicable" }],
    ])("rejects a plan with %s", (_, setupPlan) => {
      expect(parseAdaptiveHotelSetupStatus(status(setupPlan))).toBeNull();
    });
  });

  it("rejects the retired Marketplace track entry the API stopped sending (VAY-2270)", () => {
    const status = (): Record<string, any> => ({
      contractVersion: ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
      organization: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        displayName: "Alpenrose Hotel Group",
        websiteUrl: null,
        selectedTracks: ["hotel_operations"],
        trackRevision: 1,
        canManageTracks: false,
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "active",
            components: [
              { product: "pms", access: "active" },
              { product: "booking", access: "active" },
            ],
            allowedActions: [],
          },
          {
            track: "creator_marketplace",
            provisioning: "not_selected",
            components: [{ product: "marketplace", access: "absent" }],
            allowedActions: [],
          },
        ],
      },
      propertySelection: {
        state: "no_property",
        selectedPropertyId: null,
        availableProperties: [],
      },
      entryDecision: null,
      setupPlan: null,
      updatedAt: "2026-07-26T12:00:00.000Z",
    });
    const withoutRetiredTrack = status();
    withoutRetiredTrack.organization.tracks.pop();
    expect(parseAdaptiveHotelSetupStatus(status())).toBeNull();
    expect(parseAdaptiveHotelSetupStatus(withoutRetiredTrack)).toEqual(withoutRetiredTrack);

    // Naming the retired track as selected is rejected on its own too.
    const selected = status();
    selected.organization.tracks.pop();
    selected.organization.selectedTracks = ["hotel_operations", "creator_marketplace"];
    expect(parseAdaptiveHotelSetupStatus(selected)).toBeNull();
  });

  it("recommends only actionable tasks the caller may start", () => {
    const task = { track: "shared", callerCapability: "allowed", readiness: "actionable" } as const;
    expect(isSetupTaskLaunchable(task)).toBe(true);
    expect(isSetupTaskLaunchable({ ...task, readiness: "rejected" })).toBe(false);
    expect(isSetupTaskLaunchable({ ...task, callerCapability: "ask_owner" })).toBe(false);
    expect(isSetupTaskLaunchable(null)).toBe(false);
  });
});
