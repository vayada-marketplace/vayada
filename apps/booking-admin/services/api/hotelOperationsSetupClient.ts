import { ApiErrorResponse } from "./client";
import { targetApiClient } from "./targetClient";

export type PropertyLaunchSettings = {
  defaultCurrency: string;
  supportedCurrencies: string[];
  defaultLanguage: string;
  supportedLanguages: string[];
  instagram: string;
  facebook: string;
  tiktok: string;
  youtube: string;
};

export type FinancePlanStatus = {
  /** Null until the hotel chooses a plan (VAY-2171). */
  plan: "commission" | "fixed" | null;
  status:
    | "not_selected"
    | "commission"
    | "checkout_pending"
    | "active"
    | "past_due"
    | "cancel_at_period_end";
  /** The hotel's pricing currency; the Fixed Fee is billed in it where available. */
  currency: string;
  activeRoomCount: number;
  amountMinor: number;
  fixedPlanAvailable: boolean;
  checkoutPending: boolean;
  updatedAt: string;
};

type FinancePlanStatusResponse = { planStatus: FinancePlanStatus };

type StripeProviderAccountResponse = {
  providerAccountId: string;
  onboardingUrl: string;
  status: string;
  onboardingStatus: string;
};

type StripeProviderAccountReconciliationResponse = {
  propertyId: string;
  providerAccount: {
    ready: boolean;
  };
};

export const hotelOperationsSetupApi = {
  getPropertyLaunchSettings: async (
    propertyId: string,
    signal?: AbortSignal,
  ): Promise<PropertyLaunchSettings> => {
    const response = await targetApiClient.get<PropertyLaunchSettings>(
      `/api/hotel-setup/properties/${encoded(propertyId)}/launch-settings`,
      signal ? { signal } : undefined,
    );
    return {
      defaultCurrency: stringValue(response.defaultCurrency, "USD"),
      supportedCurrencies: stringArray(response.supportedCurrencies),
      defaultLanguage: stringValue(response.defaultLanguage, "en"),
      supportedLanguages: stringArray(response.supportedLanguages),
      instagram: stringValue(response.instagram),
      facebook: stringValue(response.facebook),
      tiktok: stringValue(response.tiktok),
      youtube: stringValue(response.youtube),
    };
  },

  updatePropertyLaunchSettings: async (
    propertyId: string,
    settings: PropertyLaunchSettings,
  ): Promise<void> => {
    await targetApiClient.put(
      `/api/hotel-setup/properties/${encoded(propertyId)}/launch-settings`,
      settings,
    );
  },

  getPlanStatus: async (propertyId: string, signal?: AbortSignal): Promise<FinancePlanStatus> => {
    const response = await targetApiClient.get<FinancePlanStatusResponse>(
      `/api/finance/properties/${encoded(propertyId)}/plan-status`,
      signal ? { signal } : undefined,
    );
    return response.planStatus;
  },

  selectCommissionPlan: async (
    propertyId: string,
    intentRevision = "initial",
  ): Promise<FinancePlanStatus> => {
    const commandId = stableSetupCommandId("finance-plan-commission", propertyId, {
      plan: "commission",
      intentRevision,
    });
    const response = await targetApiClient.post<FinancePlanStatusResponse>(
      `/api/finance/properties/${encoded(propertyId)}/select-commission`,
      { commandId, idempotencyKey: commandId },
    );
    return response.planStatus;
  },

  startFixedPlanCheckout: async (
    propertyId: string,
    intentRevision = "initial",
  ): Promise<{ checkoutUrl: string; amountMinor: number; activeRoomCount: number }> => {
    const commandId = stableSetupCommandId("finance-plan-fixed", propertyId, {
      plan: "fixed",
      intentRevision,
    });
    const response = await targetApiClient.post<{
      checkout: { checkoutUrl: string; amountMinor: number; activeRoomCount: number };
    }>(`/api/finance/properties/${encoded(propertyId)}/fixed-plan/checkout`, {
      commandId,
      idempotencyKey: commandId,
    });
    return response.checkout;
  },

  startStripeOnboarding: async (
    propertyId: string,
    input: {
      email: string;
      providerAccountId?: string | null;
      linkAttemptId?: string;
    },
  ): Promise<StripeProviderAccountResponse> => {
    const endpoint = input.providerAccountId
      ? `/api/finance/properties/${encoded(propertyId)}/provider-accounts/${encoded(
          input.providerAccountId,
        )}/onboarding-link`
      : `/api/finance/properties/${encoded(propertyId)}/provider-accounts/stripe`;
    const commandId = stableSetupCommandId(
      input.providerAccountId ? "finance-stripe-onboarding" : "finance-stripe-account",
      propertyId,
      input.providerAccountId
        ? {
            providerAccountId: input.providerAccountId,
            linkAttemptId: input.linkAttemptId ?? "initial",
          }
        : { email: input.email.trim().toLowerCase() },
    );
    return targetApiClient.post<StripeProviderAccountResponse>(
      endpoint,
      input.providerAccountId
        // Stripe returns the owner to this app's /setup (API surface added in VAY-2262 #3385).
        ? { commandId, idempotencyKey: commandId, returnSurface: "booking_admin_setup" }
        : {
            commandId,
            idempotencyKey: commandId,
            // The API takes the account's country from the hotel's address (VAY-2424).
            email: input.email.trim().toLowerCase(),
            returnSurface: "booking_admin_setup",
          },
    );
  },

  reconcileStripeProviderAccount: async (
    propertyId: string,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<StripeProviderAccountReconciliationResponse> =>
    targetApiClient.post<StripeProviderAccountReconciliationResponse>(
      `/api/finance/properties/${encoded(propertyId)}/provider-accounts/stripe/reconcile`,
      { commandId, idempotencyKey: commandId },
      signal ? { signal } : undefined,
    ),
};

export function stableSetupCommandId(prefix: string, propertyId: string, payload: unknown): string {
  const source = `${propertyId}:${stableJson(payload)}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}:${propertyId}:${(hash >>> 0).toString(16).padStart(8, "0")}:v1`;
}

export function hotelOperationsErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiErrorResponse) {
    if (error.data.code === "invalid_body" || error.data.category === "validation") return fallback;
    const detail = error.data.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (typeof error.data.message === "string" && error.data.message.trim()) {
      return error.data.message;
    }
  }
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function encoded(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Property id is required.");
  return encodeURIComponent(normalized);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
