import { describe, expect, it, vi } from "vitest";

import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";

import {
  createFinanceRevenueReadModel,
  FinanceRevenueEvidenceError,
} from "./financeRevenueReadModel.js";

const PROPERTY = "11280000-0000-4000-8000-000000000001";
const OTHER = "11280000-0000-4000-8000-000000000002";
const ROOM = "11280000-0000-4000-8000-000000000010";
const QUERY = { from: "2026-08-01", to: "2026-08-03" };

describe("Finance revenue read model", () => {
  it("loads typed scope evidence and reads both fact ports for equal comparison periods", async () => {
    const h = harness();
    const result = await h.read.revenue(PROPERTY.toUpperCase(), QUERY);
    const scope = {
      propertyId: PROPERTY,
      currency: "EUR",
      periods: {
        current: QUERY,
        comparison: { from: "2026-07-29", to: "2026-07-31" },
      },
    };
    expect(h.pricing.getPropertyPricingCurrency).toHaveBeenCalledWith(PROPERTY);
    expect(h.context.getPropertyContext).toHaveBeenCalledWith(PROPERTY);
    expect(h.rooms.read).toHaveBeenCalledWith(scope);
    expect(h.addOns.read).toHaveBeenCalledWith(scope);
    expect(result).toMatchObject({
      propertyId: PROPERTY,
      currency: "EUR",
      timeZone: "Asia/Kolkata",
      generatedAt: "2026-08-04T14:00:00.000Z",
      sourceFreshness: {
        pmsPricing: "2026-08-04T12:00:00Z",
        pmsPricingRevision: "3",
        hotelCatalog: "2026-08-04T13:00:00Z",
        hotelCatalogRevision: "profile:7",
      },
      summary: {
        grossRoom: { value: { amount: "100.0000", currency: "EUR" } },
        upsell: { value: { amount: "10.0000", currency: "EUR" } },
      },
    });
  });

  it("returns not found without reading Finance facts when property context is absent", async () => {
    const h = harness();
    h.context.getPropertyContext.mockResolvedValue(null);
    await expect(h.read.revenue(PROPERTY, QUERY)).resolves.toBeNull();
    expect(h.rooms.read).not.toHaveBeenCalled();
    expect(h.addOns.read).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing pricing",
      (h: ReturnType<typeof harness>) =>
        h.pricing.getPropertyPricingCurrency.mockResolvedValue(null),
    ],
    [
      "wrong pricing property",
      (h: ReturnType<typeof harness>) =>
        h.pricing.getPropertyPricingCurrency.mockResolvedValue({ ...pricing(), propertyId: OTHER }),
    ],
    [
      "invalid pricing currency",
      (h: ReturnType<typeof harness>) =>
        h.pricing.getPropertyPricingCurrency.mockResolvedValue({
          ...pricing(),
          currency: "eur" as never,
        }),
    ],
    [
      "wrong profile property",
      (h: ReturnType<typeof harness>) =>
        h.context.getPropertyContext.mockResolvedValue({
          ...context(),
          source: { ...context().source, entityId: OTHER },
        }),
    ],
    [
      "timezone alias",
      (h: ReturnType<typeof harness>) =>
        h.context.getPropertyContext.mockResolvedValue({
          ...context(),
          timeZone: "Europe/Belfast",
        }),
    ],
    [
      "invalid freshness",
      (h: ReturnType<typeof harness>) =>
        h.context.getPropertyContext.mockResolvedValue({ ...context(), updatedAt: "today" }),
    ],
  ])("fails closed for %s evidence", async (_name, mutate) => {
    const h = harness();
    mutate(h);
    await expect(h.read.revenue(PROPERTY, QUERY)).rejects.toBeInstanceOf(
      FinanceRevenueEvidenceError,
    );
    expect(h.rooms.read).not.toHaveBeenCalled();
  });

  it("rejects malformed scope before calling owner ports", async () => {
    const h = harness();
    await expect(h.read.revenue("bad", QUERY)).rejects.toBeInstanceOf(TypeError);
    await expect(
      h.read.revenue(PROPERTY, { from: "2026-08-03", to: "2026-08-01" }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(h.pricing.getPropertyPricingCurrency).not.toHaveBeenCalled();
  });
});

function harness() {
  const pricingPort = {
    getPropertyPricingCurrency: vi.fn(async (): Promise<ReturnType<typeof pricing> | null> =>
      pricing(),
    ),
  };
  const propertyContext = {
    getPropertyContext: vi.fn(async (): Promise<ReturnType<typeof context> | null> => context()),
  };
  const rooms = {
    read: vi.fn(async () => ({
      rows: [
        {
          period: "current" as const,
          recognizedOn: "2026-08-01",
          channel: "direct",
          directSource: "email",
          roomTypeId: ROOM,
          grossRoomAmount: "100.0000",
          otaCommissionAmount: "0.0000",
          occupiedRoomNights: 1,
          pricedOccupiedRoomNights: 1,
        },
      ],
      eligibleBookings: { current: 1, comparison: 0 },
      sourceFreshness: { bookingRevenueThrough: "2026-08-01", financeOtaCommissionAt: null },
      incompleteEvidence: [],
    })),
    close: vi.fn(),
  };
  const addOns = {
    read: vi.fn(async () => ({
      rows: [
        {
          period: "current" as const,
          recognizedOn: "2026-08-01",
          ownership: "property" as const,
          revenueAmount: "10.0000",
        },
      ],
      fulfilledBookings: { current: 1, comparison: 0 },
      sourceFreshness: {
        bookingAddonRevenueThrough: "2026-08-01",
        bookingAddonRevenueAt: "2026-08-04T11:00:00Z",
      },
      incompleteEvidence: [],
    })),
    close: vi.fn(),
  };
  return {
    pricing: pricingPort,
    context: propertyContext,
    rooms,
    addOns,
    read: createFinanceRevenueReadModel({
      pricing: pricingPort,
      propertyContext,
      rooms,
      addOns,
      now: () => new Date("2026-08-04T14:00:00Z"),
    }),
  };
}

const pricing = () => ({
  contractVersion: PMS_PRICING_CONTRACT_VERSION,
  propertyId: PROPERTY,
  currency: "EUR" as never,
  pricingCurrencyRevision: 3,
  createdAt: "2026-08-01T12:00:00Z",
  updatedAt: "2026-08-04T12:00:00Z",
});
const context = () => ({
  source: {
    ownerDomain: "hotel_catalog" as const,
    entityType: "property_profile" as const,
    entityId: PROPERTY,
    revision: "profile:7",
  },
  timeZone: "Asia/Kolkata",
  updatedAt: "2026-08-04T13:00:00Z",
});
