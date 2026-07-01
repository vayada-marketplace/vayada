"use client";

import {
  type FeatureActivationClient,
  type ModuleActivation,
  type ModuleActivationsResponse,
} from "@vayada/feature-hub";

import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "./pmsPropertyClient";

function moduleActivationsEndpoint(propertyId: string, moduleId?: string): string {
  const base = `/api/pms/properties/${encodeURIComponent(propertyId)}/module-activations`;
  return moduleId ? `${base}/${encodeURIComponent(moduleId)}` : base;
}

export const moduleActivationClient: FeatureActivationClient = {
  list: async () => {
    const propertyId = await resolveSelectedPmsPropertyId("loading module activations");
    return pmsOperationsClient.get<ModuleActivationsResponse>(
      moduleActivationsEndpoint(propertyId),
      pmsOperationsRequestOptions,
    );
  },
  update: async (moduleId: string, isActive: boolean) => {
    const propertyId = await resolveSelectedPmsPropertyId("updating module activations");
    return pmsOperationsClient.patch<ModuleActivation>(
      moduleActivationsEndpoint(propertyId, moduleId),
      { moduleId, isActive },
      pmsOperationsRequestOptions,
    );
  },
};
