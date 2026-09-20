import { describe, expect, it, vi } from "vitest";

import {
  createFinanceProfitLossReadModel,
  FinanceProfitLossEvidenceError,
} from "./financeProfitLossReadModel.js";

const propertyId = "11310000-0000-4000-8000-000000000001";
const custom = "custom:11310000-0000-4000-8000-000000000002" as const;

describe("Finance profit and loss read model", () => {
  it("loads property-local YTD facts and composes the response", async () => {
    const config = ports();
    const result = await createFinanceProfitLossReadModel(config).profitLoss(
      propertyId.toUpperCase(),
      { year: 2026 },
    );
    expect(config.facts.read).toHaveBeenCalledWith({
      propertyId,
      currency: "EUR",
      periods: {
        current: { from: "2026-01-01", to: "2026-03-18" },
        comparison: { from: "2025-01-01", to: "2025-03-18" },
      },
    });
    expect(result).toMatchObject({
      categoryRows: [custom],
      response: {
        propertyId,
        currency: "EUR",
        timeZone: "Europe/Berlin",
        summary: {
          revenueYtd: { value: { amount: "120.0000" } },
          expensesYtd: { value: { amount: "30.0000" } },
          netProfitYtd: { value: { amount: "90.0000" } },
        },
      },
    });
    expect(result!.response.months).toHaveLength(3);
    expect(result!.response.sourceFreshness).toMatchObject({
      pmsPricingRevision: "2",
      hotelCatalogRevision: "profile:3",
      financeExpensesAt: "2026-03-16T10:00:00.000Z",
    });
  });

  it("returns not found before facts when the property context is absent", async () => {
    const config = ports();
    config.propertyContext.getPropertyContext = vi.fn(async () => null) as never;
    await expect(
      createFinanceProfitLossReadModel(config).profitLoss(propertyId, { year: 2026 }),
    ).resolves.toBeNull();
    expect(config.facts.read).not.toHaveBeenCalled();
  });

  it.each([
    [
      "currency",
      (value: ReturnType<typeof ports>) => {
        value.pricing.getPropertyPricingCurrency = vi.fn(async () => ({
          ...(await pricing()),
          currency: "eur",
        })) as never;
      },
    ],
    [
      "timezone",
      (value: ReturnType<typeof ports>) => {
        value.propertyContext.getPropertyContext = vi.fn(async () => ({
          ...(await context()),
          timeZone: "Unknown/Zone",
        })) as never;
      },
    ],
    [
      "property",
      (value: ReturnType<typeof ports>) => {
        value.pricing.getPropertyPricingCurrency = vi.fn(async () => ({
          ...(await pricing()),
          propertyId: "11310000-0000-4000-8000-000000000099",
        })) as never;
      },
    ],
  ])("fails closed when %s evidence is invalid", async (_, mutate) => {
    const config = ports();
    mutate(config);
    await expect(
      createFinanceProfitLossReadModel(config).profitLoss(propertyId, { year: 2026 }),
    ).rejects.toBeInstanceOf(FinanceProfitLossEvidenceError);
    expect(config.facts.read).not.toHaveBeenCalled();
  });

  it("rejects future years and malformed properties before facts", async () => {
    const model = createFinanceProfitLossReadModel(ports());
    await expect(model.profitLoss(propertyId, { year: 2027 })).rejects.toBeInstanceOf(TypeError);
    await expect(model.profitLoss("bad", { year: 2026 })).rejects.toBeInstanceOf(TypeError);
  });
});

function ports(): Parameters<typeof createFinanceProfitLossReadModel>[0] {
  return {
    pricing: { getPropertyPricingCurrency: vi.fn(pricing) },
    propertyContext: { getPropertyContext: vi.fn(context) },
    facts: {
      read: vi.fn(async () => ({
        categoryRows: [custom],
        roomRevenue: [{ period: "current" as const, recognizedOn: "2026-01-10", amount: "100" }],
        upsellRevenue: [{ period: "current" as const, recognizedOn: "2026-01-11", amount: "20" }],
        expenses: [
          {
            period: "current" as const,
            incurredOn: "2026-01-12",
            categoryRow: custom,
            amount: "30",
          },
        ],
        sourceFreshness: { financeExpensesAt: "2026-03-16T10:00:00.000Z" },
        incompleteEvidence: [],
      })),
    },
    now: () => new Date("2026-03-17T23:30:00.000Z"),
  } as unknown as Parameters<typeof createFinanceProfitLossReadModel>[0];
}
async function pricing() {
  return {
    contractVersion: "pms-pricing.v1" as const,
    propertyId,
    currency: "EUR",
    pricingCurrencyRevision: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-03-16T09:00:00.000Z",
  };
}
async function context() {
  return {
    source: {
      ownerDomain: "hotel_catalog" as const,
      entityType: "property_profile" as const,
      entityId: propertyId,
      revision: "profile:3",
    },
    timeZone: "Europe/Berlin",
    updatedAt: "2026-03-16T08:00:00.000Z",
  };
}
