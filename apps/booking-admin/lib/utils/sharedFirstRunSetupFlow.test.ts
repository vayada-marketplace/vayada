import { describe, expect, it } from "vitest";

import {
  isSharedHotelSetupProductSelectable,
  resolveSharedFirstRunSetupView,
  selectedProductsForProperty,
  type SharedHotelSetupStatus,
  type SharedSetupProperty,
} from "@vayada/hotel-setup-wizard";

describe("resolveSharedFirstRunSetupView", () => {
  it("starts first-property users on the property profile form", () => {
    expect(resolveSharedFirstRunSetupView(status({ properties: [] }))).toMatchObject({
      screen: "property_profile",
      profileMode: "create",
      selectedPropertyId: null,
      title: "Add property",
    });
  });

  it("shows a property selector when the hotel group owns multiple properties", () => {
    expect(
      resolveSharedFirstRunSetupView(
        status({
          properties: [property("property-1"), property("property-2")],
          nextAction: { action: "select_property", reasonCodes: ["multiple_properties"] },
        }),
      ),
    ).toMatchObject({
      screen: "property_selection",
      profileMode: null,
      selectedPropertyId: null,
      title: "Choose property",
    });
  });

  it("routes incomplete shared profiles to the update form for the selected property", () => {
    expect(
      resolveSharedFirstRunSetupView(
        status({
          properties: [property("property-1", { displayName: "Alpenrose Munich" })],
          selectedPropertyId: "property-1",
          nextAction: {
            action: "complete_shared_profile",
            propertyId: "property-1",
            missingFields: ["media"],
            reasonCodes: ["shared_profile_incomplete"],
          },
        }),
      ),
    ).toMatchObject({
      screen: "property_profile",
      profileMode: "update",
      selectedPropertyId: "property-1",
      title: "Alpenrose Munich",
    });
  });

  it("can force add-property mode inside the current hotel group", () => {
    expect(
      resolveSharedFirstRunSetupView(
        status({
          properties: [property("property-1"), property("property-2")],
          nextAction: { action: "select_property", reasonCodes: ["multiple_properties"] },
        }),
        { forceCreateProperty: true },
      ),
    ).toMatchObject({
      screen: "property_profile",
      profileMode: "create",
      selectedPropertyId: null,
      title: "Add property",
    });
  });

  it("excludes unavailable and suspended products from selected products", () => {
    const setupProperty = property("property-1");
    setupProperty.products.booking.status = "active";
    setupProperty.products.pms.status = "unavailable";
    setupProperty.products.marketplace.status = "suspended";

    expect(selectedProductsForProperty(setupProperty, "pms")).toEqual(["booking"]);
    expect(isSharedHotelSetupProductSelectable(setupProperty, "booking")).toBe(true);
    expect(isSharedHotelSetupProductSelectable(setupProperty, "pms")).toBe(false);
    expect(isSharedHotelSetupProductSelectable(setupProperty, "marketplace")).toBe(false);
  });
});

function status(input: {
  properties: SharedSetupProperty[];
  selectedPropertyId?: string | null;
  nextAction?: SharedHotelSetupStatus["nextAction"];
}): SharedHotelSetupStatus {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "booking", returnTo: "/dashboard" },
    hotelGroup: { organizationId: "org_1", displayName: "Alpenrose Hotel Group" },
    selection: {
      state:
        input.properties.length === 0
          ? "no_property"
          : input.properties.length === 1
            ? "single_property"
            : "multiple_properties",
      selectedPropertyId: input.selectedPropertyId ?? null,
    },
    properties: input.properties,
    nextAction: input.nextAction ?? { action: "create_property", reasonCodes: ["no_property"] },
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function property(
  propertyId: string,
  input: Partial<Pick<SharedSetupProperty, "displayName" | "locationSummary">> = {},
): SharedSetupProperty {
  return {
    propertyId,
    publicId: propertyId,
    displayName: input.displayName ?? propertyId,
    locationSummary: input.locationSummary ?? "Munich, DE",
    sharedProfile: {
      status: "incomplete",
      source: "canonical",
      completionPercent: 83,
      missingFields: ["media"],
    },
    products: {
      booking: {
        product: "booking",
        status: "not_selected",
        missingSteps: [],
        statusReasons: [],
        updatedAt: null,
      },
      pms: {
        product: "pms",
        status: "not_selected",
        missingSteps: [],
        statusReasons: [],
        updatedAt: null,
      },
      marketplace: {
        product: "marketplace",
        status: "not_selected",
        missingSteps: [],
        statusReasons: [],
        updatedAt: null,
      },
    },
  };
}
