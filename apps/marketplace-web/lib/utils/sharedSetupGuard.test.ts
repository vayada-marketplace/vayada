import { describe, expect, it, vi } from "vitest";
import type { SharedHotelSetupStatus } from "@vayada/hotel-setup-wizard";

import { resolveMarketplaceSetupGuard } from "./sharedSetupGuard";

describe("resolveMarketplaceSetupGuard", () => {
  it("redirects incomplete setup to the shared wizard with the marketplace entry product", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          nextAction: {
            action: "complete_product_activation",
            propertyId: "property-1",
            product: "marketplace",
            missingSteps: ["marketplace_activation"],
            reasonCodes: ["product_activation_incomplete"],
          },
        }),
      ),
    };
    const storage = memoryStorage({ selectedSharedPropertyId: "property-1" });

    const decision = await resolveMarketplaceSetupGuard("/marketplace?tab=creators", api, storage);

    expect(api.getStatus).toHaveBeenCalledWith({
      entryProduct: "marketplace",
      returnTo: "/marketplace?tab=creators",
      propertyId: "property-1",
    });
    expect(decision).toEqual({
      action: "redirect_to_setup",
      propertyId: "property-1",
      redirectPath: "/setup?entryProduct=marketplace&returnTo=%2Fmarketplace%3Ftab%3Dcreators",
    });
  });

  it("persists the property id when marketplace can enter the product", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          nextAction: {
            action: "enter_product",
            propertyId: "property-2",
            product: "marketplace",
            returnTo: "/marketplace",
            reasonCodes: ["ready"],
          },
        }),
      ),
    };
    const storage = memoryStorage();

    const decision = await resolveMarketplaceSetupGuard("/marketplace", api, storage);

    expect(decision).toEqual({
      action: "enter_product",
      propertyId: "property-2",
      redirectPath: null,
    });
    expect(storage.getItem("selectedSharedPropertyId")).toBe("property-2");
  });
});

function status(input: {
  nextAction: SharedHotelSetupStatus["nextAction"];
}): SharedHotelSetupStatus {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "marketplace", returnTo: "/marketplace" },
    hotelGroup: { organizationId: "org-1", displayName: "Alpenrose Hotel Group" },
    selection: { state: "single_property", selectedPropertyId: "property-1" },
    properties: [],
    nextAction: input.nextAction,
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
