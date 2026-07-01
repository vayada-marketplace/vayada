"use client";

import {
  type FeatureActivationClient,
  type ModuleActivation,
  type ModuleActivationsResponse,
} from "@vayada/feature-hub";

import { getSelectedBookingHotelId } from "./bookingHotelScope";
import { apiClient, omitHotelContext } from "./client";
import { getBookingHotelPropertyLink } from "./bookingPropertyLinkClient";

async function moduleActivationsEndpoint(): Promise<string> {
  const hotelId = getSelectedBookingHotelId();
  if (!hotelId) throw new Error("Select a property before loading module activations.");
  const propertyLink = await getBookingHotelPropertyLink({ hotelId });
  return `/api/pms/properties/${encodeURIComponent(propertyLink.propertyId)}/module-activations`;
}

export const moduleActivationClient: FeatureActivationClient = {
  list: async () => {
    return apiClient.get<ModuleActivationsResponse>(
      await moduleActivationsEndpoint(),
      omitHotelContext,
    );
  },
  update: async (moduleId: string, isActive: boolean) => {
    return apiClient.patch<ModuleActivation>(
      `${await moduleActivationsEndpoint()}/${encodeURIComponent(moduleId)}`,
      {
        moduleId,
        isActive,
      },
      omitHotelContext,
    );
  },
};
