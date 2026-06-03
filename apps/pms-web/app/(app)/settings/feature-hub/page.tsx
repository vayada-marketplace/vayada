"use client";

import {
  FeatureHubPage,
  type FeatureActivationClient,
  type FeatureProduct,
  type ModuleActivation,
  type ModuleActivationsResponse,
} from "@vayada/feature-hub";
import { pmsClient } from "@/services/api/pmsClient";

function isHotelContextMismatch(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; data?: { detail?: unknown } };
  const detail = typeof candidate.data?.detail === "string" ? candidate.data.detail : "";
  const message = error instanceof Error ? error.message : "";
  return (
    (candidate.status === 403 || detail.includes("X-Hotel-Id")) &&
    (detail.includes("X-Hotel-Id") || message.includes("X-Hotel-Id"))
  );
}

async function retryWithoutStaleHotelContext<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (isHotelContextMismatch(error) && typeof window !== "undefined") {
      window.localStorage.removeItem("selectedHotelId");
      return request();
    }
    throw error;
  }
}

const ACTIVATION_CLIENT: FeatureActivationClient = {
  list: () =>
    retryWithoutStaleHotelContext(() =>
      pmsClient.get<ModuleActivationsResponse>("/admin/module-activations"),
    ),
  update: (moduleId: string, isActive: boolean) =>
    retryWithoutStaleHotelContext(() =>
      pmsClient.patch<ModuleActivation>(`/admin/module-activations/${moduleId}`, {
        moduleId,
        isActive,
      }),
    ),
};

const PRODUCTS: FeatureProduct[] = ["pms"];

export default function PmsFeatureHubRoute() {
  return (
    <FeatureHubPage activationClient={ACTIVATION_CLIENT} initialProduct="pms" products={PRODUCTS} />
  );
}
