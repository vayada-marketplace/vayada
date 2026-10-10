"use client";

import type {
  FeatureActivationClient,
  ModuleActivation,
  ModuleActivationsResponse,
} from "@vayada/feature-hub";

import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "./pmsPropertyClient";

// Type-only imports keep the Feature Hub UI out of the sidebar bundle.
export function propertyModuleClient(
  store: "module-activations" | "navigation-modules",
): FeatureActivationClient {
  const endpoint = (propertyId: string, moduleId?: string) => {
    const base = `/api/pms/properties/${encodeURIComponent(propertyId)}/${store}`;
    return moduleId ? `${base}/${encodeURIComponent(moduleId)}` : base;
  };
  return {
    list: async () => {
      const propertyId = await resolveSelectedPmsPropertyId("loading module activations");
      return pmsOperationsClient.get<ModuleActivationsResponse>(
        endpoint(propertyId),
        pmsOperationsRequestOptions,
      );
    },
    update: async (moduleId: string, isActive: boolean) => {
      const propertyId = await resolveSelectedPmsPropertyId("updating module activations");
      return pmsOperationsClient.patch<ModuleActivation>(
        endpoint(propertyId, moduleId),
        { moduleId, isActive },
        pmsOperationsRequestOptions,
      );
    },
  };
}

/** Inbox and Reviews sidebar switches only (VAY-2078). */
export const pmsNavigationModuleClient = propertyModuleClient("navigation-modules");
