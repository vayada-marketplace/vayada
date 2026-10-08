import {
  PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
  PMS_PRICING_CONTRACT_VERSION,
  PMS_RECURRING_PRICING_CONTRACT_VERSION,
  PMS_ROOM_FACTS_CONTRACT_VERSION,
} from "@vayada/domain-pms";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiErrorResponse } from "./client";
import {
  createOnboardingPricingClient,
  PricingOwnerError,
  type OnboardingPricingHttpClient,
} from "./onboardingPricingClient";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomTypeId = "33333333-3333-4333-8333-333333333333";
const now = "2026-10-08T12:00:00.000Z";

const calls = {
  get: vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>(),
  put: vi.fn<(endpoint: string, data?: unknown, options?: RequestInit) => Promise<unknown>>(),
  post: vi.fn<(endpoint: string, data?: unknown, options?: RequestInit) => Promise<unknown>>(),
};
const http = calls as unknown as OnboardingPricingHttpClient;
const client = createOnboardingPricingClient(http);

describe("onboardingPricingClient", () => {
  beforeEach(() => vi.resetAllMocks());

  it("loads a first visit from the setup room facts with the sorted currency list", async () => {
    owners({ currency: null });
    const loaded = await client.load(organizationId, propertyId);
    expect(loaded).toMatchObject({
      currencies: ["CHF", "EUR", "USD"],
      pricing: null,
      recurringPricing: null,
      confirmationRevision: 0,
      confirmationCurrent: false,
    });
    // Only active room types; the operational room list is never read.
    expect(loaded.rooms.map(({ roomTypeId: id }) => id)).toEqual([roomTypeId]);
    expect(calls.get).toHaveBeenCalledWith(
      `/api/pms/setup/properties/${propertyId}/room-types`,
      undefined,
    );
  });

  it("saves the first currency once with a stable key and reloads", async () => {
    owners({ currency: null });
    const first = await client.load(organizationId, propertyId);
    calls.put.mockResolvedValueOnce({
      contractVersion: PMS_PRICING_CONTRACT_VERSION,
      outcome: "created",
      pricingCurrency: pricingSource().pricingCurrency,
      acceptedAt: now,
    });
    owners({ currency: "EUR" });
    const saved = await client.saveCurrency(organizationId, propertyId, "EUR", first);
    expect(saved.pricing?.pricingCurrency.currency).toBe("EUR");
    expect(calls.put).toHaveBeenCalledWith(
      `/api/pms/properties/${propertyId}/pricing-source/currency`,
      { expectedPricingCurrencyRevision: 0, currency: "EUR" },
      { headers: { "Idempotency-Key": expect.stringMatching(/^pricing-currency:/) } },
    );
    await expect(client.saveCurrency(organizationId, propertyId, "XXX", first)).rejects.toThrow(
      "not supported",
    );
  });

  it("confirms final prices against the exact current pricing source", async () => {
    let confirmed: string | null = null;
    owners({ currency: "EUR", confirmation: () => confirmed });
    calls.put.mockImplementation(async (endpoint, data) => {
      expect(endpoint).toBe(`/api/pms/properties/${propertyId}/mandatory-charge-confirmation`);
      const body = data as Record<string, unknown>;
      expect(body).toMatchObject({
        expectedConfirmationRevision: 0,
        expectedPricingSourceRevisions: { pricingCurrencyRevision: 2 },
      });
      confirmed = body.claimedPricingSourceFingerprint as string;
      return {
        contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
        outcome: "confirmed",
        evidence: evidence(confirmed),
        acceptedAt: now,
      };
    });
    await expect(client.confirmFinalPrices(organizationId, propertyId)).resolves.toMatchObject({
      confirmationCurrent: true,
      confirmationRevision: 1,
    });
    // A current confirmation is not written again.
    await client.confirmFinalPrices(organizationId, propertyId);
    expect(calls.put).toHaveBeenCalledOnce();
  });

  it("maps owner command errors and refuses to confirm without a currency", async () => {
    owners({ currency: null });
    await expect(client.confirmFinalPrices(organizationId, propertyId)).rejects.toMatchObject({
      code: "pricing_source_not_configured",
      requiresRefresh: true,
    });
    const first = await client.load(organizationId, propertyId);
    calls.put.mockRejectedValue(
      new ApiErrorResponse(409, { code: "pricing_currency_revision_conflict" }),
    );
    const error = await client
      .saveCurrency(organizationId, propertyId, "EUR", first)
      .catch((e) => e);
    expect(error).toBeInstanceOf(PricingOwnerError);
    expect(error).toMatchObject({ requiresRefresh: true });
  });
});

function owners({
  currency,
  confirmation = () => null,
}: {
  currency: string | null;
  confirmation?: () => string | null;
}) {
  calls.get.mockImplementation(async (endpoint) => {
    if (endpoint.endsWith("/currency-capabilities"))
      return {
        contractVersion: "pms-pricing-currency-capabilities.v1",
        supportedCurrencies: ["CHF", "EUR", "USD"].map((code) => ({ code, scale: 2 })),
      };
    if (endpoint.endsWith("/room-types")) return roomList();
    if (endpoint.endsWith("/mandatory-charge-confirmation")) {
      const fingerprint = confirmation();
      if (fingerprint)
        return {
          outcome: "available",
          organizationId,
          propertyId,
          evidence: evidence(fingerprint),
        };
      throw Object.assign(new ApiErrorResponse(404, {}), {
        data: { outcome: "missing", organizationId, propertyId },
      });
    }
    if (currency === null)
      throw new ApiErrorResponse(404, { code: "pricing_currency_not_configured" });
    if (endpoint.endsWith("/pricing-source")) return pricingSource();
    if (endpoint.endsWith("/recurring-booking-evidence"))
      return {
        contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
        propertyId,
        pricingCurrencyRevision: 2,
        optionalPricingAggregateRevision: 0,
        currency: "EUR",
        sources: [],
        capturedAt: now,
      };
    throw new Error(`Unexpected GET ${endpoint}`);
  });
}

function pricingSource() {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    pricingCurrency: {
      contractVersion: PMS_PRICING_CONTRACT_VERSION,
      propertyId,
      currency: "EUR",
      pricingCurrencyRevision: 2,
      createdAt: now,
      updatedAt: now,
    },
    flexibleRatePlans: [],
    capturedAt: now,
  };
}

function roomList() {
  const room = (id: string, name: string, lifecycle: string) => ({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId: id,
    roomFactsRevision: 3,
    lifecycle,
    facts: {
      name,
      description: "A quiet suite.",
      category: "suite",
      occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 1 },
      beds: [{ type: "king", quantity: 1 }],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: { value: 30, unit: "sqm" },
    },
    createdAt: now,
    updatedAt: now,
  });
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    items: [
      room(roomTypeId, "Garden Suite", "active"),
      room("44444444-4444-4444-8444-444444444444", "Old Annex", "inactive"),
    ],
  };
}

function evidence(fingerprint: string) {
  return {
    organizationId,
    propertyId,
    pricingSourceFingerprint: fingerprint,
    confirmationRevision: 1,
    confirmedAt: now,
  };
}
