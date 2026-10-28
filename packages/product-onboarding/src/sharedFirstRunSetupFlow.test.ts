import type {
  AdaptiveHotelSetupStatus,
  SetupTask,
  SetupTaskId,
  SetupTrack,
} from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

import {
  parseSharedHotelSetupEntryProduct,
  resolveSharedFirstRunSetupView,
  toggleSetupTrackSelection,
} from "./sharedFirstRunSetupFlow";

describe("parseSharedHotelSetupEntryProduct", () => {
  it("reads an old Marketplace link as booking setup and refuses unknown products", () => {
    expect(parseSharedHotelSetupEntryProduct("pms")).toBe("pms");
    expect(parseSharedHotelSetupEntryProduct("booking")).toBe("booking");
    expect(parseSharedHotelSetupEntryProduct("marketplace")).toBe("booking");
    expect(parseSharedHotelSetupEntryProduct("affiliate")).toBeNull();
    expect(parseSharedHotelSetupEntryProduct(null)).toBeNull();
  });
});

describe("resolveSharedFirstRunSetupView", () => {
  it("shows track selection first and does not infer a track from the entry product", () => {
    const status = statusFor([], []);
    status.propertySelection = {
      state: "no_property",
      selectedPropertyId: null,
      availableProperties: [],
    };
    status.setupPlan = null;
    status.entryDecision = {
      requestedProduct: "booking",
      propertyId: null,
      decision: "setup_required",
      destinationRouteKey: "hotel_setup",
      reasonCode: "track_not_selected",
    };

    expect(resolveSharedFirstRunSetupView(status)).toMatchObject({
      screen: "track_selection",
      profileMode: null,
    });
    expect(status.organization.selectedTracks).toEqual([]);
  });

  it("keeps the authoritative hotel-basics plan (VAY-2175)", () => {
    const view = resolveSharedFirstRunSetupView(
      statusFor(["hotel_operations"], ["shared_identity"]),
    );

    expect(view.screen).toBe("setup_plan");
    expect(view.setupPlan?.tasks.map(({ taskId }) => taskId)).toEqual(["shared_identity"]);
  });

  it("reopens the selected property's existing profile inside setup when hotel basics are edited", () => {
    const status = statusFor(["hotel_operations"], ["shared_identity"]);

    expect(resolveSharedFirstRunSetupView(status, { editPropertyProfile: true })).toMatchObject({
      screen: "property_profile",
      profileMode: "update",
      selectedPropertyId: "property-1",
      title: "Hotel Alpenrose",
    });
  });
});

describe("toggleSetupTrackSelection", () => {
  it("locks existing tracks and toggles an unlocked one", () => {
    expect(
      toggleSetupTrackSelection(["hotel_operations"], ["hotel_operations"], "hotel_operations"),
    ).toEqual(["hotel_operations"]);
    expect(toggleSetupTrackSelection([], [], "hotel_operations")).toEqual(["hotel_operations"]);
    expect(toggleSetupTrackSelection(["hotel_operations"], [], "hotel_operations")).toEqual([]);
  });
});

function statusFor(selectedTracks: SetupTrack[], taskIds: SetupTaskId[]): AdaptiveHotelSetupStatus {
  const tasks = taskIds.map(setupTask);
  return {
    contractVersion: "adaptive-hotel-setup.v1",
    organization: {
      organizationId: "organization-1",
      displayName: "Alpenrose Group",
      websiteUrl: null,
      selectedTracks,
      trackRevision: 1,
      canManageTracks: true,
      tracks: [
        {
          track: "hotel_operations",
          provisioning: selectedTracks.includes("hotel_operations") ? "active" : "not_selected",
          components: [
            { product: "pms", access: "active" },
            { product: "booking", access: "active" },
          ],
          allowedActions: [],
        },
      ],
    },
    propertySelection: {
      state: "single_property",
      selectedPropertyId: "property-1",
      availableProperties: [
        {
          propertyId: "property-1",
          publicId: "hotel-alpenrose",
          displayName: "Hotel Alpenrose",
          locationSummary: "Munich, Germany",
        },
      ],
    },
    entryDecision: null,
    setupPlan: { propertyId: "property-1", tasks },
    updatedAt: "2026-07-26T12:00:00.000Z",
  };
}

function setupTask(taskId: SetupTaskId): SetupTask {
  const complete = taskId === "shared_identity";
  const track = taskId === "shared_identity" ? "shared" : "hotel_operations";
  return {
    taskId,
    propertyId: "property-1",
    track,
    requirementOwnerDomain: "hotel_catalog",
    destinationRouteKey: `setup.${taskId}`,
    callerCapability: "allowed",
    ownerProgress: complete ? "owner_complete" : "not_started",
    readiness: complete ? "complete" : "actionable",
    actionableBy: complete ? null : "owner",
    reasonCodes: [],
    sourceRevision: "revision-1",
    freshness: "fresh",
    evaluatedAt: "2026-07-26T12:00:00.000Z",
  };
}
