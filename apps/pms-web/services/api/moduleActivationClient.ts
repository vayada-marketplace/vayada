"use client";

import {
  combineActivationClients,
  PMS_NAVIGATION_MODULE_IDS,
  type FeatureActivationClient,
} from "@vayada/feature-hub";

import { pmsNavigationModuleClient, propertyModuleClient } from "./pmsNavigationModuleClient";

// The Inbox and Reviews store is optional: if it cannot be read, Financials still loads.
export const moduleActivationClient: FeatureActivationClient = combineActivationClients([
  { client: pmsNavigationModuleClient, modules: PMS_NAVIGATION_MODULE_IDS, optional: true },
  { client: propertyModuleClient("module-activations") },
]);
