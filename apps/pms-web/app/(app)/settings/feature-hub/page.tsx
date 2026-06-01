"use client";

import {
  FeatureHubPage,
  type FeatureActivationClient,
  type ModuleActivation,
  type ModuleActivationsResponse,
} from "@vayada/feature-hub";
import { pmsClient } from "@/services/api/pmsClient";

const activationClient: FeatureActivationClient = {
  list: () => pmsClient.get<ModuleActivationsResponse>("/admin/module-activations"),
  update: (moduleId: string, isActive: boolean) =>
    pmsClient.patch<ModuleActivation>(`/admin/module-activations/${moduleId}`, {
      moduleId,
      isActive,
    }),
};

export default function PmsFeatureHubRoute() {
  return <FeatureHubPage activationClient={activationClient} initialProduct="pms" />;
}
