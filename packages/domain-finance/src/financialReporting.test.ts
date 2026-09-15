import { describe, expect, it } from "vitest";

import {
  FINANCE_DASHBOARD_WINDOW_DAYS,
  parseFinanceDashboardQuery,
  parseFinanceRevenueQuery,
} from "./financialReporting.js";

describe("Financials reporting contracts", () => {
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
});
