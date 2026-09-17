import { describe, expect, it } from "vitest";

import type { FinanceProfitLossResponse, FinanceReportingEnvelope } from "./financialReporting.js";

import {
  assertFinanceProfitLossResponse,
  FINANCE_DASHBOARD_WINDOW_DAYS,
  divideFinanceReportingDecimal,
  financeDashboardPeriods,
  financeProfitLossExpenseCategoryRow,
  financeProfitLossPeriods,
  financeReportingCountMetric,
  financeReportingMoneyMetric,
  financeReportingRatioMetric,
  financeRevenuePeriod,
  normalizeFinanceReportingDecimal,
  parseFinanceDashboardQuery,
  parseFinanceProfitLossQuery,
  parseFinanceRevenueQuery,
} from "./financialReporting.js";

describe("Financials reporting contracts", () => {
  it("preserves currency-only incomplete evidence", () => {
    const gap = {
      code: "currency_mismatch",
      count: 1,
      currency: "USD",
    } satisfies FinanceReportingEnvelope["incompleteEvidence"][number];
    // @ts-expect-error One evidence item cannot declare two authoritative currencies.
    const conflict: FinanceReportingEnvelope["incompleteEvidence"][number] = {
      ...gap,
      amount: { amount: "1.0000", currency: "EUR" },
    };
    expect(gap.currency).toBe("USD");
    expect(conflict).toBeDefined();
  });

  it("keeps the accepted dashboard window", () => {
    expect(FINANCE_DASHBOARD_WINDOW_DAYS).toBe(14);
  });

  it("parses an empty dashboard query or one property-local as-of date", () => {
    expect(parseFinanceDashboardQuery({})).toEqual({});
    expect(parseFinanceDashboardQuery({ asOf: "2028-02-29" })).toEqual({ asOf: "2028-02-29" });
  });

  it.each([
    undefined,
    [],
    { asOf: "2026-02-29" },
    { asOf: "0000-01-01" },
    { asOf: "2026-08-01", unknown: true },
  ])("rejects malformed dashboard queries", (query) => {
    expect(parseFinanceDashboardQuery(query)).toBeNull();
  });

  it("parses an inclusive revenue date range", () => {
    expect(parseFinanceRevenueQuery({ from: "2026-08-01", to: "2026-08-31" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(parseFinanceRevenueQuery({ from: "2026-08-01", to: "2026-08-01" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-01",
    });
  });

  it.each([
    {},
    { from: "2026-08-01" },
    { from: "2026-08-31", to: "2026-08-01" },
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-08-01", to: "2026-08-31", limit: 50 },
  ])("rejects malformed or ambiguous revenue ranges", (query) => {
    expect(parseFinanceRevenueQuery(query)).toBeNull();
  });

  it("builds property-local dashboard comparison windows", () => {
    expect(financeDashboardPeriods("2026-03-31")).toEqual({
      today: {
        current: { from: "2026-03-31", to: "2026-03-31" },
        comparison: { from: "2026-03-24", to: "2026-03-24" },
      },
      monthToDate: {
        current: { from: "2026-03-01", to: "2026-03-31" },
        comparison: { from: "2026-02-01", to: "2026-02-28" },
      },
      daily: { from: "2026-03-18", to: "2026-03-31" },
    });
    expect(financeDashboardPeriods("2024-03-31").monthToDate.comparison.to).toBe("2024-02-29");
    expect(financeDashboardPeriods("2026-01-03").monthToDate.comparison).toEqual({
      from: "2025-12-01",
      to: "2025-12-03",
    });
  });

  it("builds the immediately preceding equal-length revenue range", () => {
    expect(financeRevenuePeriod({ from: "2026-01-01", to: "2026-01-31" })).toEqual({
      current: { from: "2026-01-01", to: "2026-01-31" },
      comparison: { from: "2025-12-01", to: "2025-12-31" },
    });
    expect(financeRevenuePeriod({ from: "2024-02-29", to: "2024-03-01" }).comparison).toEqual({
      from: "2024-02-27",
      to: "2024-02-28",
    });
    expect(() => financeRevenuePeriod({ from: "2026-02-02", to: "2026-02-01" })).toThrow(TypeError);
  });

  it("parses the accepted profit and loss year filter", () => {
    expect(parseFinanceProfitLossQuery({ year: "2026" })).toEqual({ year: 2026 });
    expect(parseFinanceProfitLossQuery({ year: 2026 })).toEqual({ year: 2026 });
  });

  it.each([
    {},
    { year: "2026", extra: true },
    { year: "026" },
    { year: 1000 },
    { year: 10_000 },
    { year: 2026.5 },
  ])("rejects malformed profit and loss filters", (query) => {
    expect(parseFinanceProfitLossQuery(query)).toBeNull();
  });

  it("builds YTD and prior-year comparison periods", () => {
    expect(financeProfitLossPeriods({ year: 2026 }, "2026-09-17")).toEqual({
      current: { from: "2026-01-01", to: "2026-09-17" },
      comparison: { from: "2025-01-01", to: "2025-09-17" },
    });
    expect(financeProfitLossPeriods({ year: 2025 }, "2026-09-17")).toEqual({
      current: { from: "2025-01-01", to: "2025-12-31" },
      comparison: { from: "2024-01-01", to: "2024-12-31" },
    });
    expect(financeProfitLossPeriods({ year: 2024 }, "2024-02-29").comparison.to).toBe("2023-02-28");
    expect(() => financeProfitLossPeriods({ year: 2027 }, "2026-09-17")).toThrow(TypeError);
  });

  it("rolls default categories into stable rows and preserves each custom category", () => {
    expect(
      [
        "ota_commission",
        "staff",
        "utilities",
        "maintenance",
        "supplies",
        "marketing",
        "platform_fees",
      ].map((systemKey) =>
        financeProfitLossExpenseCategoryRow({
          id: "12140000-0000-4000-8000-000000000001",
          systemKey,
        }),
      ),
    ).toEqual([
      "ota_commission",
      "staff",
      "utilities",
      "maintenance_supplies",
      "maintenance_supplies",
      "marketing_platform",
      "marketing_platform",
    ]);
    expect(
      financeProfitLossExpenseCategoryRow({
        id: "12140000-0000-4000-8000-0000000000AA",
        systemKey: null,
      }),
    ).toBe("custom:12140000-0000-4000-8000-0000000000aa");
  });

  it.each([
    { id: "not-a-uuid", systemKey: null },
    { id: "12140000-0000-4000-8000-000000000001", systemKey: "unknown" },
  ])("rejects malformed profit and loss category evidence", (category) => {
    expect(() => financeProfitLossExpenseCategoryRow(category)).toThrow(TypeError);
  });

  it("accepts a canonical, reconciled P&L zero state with one populated month", () => {
    expect(() =>
      assertFinanceProfitLossResponse(
        profitLossResponse(),
        { year: 2026 },
        "2026-09-17",
        CUSTOM_ROWS,
      ),
    ).not.toThrow();
  });

  it("accepts the canonical all-zero P&L response", () => {
    expect(() =>
      assertFinanceProfitLossResponse(
        profitLossResponse(false),
        { year: 2026 },
        "2026-09-17",
        CUSTOM_ROWS,
      ),
    ).not.toThrow();
  });

  it.each([
    ["month order", (value: FinanceProfitLossResponse) => (value.months[1]!.month = "2026-01")],
    [
      "revenue total",
      (value: FinanceProfitLossResponse) => (value.months[0]!.revenue.amount = "119.0000"),
    ],
    [
      "expense total",
      (value: FinanceProfitLossResponse) => (value.months[0]!.expenses.amount = "29.0000"),
    ],
    [
      "net profit",
      (value: FinanceProfitLossResponse) => (value.months[0]!.netProfit.amount = "91.0000"),
    ],
    [
      "custom category completeness",
      (value: FinanceProfitLossResponse) =>
        delete value.months[1]!.expenseCategories["custom:12140000-0000-4000-8000-0000000000aa"],
    ],
    [
      "custom category omitted from every month",
      (value: FinanceProfitLossResponse) =>
        value.months.forEach((month) => delete month.expenseCategories[CUSTOM_ROWS[0]]),
    ],
    [
      "property currency",
      (value: FinanceProfitLossResponse) => (value.months[0]!.roomRevenue.currency = "USD"),
    ],
    [
      "YTD total",
      (value: FinanceProfitLossResponse) => (value.summary.revenueYtd.value.amount = "121.0000"),
    ],
    [
      "prior-year comparison",
      (value: FinanceProfitLossResponse) => (value.summary.netProfitYtd.percentChange = "0.5000"),
    ],
  ])("rejects an unreconciled P&L %s", (_, mutate) => {
    const value = profitLossResponse();
    mutate(value);
    expect(() =>
      assertFinanceProfitLossResponse(value, { year: 2026 }, "2026-09-17", CUSTOM_ROWS),
    ).toThrow(TypeError);
  });

  it("builds decimal-safe money, count, and ratio comparisons", () => {
    expect(financeReportingMoneyMetric("125", "100.0000", "EUR")).toEqual({
      value: { amount: "125.0000", currency: "EUR" },
      absoluteChange: { amount: "25.0000", currency: "EUR" },
      percentChange: "0.2500",
    });
    expect(financeReportingMoneyMetric("5", "0", "EUR").percentChange).toBeNull();
    expect(financeReportingCountMetric(3, 2)).toEqual({
      value: 3,
      absoluteChange: 1,
      percentChange: "0.5000",
    });
    expect(
      financeReportingRatioMetric(
        { numerator: 2, denominator: 3 },
        { numerator: 1, denominator: 4 },
      ),
    ).toEqual({
      value: "0.6667",
      absoluteChange: "0.4167",
      percentChange: "1.6667",
    });
    expect(
      financeReportingRatioMetric(
        { numerator: 1, denominator: 3 },
        { numerator: 2, denominator: 3 },
      ),
    ).toEqual({ value: "0.3333", absoluteChange: "-0.3333", percentChange: "-0.5000" });
    expect(
      financeReportingRatioMetric(
        { numerator: 0, denominator: 0 },
        { numerator: 0, denominator: 0 },
      ),
    ).toEqual({ value: "0.0000", absoluteChange: "0.0000", percentChange: null });
  });

  it("normalizes and divides decimal evidence without binary floating point", () => {
    expect(normalizeFinanceReportingDecimal("-0")).toBe("0.0000");
    expect(normalizeFinanceReportingDecimal("1999999999999999.9998")).toBe("1999999999999999.9998");
    expect(divideFinanceReportingDecimal("1", 3)).toBe("0.3333");
    expect(divideFinanceReportingDecimal("-1", 6)).toBe("-0.1667");
    expect(divideFinanceReportingDecimal("12", 0)).toBe("0.0000");
  });

  it.each([
    () => normalizeFinanceReportingDecimal("1e2"),
    () => normalizeFinanceReportingDecimal("01.00"),
    () => divideFinanceReportingDecimal("1e2", 0),
    () => financeDashboardPeriods("1000-01-01"),
    () => financeDashboardPeriods("2026-02-29"),
    () => divideFinanceReportingDecimal("1", -1),
    () => financeReportingMoneyMetric("1", "0", "eur"),
    () => financeReportingCountMetric(-1, 0),
    () =>
      financeReportingRatioMetric(
        { numerator: 2, denominator: 1 },
        { numerator: 0, denominator: 0 },
      ),
  ])("rejects invalid reporting evidence", (operation) => {
    expect(operation).toThrow(TypeError);
  });
});

const CUSTOM_ROWS = ["custom:12140000-0000-4000-8000-0000000000aa"] as const;

function profitLossResponse(populated = true): FinanceProfitLossResponse {
  const zero = () => ({ amount: "0.0000", currency: "EUR" });
  const categories = () => ({
    ota_commission: zero(),
    staff: zero(),
    utilities: zero(),
    maintenance_supplies: zero(),
    marketing_platform: zero(),
    "custom:12140000-0000-4000-8000-0000000000aa": zero(),
  });
  const months = Array.from({ length: 9 }, (_, index) => ({
    month: `2026-${String(index + 1).padStart(2, "0")}`,
    roomRevenue: zero(),
    upsellRevenue: zero(),
    revenue: zero(),
    expenses: zero(),
    netProfit: zero(),
    expenseCategories: categories(),
  }));
  if (populated)
    months[0] = {
      ...months[0]!,
      roomRevenue: { amount: "100.0000", currency: "EUR" },
      upsellRevenue: { amount: "20.0000", currency: "EUR" },
      revenue: { amount: "120.0000", currency: "EUR" },
      expenses: { amount: "30.0000", currency: "EUR" },
      netProfit: { amount: "90.0000", currency: "EUR" },
      expenseCategories: {
        ...categories(),
        staff: { amount: "20.0000", currency: "EUR" },
        "custom:12140000-0000-4000-8000-0000000000aa": {
          amount: "10.0000",
          currency: "EUR",
        },
      },
    };
  return {
    contractVersion: "pms-financials.v1",
    propertyId: "12140000-0000-4000-8000-000000000001",
    currency: "EUR",
    timeZone: "Europe/Berlin",
    generatedAt: "2026-09-17T10:00:00.000Z",
    sourceFreshness: {},
    incompleteEvidence: [],
    summary: populated
      ? {
          revenueYtd: financeReportingMoneyMetric("120", "100", "EUR"),
          expensesYtd: financeReportingMoneyMetric("30", "20", "EUR"),
          netProfitYtd: financeReportingMoneyMetric("90", "80", "EUR"),
        }
      : {
          revenueYtd: financeReportingMoneyMetric("0", "0", "EUR"),
          expensesYtd: financeReportingMoneyMetric("0", "0", "EUR"),
          netProfitYtd: financeReportingMoneyMetric("0", "0", "EUR"),
        },
    months,
  };
}
