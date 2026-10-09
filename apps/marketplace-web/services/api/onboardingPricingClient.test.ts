import { PMS_PRICING_CONTRACT_VERSION, PMS_ROOM_FACTS_CONTRACT_VERSION } from "@vayada/domain-pms";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiErrorResponse } from "./client";
import {
  createOnboardingPricingClient,
  PricingOwnerError,
  type OnboardingPricingHttpClient,
} from "./onboardingPricingClient";

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
    const loaded = await client.load(propertyId);
    expect(loaded).toMatchObject({ currencies: ["CHF", "EUR", "USD"], pricing: null });
    // Only active room types; the operational room list is never read.
    expect(loaded.rooms.map(({ roomTypeId: id }) => id)).toEqual([roomTypeId]);
    expect(calls.get).toHaveBeenCalledWith(
      `/api/pms/setup/properties/${propertyId}/room-types`,
      undefined,
    );
  });

  it("saves the first currency once with a stable key and reloads", async () => {
    owners({ currency: null });
    const first = await client.load(propertyId);
    calls.put.mockResolvedValueOnce({
      contractVersion: PMS_PRICING_CONTRACT_VERSION,
      outcome: "created",
      pricingCurrency: pricingSource().pricingCurrency,
      acceptedAt: now,
    });
    owners({ currency: "EUR" });
    const saved = await client.saveCurrency(propertyId, "EUR", first);
    expect(saved.pricing?.pricingCurrency.currency).toBe("EUR");
    expect(calls.put).toHaveBeenCalledWith(
      `/api/pms/properties/${propertyId}/pricing-source/currency`,
      { expectedPricingCurrencyRevision: 0, currency: "EUR" },
      { headers: { "Idempotency-Key": expect.stringMatching(/^pricing-currency:/) } },
    );
    await expect(client.saveCurrency(propertyId, "XXX", first)).rejects.toThrow("not supported");
  });

  it("maps owner command errors", async () => {
    owners({ currency: null });
    const first = await client.load(propertyId);
    calls.put.mockRejectedValue(
      new ApiErrorResponse(409, { code: "pricing_currency_revision_conflict", currentRevision: 1 }),
    );
    const error = await client.saveCurrency(propertyId, "EUR", first).catch((e) => e);
    expect(error).toBeInstanceOf(PricingOwnerError);
    expect(error).toMatchObject({ requiresRefresh: true });
    // An Owner-only gate refusal is not a command error and keeps its status and body.
    const forbidden = new ApiErrorResponse(403, { code: "forbidden" });
    calls.put.mockRejectedValue(forbidden);
    await expect(client.saveCurrency(propertyId, "EUR", first)).rejects.toBe(forbidden);
  });
});

function owners({ currency }: { currency: string | null }) {
  calls.get.mockImplementation(async (endpoint) => {
    if (endpoint.endsWith("/currency-capabilities"))
      return {
        contractVersion: "pms-pricing-currency-capabilities.v1",
        supportedCurrencies: ["CHF", "EUR", "USD"].map((code) => ({ code, scale: 2 })),
      };
    if (endpoint.endsWith("/room-types")) return roomList();
    if (currency === null)
      throw new ApiErrorResponse(404, { code: "pricing_currency_not_configured" });
    if (endpoint.endsWith("/pricing-source")) return pricingSource();
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
