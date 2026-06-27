"use client";

import {
  type FeatureActivationClient,
  type ModuleActivation,
  type ModuleActivationsResponse,
} from "@vayada/feature-hub";

import { isNextApiTarget } from "./client";
import { pmsClient } from "./pmsClient";

const PMS_BASE_URL = process.env.NEXT_PUBLIC_PMS_URL || "https://api.pms.localhost";
// The next API does not expose the legacy PMS module-activation route yet.
// Fail closed for next booking-admin until a per-hotel source of truth exists.

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

function selectedHotelId(): string {
  if (typeof window === "undefined") return "default";
  return window.localStorage.getItem("selectedHotelId") || "default";
}

function nextStackActivations(): ModuleActivationsResponse {
  return {
    hotelId: selectedHotelId(),
    activeModules: [],
    activations: [],
  };
}

export const moduleActivationClient: FeatureActivationClient = {
  list: () => {
    if (isNextApiTarget(PMS_BASE_URL)) {
      return Promise.resolve(nextStackActivations());
    }
    return retryWithoutStaleHotelContext(() =>
      pmsClient.get<ModuleActivationsResponse>("/admin/module-activations"),
    );
  },
  update: (moduleId: string, isActive: boolean) => {
    if (isNextApiTarget(PMS_BASE_URL)) {
      return Promise.reject(
        new Error(
          `Module activation update for ${moduleId} is not supported when PMS URL targets next-api.`,
        ),
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
