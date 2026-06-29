"use client";

import {
  type FeatureActivationClient,
  type ModuleActivation,
  type ModuleActivationsResponse,
} from "@vayada/feature-hub";

import { isNextApiTarget } from "./client";
import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "./pmsPropertyClient";
import { pmsClient } from "./pmsClient";

const PMS_BASE_URL = process.env.NEXT_PUBLIC_PMS_API_URL || "https://api.pms.localhost";

function moduleActivationsEndpoint(propertyId: string, moduleId?: string): string {
  const base = `/api/pms/properties/${encodeURIComponent(propertyId)}/module-activations`;
  return moduleId ? `${base}/${encodeURIComponent(moduleId)}` : base;
}

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

export const moduleActivationClient: FeatureActivationClient = {
  list: async () => {
    if (isNextApiTarget(PMS_BASE_URL)) {
      const propertyId = await resolveSelectedPmsPropertyId("loading module activations");
      return pmsOperationsClient.get<ModuleActivationsResponse>(
        moduleActivationsEndpoint(propertyId),
        pmsOperationsRequestOptions,
      );
    }
    return retryWithoutStaleHotelContext(() =>
      pmsClient.get<ModuleActivationsResponse>("/admin/module-activations"),
    );
  },
  update: async (moduleId: string, isActive: boolean) => {
    if (isNextApiTarget(PMS_BASE_URL)) {
      const propertyId = await resolveSelectedPmsPropertyId("updating module activations");
      return pmsOperationsClient.patch<ModuleActivation>(
        moduleActivationsEndpoint(propertyId, moduleId),
        { moduleId, isActive },
        pmsOperationsRequestOptions,
      );
    }
    return retryWithoutStaleHotelContext(() =>
      pmsClient.patch<ModuleActivation>(`/admin/module-activations/${moduleId}`, {
        moduleId,
        isActive,
      }),
    );
  },
};
