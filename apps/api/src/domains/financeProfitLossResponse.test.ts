import { describe, expect, it } from "vitest";

import {
  composeFinanceProfitLossResponse,
  type FinanceProfitLossResponseInput,
} from "./financeProfitLossResponse.js";

const custom = "custom:12140000-0000-4000-8000-0000000000aa" as const;

describe("Financials profit and loss response", () => {
  it("reconciles monthly and YTD revenue, expenses, profit, and prior-year comparisons", () => {
    const result = composeFinanceProfitLossResponse({
      ...input(),
      roomRevenue: [
        fact("current", "2026-01-10", "100"),
        fact("current", "2026-02-10", "50"),
        fact("comparison", "2025-01-10", "80"),
      ],
      upsellRevenue: [fact("current", "2026-01-11", "20"), fact("comparison", "2025-01-11", "10")],
      expenses: [
        expense("current", "2026-01-12", "staff", "30"),
        expense("current", "2026-01-13", custom, "5"),
        expense("current", "2026-02-13", "maintenance_supplies", "10"),
        expense("comparison", "2025-01-12", "staff", "20"),
      ],
    });

    expect(result.months).toHaveLength(3);
    expect(result.months[0]).toMatchObject({
      month: "2026-01",
      roomRevenue: money("100.0000"),
      upsellRevenue: money("20.0000"),
      revenue: money("120.0000"),
      expenses: money("35.0000"),
      netProfit: money("85.0000"),
    });
    expect(result.months[1]).toMatchObject({
      revenue: money("50.0000"),
      expenses: money("10.0000"),
      netProfit: money("40.0000"),
    });
    expect(result.summary).toEqual({
      revenueYtd: metric("170.0000", "80.0000", "0.8889"),
      expensesYtd: metric("45.0000", "25.0000", "1.2500"),
      netProfitYtd: metric("125.0000", "55.0000", "0.7857"),
    });
  });

  it("returns every default and custom category in every zero-valued month", () => {
    const result = composeFinanceProfitLossResponse(input());
    expect(result.months).toHaveLength(3);
    expect(Object.keys(result.months[0]!.expenseCategories).sort()).toEqual([
      custom,
      "maintenance_supplies",
      "marketing_platform",
      "ota_commission",
      "staff",
      "utilities",
    ]);
    expect(result.months[2]).toMatchObject({
      roomRevenue: money("0.0000"),
      upsellRevenue: money("0.0000"),
      expenses: money("0.0000"),
      netProfit: money("0.0000"),
    });
    expect(result.summary.netProfitYtd.percentChange).toBeNull();
  });

  it("keeps custom categories separate and applies corrections as signed facts", () => {
    const second = "custom:12140000-0000-4000-8000-0000000000bb" as const;
    const result = composeFinanceProfitLossResponse({
      ...input(),
      categoryRows: [custom, second],
      expenses: [
        expense("current", "2026-01-01", custom, "10"),
        expense("current", "2026-01-02", custom, "-3"),
        expense("current", "2026-01-03", second, "4"),
      ],
    });
    expect(result.months[0]!.expenseCategories[custom]).toEqual(money("7.0000"));
    expect(result.months[0]!.expenseCategories[second]).toEqual(money("4.0000"));
    expect(result.months[0]!.expenses).toEqual(money("11.0000"));
  });

  it.each([
    fact("comparison", "2020-01-01", "1"),
    fact("comparison", "2025-03-18", "1"),
    fact("current", "2026-01-invalid", "1"),
  ])("rejects revenue facts outside their exact reporting period", (invalid) => {
    expect(() => composeFinanceProfitLossResponse({ ...input(), roomRevenue: [invalid] })).toThrow(
      TypeError,
    );
  });

  it.each(["current", "comparison"] as const)(
    "rejects an undeclared %s custom expense category",
    (period) => {
      expect(() =>
        composeFinanceProfitLossResponse({
          ...input(),
          expenses: [
            expense(
              period,
              period === "current" ? "2026-01-01" : "2025-01-01",
              "custom:12140000-0000-4000-8000-0000000000bb",
              "1",
            ),
          ],
        }),
      ).toThrow(TypeError);
    },
  );

  it.each([
    { propertyId: "not-a-uuid" },
    { propertyId: "------------------------------------" },
    { currency: "eur" },
    { timeZone: "Unknown/Zone" },
    { generatedAt: "2026-03-17T10:00:00" },
    { generatedAt: "not-an-instant" },
  ])("rejects malformed response scope", (override) => {
    expect(() => composeFinanceProfitLossResponse({ ...input(), ...override })).toThrow(TypeError);
  });
});

function input(): FinanceProfitLossResponseInput {
  return {
    propertyId: "12140000-0000-4000-8000-000000000001",
    currency: "EUR",
    timeZone: "Europe/Berlin",
    generatedAt: "2026-03-17T10:00:00.000Z",
    asOf: "2026-03-17",
    query: { year: 2026 },
    sourceFreshness: { bookingRevenueThrough: "2026-03-16" },
    incompleteEvidence: [],
    categoryRows: [custom],
    roomRevenue: [],
    upsellRevenue: [],
    expenses: [],
  };
}
const fact = (period: "current" | "comparison", recognizedOn: string, amount: string) => ({
  period,
  recognizedOn,
  amount,
});
const expense = (
  period: "current" | "comparison",
  incurredOn: string,
  categoryRow: FinanceProfitLossResponseInput["categoryRows"][number],
  amount: string,
) => ({ period, incurredOn, categoryRow, amount });
const money = (amount: string) => ({ amount, currency: "EUR" });
const metric = (value: string, absoluteChange: string, percentChange: string) => ({
  value: money(value),
  absoluteChange: money(absoluteChange),
  percentChange,
});
