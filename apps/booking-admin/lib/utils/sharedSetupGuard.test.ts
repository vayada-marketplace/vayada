import { describe, expect, it, vi } from "vitest";
import type { AdaptiveHotelSetupStatus } from "@vayada/product-onboarding";

import { resolveBookingSetupGuard } from "./sharedSetupGuard";

describe("resolveBookingSetupGuard", () => {
  it("routes setup_required decisions to the canonical Marketplace wizard", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          decision: "setup_required",
          reasonCode: "product_access_pending",
        }),
      ),
    };
    const storage = memoryStorage({ selectedSharedPropertyId: "property-1" });

    await expect(
      resolveBookingSetupGuard(
        "/dashboard?tab=rooms",
        api,
        storage,
        "https://marketplace.localhost:1355",
      ),
    ).resolves.toEqual({
      action: "redirect_to_setup",
      propertyId: "property-1",
      redirectPath:
        "https://marketplace.localhost:1355/setup?entryProduct=booking&returnProduct=booking&returnTo=%2Fdashboard%3Ftab%3Drooms&propertyId=property-1",
      entryDecision: "setup_required",
      reasonCode: "product_access_pending",
    });
    expect(api.getStatus).toHaveBeenCalledWith({
      entryProduct: "booking",
      propertyId: "property-1",
    });
  });

  it("redirects to this app's own /setup when no base URL is given", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({ decision: "setup_required", reasonCode: "product_access_pending" }),
      ),
    };

    await expect(
      resolveBookingSetupGuard("/dashboard", api, memoryStorage()),
    ).resolves.toMatchObject({
      action: "redirect_to_setup",
      redirectPath:
        "/setup?entryProduct=booking&returnProduct=booking&returnTo=%2Fdashboard&propertyId=property-1",
    });
  });

  it("enters Booking solely from the server entry decision, regardless of launch tasks", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          propertyId: "property-2",
          decision: "enter",
          destinationRouteKey: "booking.workspace",
          withIncompleteTask: true,
        }),
      ),
    };
    const storage = memoryStorage();

    await expect(resolveBookingSetupGuard("/dashboard", api, storage)).resolves.toEqual({
      action: "enter_product",
      propertyId: "property-2",
      destinationRouteKey: "booking.workspace",
      redirectPath: null,
    });
    expect(storage.getItem("selectedSharedPropertyId")).toBe("property-2");
  });

  it("verifies the property named by a setup-exit marker instead of the stored one", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          propertyId: "property-3",
          decision: "enter",
          destinationRouteKey: "booking.workspace",
        }),
      ),
    };
    const storage = memoryStorage({ selectedSharedPropertyId: "property-1" });

    await expect(
      resolveBookingSetupGuard(
        "/dashboard?setup=incomplete&propertyId=property-3",
        api,
        storage,
        undefined,
        { propertyId: "property-3" },
      ),
    ).resolves.toMatchObject({ action: "enter_product", propertyId: "property-3" });
    expect(api.getStatus).toHaveBeenCalledWith({
      entryProduct: "booking",
      propertyId: "property-3",
    });
    expect(storage.getItem("selectedSharedPropertyId")).toBe("property-3");
  });

  it("does not enter Booking when the server marks it unavailable", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          decision: "unavailable",
          reasonCode: "track_unavailable",
        }),
      ),
    };

    await expect(
      resolveBookingSetupGuard("/dashboard", api, memoryStorage()),
    ).resolves.toMatchObject({
      action: "redirect_to_setup",
      entryDecision: "unavailable",
      reasonCode: "track_unavailable",
    });
  });
});

function status(input: {
  propertyId?: string;
  decision: "enter" | "setup_required" | "unavailable";
  destinationRouteKey?: string;
  reasonCode?: string;
  withIncompleteTask?: boolean;
}): AdaptiveHotelSetupStatus {
  const propertyId = input.propertyId ?? "property-1";
  return {
    contractVersion: "adaptive-hotel-setup.v1",
    organization: {
      organizationId: "org-1",
      displayName: "Alpenrose Hotel Group",
      websiteUrl: null,
      selectedTracks: ["hotel_operations"],
      trackRevision: 2,
      canManageTracks: true,
      tracks: [
        {
          track: "hotel_operations",
          provisioning: "active",
          components: [
            { product: "pms", access: "active" },
            {
              product: "booking",
              access: input.decision === "unavailable" ? "unavailable" : "active",
            },
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
          publicId: propertyId,
          displayName: "Alpenrose",
          locationSummary: "Munich, DE",
        },
      ],
    },
    entryDecision: {
      requestedProduct: "booking",
      propertyId,
      decision: input.decision,
      destinationRouteKey: input.destinationRouteKey ?? null,
      reasonCode: input.reasonCode ?? null,
    },
    setupPlan: {
      propertyId,
      tasks: input.withIncompleteTask
        ? [
            {
              taskId: "shared_identity",
              propertyId,
              track: "shared",
              requirementOwnerDomain: "hotel_catalog",
              destinationRouteKey: "hotel_catalog.shared_identity",
              callerCapability: "allowed",
              ownerProgress: "in_progress",
              readiness: "actionable",
              actionableBy: "operator",
              reasonCodes: ["missing_phone_contact"],
              sourceRevision: "identity-1",
              freshness: "fresh",
              evaluatedAt: "2026-07-26T10:00:00.000Z",
            },
          ]
        : [],
    },
    updatedAt: "2026-07-26T10:00:00.000Z",
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
