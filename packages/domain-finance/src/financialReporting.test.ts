import { describe, expect, it } from "vitest";

import type { FinanceReportingEnvelope } from "./financialReporting.js";

import {
  FINANCE_DASHBOARD_WINDOW_DAYS,
  divideFinanceReportingDecimal,
  financeDashboardPeriods,
  financeReportingCountMetric,
  financeReportingMoneyMetric,
  financeReportingRatioMetric,
  financeRevenuePeriod,
  normalizeFinanceReportingDecimal,
  parseFinanceDashboardQuery,
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
