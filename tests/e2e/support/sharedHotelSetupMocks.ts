type SharedHotelSetupMockProduct = {
  product: string;
  status: string;
  missingSteps: string[];
  statusReasons: string[];
  updatedAt: string | null;
};

type SharedHotelSetupStatusMockInput = {
  entryProduct: string;
  returnTo: string;
  organizationId: string;
  organizationDisplayName: string;
  propertyId: string;
  publicId: string;
  propertyDisplayName: string;
  locationSummary: string;
  sharedProfileSource?: "canonical" | "legacy_prefill";
  products: Record<string, SharedHotelSetupMockProduct>;
  nextAction: {
    action: string;
    product: string;
    propertyId: string;
    returnTo: string;
    reasonCodes: string[];
  };
  updatedAt?: string;
};

export function sharedHotelSetupProduct(
  productName: string,
  status: string,
): SharedHotelSetupMockProduct {
  return {
    product: productName,
    status,
    missingSteps: [],
    statusReasons: [],
    updatedAt: null,
  };
}

export function createSharedHotelSetupStatusMock(input: SharedHotelSetupStatusMockInput) {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: input.entryProduct, returnTo: input.returnTo },
    hotelGroup: {
      organizationId: input.organizationId,
      displayName: input.organizationDisplayName,
    },
    selection: { state: "single_property", selectedPropertyId: input.propertyId },
    properties: [
      {
        propertyId: input.propertyId,
        publicId: input.publicId,
        displayName: input.propertyDisplayName,
        locationSummary: input.locationSummary,
        sharedProfile: {
          status: "complete",
          source: input.sharedProfileSource ?? "canonical",
          completionPercent: 100,
          missingFields: [],
        },
        products: input.products,
      },
    ],
    nextAction: input.nextAction,
    updatedAt: input.updatedAt ?? "2026-06-30T00:00:00.000Z",
  };
}
