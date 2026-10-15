"use client";

import {
  BOOKING_MODULE_IDS,
  combineActivationClients,
  PMS_NAVIGATION_MODULE_IDS,
  type FeatureActivationClient,
  type ModuleActivation,
  type ModuleActivationsResponse,
} from "@vayada/feature-hub";

import { getSelectedBookingHotelId } from "./bookingHotelScope";
import { apiClient, omitHotelContext } from "./client";
import { getBookingHotelPropertyLink } from "./bookingPropertyLinkClient";

type ModuleStore = "module-activations" | "navigation-modules" | "booking-modules";

async function moduleStoreEndpoint(store: ModuleStore): Promise<string> {
  const hotelId = getSelectedBookingHotelId();
  if (!hotelId) throw new Error("Select a property before loading module activations.");
  const propertyLink = await getBookingHotelPropertyLink({ hotelId });
  return `/api/pms/properties/${encodeURIComponent(propertyLink.propertyId)}/${store}`;
}

function propertyModuleClient(store: ModuleStore): FeatureActivationClient {
  return {
    list: async () => {
      return apiClient.get<ModuleActivationsResponse>(
        await moduleStoreEndpoint(store),
        omitHotelContext,
      );
    },
    update: async (moduleId: string, isActive: boolean) => {
      return apiClient.patch<ModuleActivation>(
        `${await moduleStoreEndpoint(store)}/${encodeURIComponent(moduleId)}`,
        {
          moduleId,
          isActive,
        },
        omitHotelContext,
      );
    },
  };
}

// The PMS Inbox and Reviews sidebar switches (VAY-2078) and the Add-ons and Promos switches
// (VAY-2200) are managed here too. Their stores are optional: if one cannot be read, the rest
// still loads.
export const moduleActivationClient: FeatureActivationClient = combineActivationClients([
  {
    client: propertyModuleClient("navigation-modules"),
    modules: PMS_NAVIGATION_MODULE_IDS,
    optional: true,
  },
  { client: propertyModuleClient("booking-modules"), modules: BOOKING_MODULE_IDS, optional: true },
  { client: propertyModuleClient("module-activations") },
]);
