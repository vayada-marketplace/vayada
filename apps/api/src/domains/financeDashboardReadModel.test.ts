import { describe, expect, it, vi } from "vitest";

import { financeDashboardPeriods } from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";

import {
  createFinanceDashboardReadModel,
  FinanceDashboardEvidenceError,
} from "./financeDashboardReadModel.js";

const PROPERTY = "11280000-0000-4000-8000-000000000001";
const OTHER = "11280000-0000-4000-8000-000000000002";

describe("Finance Dashboard read model", () => {
  it("loads typed evidence and reads the exact union of Dashboard revenue periods", async () => {
    const h = harness();
    const result = await h.read.dashboard(PROPERTY.toUpperCase(), { asOf: "2026-08-03" });
    const periods = financeDashboardPeriods("2026-08-03");
    const revenueScope = {
      propertyId: PROPERTY,
      currency: "EUR",
      periods: {
        current: { from: "2026-07-21", to: "2026-08-03" },
        comparison: { from: "2026-07-01", to: "2026-07-03" },
      },
    };
    expect(h.pricing.getPropertyPricingCurrency).toHaveBeenCalledWith(PROPERTY);
    expect(h.context.getPropertyContext).toHaveBeenCalledWith(PROPERTY);
    expect(h.facts.readConsistent).toHaveBeenCalledWith({
      revenue: revenueScope,
      expenses: {
        propertyId: PROPERTY,
        currency: "EUR",
        asOf: "2026-08-03",
        monthToDate: periods.monthToDate,
        daily: periods.daily,
      },
    });
    expect(result).toMatchObject({
      propertyId: PROPERTY,
      currency: "EUR",
      timeZone: "Asia/Kolkata",
      generatedAt: "2026-08-03T20:30:00.000Z",
      sourceFreshness: {
        pmsPricing: "2026-08-03T12:00:00Z",
        pmsPricingRevision: "3",
        hotelCatalog: "2026-08-03T13:00:00Z",
        hotelCatalogRevision: "profile:7",
      },
    });
  });

  it("defaults as-of to the property-local date", async () => {
    const h = harness();
    await h.read.dashboard(PROPERTY, {});
    expect(h.facts.readConsistent).toHaveBeenCalledWith(
      expect.objectContaining({
        revenue: {
          propertyId: PROPERTY,
          currency: "EUR",
          periods: {
            current: { from: "2026-07-22", to: "2026-08-04" },
            comparison: { from: "2026-07-01", to: "2026-07-04" },
          },
        },
        expenses: expect.objectContaining({ asOf: "2026-08-04" }),
      }),
    );
  });

  it("returns not found without reading Finance facts when property context is absent", async () => {
    const h = harness();
    h.context.getPropertyContext.mockResolvedValue(null);
    await expect(h.read.dashboard(PROPERTY, {})).resolves.toBeNull();
    expect(h.facts.readConsistent).not.toHaveBeenCalled();
  });

  it("rejects malformed scope and fails closed for inconsistent owner evidence", async () => {
    const malformed = harness();
    await expect(
      malformed.read.dashboard(PROPERTY, { asOf: "bad" } as never),
    ).rejects.toBeInstanceOf(TypeError);
    expect(malformed.pricing.getPropertyPricingCurrency).not.toHaveBeenCalled();

    const wrongOwner = harness();
    wrongOwner.pricing.getPropertyPricingCurrency.mockResolvedValue({
      ...pricing(),
      propertyId: OTHER,
    });
    await expect(wrongOwner.read.dashboard(PROPERTY, {})).rejects.toBeInstanceOf(
      FinanceDashboardEvidenceError,
    );
    expect(wrongOwner.facts.readConsistent).not.toHaveBeenCalled();
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
  const facts = {
    readConsistent: vi.fn(async (scope: { expenses: { daily: { from: string; to: string } } }) => ({
      rooms: {
        rows: [],
        eligibleBookings: { current: 0, comparison: 0 },
        sourceFreshness: { bookingRevenueThrough: null, financeOtaCommissionAt: null },
        incompleteEvidence: [],
      },
      addOns: {
        rows: [],
        fulfilledBookings: { current: 0, comparison: 0 },
        sourceFreshness: { bookingAddonRevenueThrough: null, bookingAddonRevenueAt: null },
        incompleteEvidence: [],
      },
      expenses: {
        totals: { current: "0.0000", comparison: "0.0000" },
        daily: days(scope.expenses.daily.from, scope.expenses.daily.to).map((date) => ({
          date,
          amount: "0.0000",
        })),
        upcoming: [],
        sourceFreshness: { financeExpensesAt: null, financeRecurringExpensesAt: null },
        incompleteEvidence: [],
      },
    })),
  };
  return {
    pricing: pricingPort,
    context: propertyContext,
    facts,
    read: createFinanceDashboardReadModel({
      pricing: pricingPort,
      propertyContext,
      facts,
      now: () => new Date("2026-08-03T20:30:00Z"),
    }),
  };
}

const pricing = () => ({
  contractVersion: PMS_PRICING_CONTRACT_VERSION,
  propertyId: PROPERTY,
  currency: "EUR" as never,
  pricingCurrencyRevision: 3,
  createdAt: "2026-08-01T12:00:00Z",
  updatedAt: "2026-08-03T12:00:00Z",
});
const context = () => ({
  source: {
    ownerDomain: "hotel_catalog" as const,
    entityType: "property_profile" as const,
    entityId: PROPERTY,
    revision: "profile:7",
  },
  timeZone: "Asia/Kolkata",
  updatedAt: "2026-08-03T13:00:00Z",
});
function days(from: string, to: string): string[] {
  const values = [];
  for (
    let day = Date.parse(`${from}T00:00:00Z`);
    day <= Date.parse(`${to}T00:00:00Z`);
    day += 86_400_000
  )
    values.push(new Date(day).toISOString().slice(0, 10));
  return values;
}
