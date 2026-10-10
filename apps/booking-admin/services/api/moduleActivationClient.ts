"use client";

import {
  combineActivationClients,
  PMS_NAVIGATION_MODULE_IDS,
  type FeatureActivationClient,
  type ModuleActivation,
  type ModuleActivationsResponse,
} from "@vayada/feature-hub";

import { getSelectedBookingHotelId } from "./bookingHotelScope";
import { apiClient, omitHotelContext } from "./client";
import { getBookingHotelPropertyLink } from "./bookingPropertyLinkClient";

type ModuleStore = "module-activations" | "navigation-modules";

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

// The PMS Inbox and Reviews sidebar switches are managed here too (VAY-2078). Their store is
// optional: if it cannot be read, Financials still loads.
export const moduleActivationClient: FeatureActivationClient = combineActivationClients([
  {
    client: propertyModuleClient("navigation-modules"),
    modules: PMS_NAVIGATION_MODULE_IDS,
    optional: true,
  },
  { client: propertyModuleClient("module-activations") },
]);
