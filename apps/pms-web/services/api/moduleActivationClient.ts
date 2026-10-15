"use client";

import {
  BOOKING_MODULE_IDS,
  combineActivationClients,
  PMS_NAVIGATION_MODULE_IDS,
  type FeatureActivationClient,
} from "@vayada/feature-hub";

import { pmsNavigationModuleClient, propertyModuleClient } from "./pmsNavigationModuleClient";

// The Inbox/Reviews and Add-ons/Promos stores are optional: if one cannot be read, the rest
// still loads.
export const moduleActivationClient: FeatureActivationClient = combineActivationClients([
  { client: pmsNavigationModuleClient, modules: PMS_NAVIGATION_MODULE_IDS, optional: true },
  {
    client: propertyModuleClient("booking-modules"),
    modules: BOOKING_MODULE_IDS,
    optional: true,
  },
  { client: propertyModuleClient("module-activations") },
]);
