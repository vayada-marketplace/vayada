import {
  parseFinancePaymentReadinessSnapshot,
  parseReplaceFinancePaymentMethodsResult,
  type FinancePaymentReadinessSnapshot,
} from "@vayada/domain-finance";
import { targetApiClient } from "./targetClient";
type Method = "pay_at_property" | "card";
type Request = {
  expectedPaymentMethodsRevision: number;
  expectedPricingCurrencyRevision: number;
  selectedMethods: Method[];
};
/** Whether guests can pay the hotel by bank transfer or PayPal yet (VAY-2139). */
export type ManualPaymentMethods = {
  acceptanceEnabled: boolean;
  readyMethods: ("bank_transfer" | "paypal")[];
};
type Http = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  put<T>(path: string, value?: unknown, options?: RequestInit): Promise<T>;
};
export function createFinancePaymentReadinessClient(http: Http) {
  return {
    async providerAccountId(propertyId: string, options?: RequestInit): Promise<string | null> {
      const response = await http.get<{
        propertyId?: string;
        contractVersion?: string;
        paymentSettings?: { providerAccount?: { providerAccountId?: unknown; provider?: unknown } };
      }>(`${path(propertyId)}/payment-settings`, options);
      const account = response?.paymentSettings?.providerAccount;
      if (
        response.propertyId !== propertyId ||
        response.contractVersion !== "finance-route-contracts.v1" ||
        !account ||
        !(
          account.providerAccountId === null ||
          (typeof account.providerAccountId === "string" &&
            /^[0-9a-f-]{36}$/i.test(account.providerAccountId) &&
            account.provider === "stripe")
        )
      )
        throw invalid();
      return account.providerAccountId;
    },
    async load(
      propertyId: string,
      options?: RequestInit,
    ): Promise<FinancePaymentReadinessSnapshot> {
      const value = parseFinancePaymentReadinessSnapshot(
        await http.get<unknown>(`${path(propertyId)}/payment-readiness`, options),
      );
      if (!value || value.propertyId !== propertyId) throw invalid();
      return value;
    },
    async manualPaymentMethods(
      propertyId: string,
      options?: RequestInit,
    ): Promise<ManualPaymentMethods> {
      const value = await http.get<Partial<ManualPaymentMethods> | null>(
        `${path(propertyId)}/manual-payment-methods`,
        options,
      );
      const methods = value?.readyMethods;
      if (
        typeof value?.acceptanceEnabled !== "boolean" ||
        !Array.isArray(methods) ||
        methods.some((method) => method !== "bank_transfer" && method !== "paypal") ||
        new Set(methods).size !== methods.length ||
        (!value.acceptanceEnabled && methods.length > 0)
      )
        throw invalid();
      return { acceptanceEnabled: value.acceptanceEnabled, readyMethods: [...methods] };
    },
    async save(
      propertyId: string,
      request: Request,
      /** Only for a hotel paid by bank transfer or PayPal, which keep the payments on. */
      options: { allowNoMethods?: boolean } = {},
    ): Promise<FinancePaymentReadinessSnapshot> {
      if (
        !Number.isSafeInteger(request.expectedPaymentMethodsRevision) ||
        request.expectedPaymentMethodsRevision < 0 ||
        !Number.isSafeInteger(request.expectedPricingCurrencyRevision) ||
        request.expectedPricingCurrencyRevision < 1 ||
        (!request.selectedMethods.length && !options.allowNoMethods) ||
        request.selectedMethods.some((method) => !["pay_at_property", "card"].includes(method)) ||
        new Set(request.selectedMethods).size !== request.selectedMethods.length
      )
        throw invalid();
      const selectedMethods = (["pay_at_property", "card"] as const).filter((method) =>
        request.selectedMethods.includes(method),
      );
      const body = { ...request, selectedMethods };
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({ propertyId, body })),
      );
      const key = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const response = await http.put<unknown>(`${path(propertyId)}/payment-methods`, body, {
        headers: { "Idempotency-Key": `payment-methods:${propertyId}:${key.slice(0, 40)}` },
      });
      const result = parseReplaceFinancePaymentMethodsResult({ ok: true, response });
      if (!result?.ok) throw invalid();
      const value = result.response.paymentReadiness;
      if (
        value.propertyId !== propertyId ||
        value.paymentMethodsRevision !== request.expectedPaymentMethodsRevision + 1 ||
        value.pricingCurrency.committed?.pricingCurrencyRevision !==
          request.expectedPricingCurrencyRevision ||
        !value.pricingCurrency.matchesCurrent ||
        value.pricingCurrency.current?.pricingCurrencyRevision !==
          request.expectedPricingCurrencyRevision ||
        value.methods.some(
          (method) => method.selected !== selectedMethods.includes(method.method as Method),
        )
      )
        throw invalid();
      return value;
    },
  };
}
export const financePaymentReadinessClient = createFinancePaymentReadinessClient(targetApiClient);
function path(propertyId: string) {
  return `/api/finance/properties/${encodeURIComponent(propertyId)}`;
}
function invalid() {
  return new Error(
    "Payment readiness is invalid or belongs to another hotel. Refresh and try again.",
  );
}
