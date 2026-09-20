import { describe, expect, it } from "vitest";

import { buildFinanceProfitLossCsvArtifact } from "./financialProfitLossCsv.js";
import {
  financeReportingMoneyMetric,
  type FinanceProfitLossResponse,
} from "./financialReporting.js";

const PROPERTY = "12140000-0000-4000-8000-000000000001";
const CATEGORY = "custom:12140000-0000-4000-8000-0000000000aa" as const;
const money = (amount: string) => ({ amount, currency: "EUR" });
const zero = () => money("0.0000");
const categories = () => ({
  ota_commission: zero(),
  staff: zero(),
  utilities: zero(),
  maintenance_supplies: zero(),
  marketing_platform: zero(),
  [CATEGORY]: zero(),
});
const response = (): FinanceProfitLossResponse => ({
  contractVersion: "pms-financials.v1",
  propertyId: PROPERTY,
  currency: "EUR",
  timeZone: "Europe/Berlin",
  generatedAt: "2026-01-17T10:00:00.000Z",
  sourceFreshness: {},
  incompleteEvidence: [],
  summary: {
    revenueYtd: financeReportingMoneyMetric("120", "100", "EUR"),
    expensesYtd: financeReportingMoneyMetric("30", "20", "EUR"),
    netProfitYtd: financeReportingMoneyMetric("90", "80", "EUR"),
  },
  months: [
    {
      month: "2026-01",
      roomRevenue: money("100.0000"),
      upsellRevenue: money("20.0000"),
      revenue: money("120.0000"),
      expenses: money("30.0000"),
      netProfit: money("90.0000"),
      expenseCategories: { ...categories(), staff: money("20.0000"), [CATEGORY]: money("10.0000") },
    },
  ],
});
const build = (value = response()) =>
  buildFinanceProfitLossCsvArtifact({
    propertyId: PROPERTY,
    response: value,
    query: { year: 2026 },
    asOf: "2026-01-17",
    categoryRows: [CATEGORY],
  });

describe("profit and loss CSV handoff", () => {
  it("maps the exact YTD, monthly, and every category amount from the read without double-counted totals", () => {
    const artifact = build();
    expect(artifact).toMatchObject({
      formatVersion: "pms-financials-profit-loss.v1",
      contentType: "text/csv; charset=utf-8",
      filename: `pms-financials-profit-loss-${PROPERTY}-2026-2026-01-17.csv`,
      propertyId: PROPERTY,
      currency: "EUR",
      asOf: "2026-01-17",
      rowCount: 14,
    });
    const lines = artifact.body.trimEnd().split("\r\n");
    expect(lines).toHaveLength(15);
    expect(lines[0]).toContain('"as_of","row_type","period","metric","category","value"');
    expect(lines).toContain(
      `"${PROPERTY}","2026","2026-01-17","summary","2026","netProfitYtd","","90.0000","EUR","10.0000","0.1250"`,
    );
    expect(lines).toContain(
      `"${PROPERTY}","2026","2026-01-17","month","2026-01","netProfit","","90.0000","EUR","",""`,
    );
    expect(lines).toContain(
      `"${PROPERTY}","2026","2026-01-17","expense_category","2026-01","expenses","${CATEGORY}","10.0000","EUR","",""`,
    );
    expect(artifact.body).not.toMatch(/supplierInvoiceNumber|guest|provider|secret/i);
  });

  it("rejects unreconciled values and formula-like category identifiers", () => {
    const drift = response();
    drift.months[0]!.netProfit.amount = "91.0000";
    expect(() => build(drift)).toThrow(TypeError);
    const injection = response();
    Object.assign(injection.months[0]!.expenseCategories, { '=HYPERLINK("https://evil")': zero() });
    expect(() => build(injection)).toThrow(TypeError);
    const wrongProperty = response();
    wrongProperty.propertyId = "=cmd";
    expect(() => build(wrongProperty)).toThrow(TypeError);
    const otherProperty = response();
    otherProperty.propertyId = "12140000-0000-4000-8000-000000000002";
    expect(() => build(otherProperty)).toThrow(TypeError);
    const stale = response();
    stale.generatedAt = "2026-01-18T10:00:00.000Z";
    expect(() => build(stale)).toThrow(TypeError);
  });

  it("preserves a legitimate negative amount without turning it into text", () => {
    const negative = response();
    negative.months[0]!.expenseCategories[CATEGORY] = money("-10.0000");
    negative.months[0]!.expenses = money("10.0000");
    negative.months[0]!.netProfit = money("110.0000");
    negative.summary.expensesYtd = financeReportingMoneyMetric("10", "0", "EUR");
    negative.summary.netProfitYtd = financeReportingMoneyMetric("110", "100", "EUR");
    expect(build(negative).body).toContain(`"${CATEGORY}","-10.0000","EUR"`);
  });
});
