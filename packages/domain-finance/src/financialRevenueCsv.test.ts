import { describe, expect, it } from "vitest";

import { buildFinanceRevenueCsvArtifact } from "./financialRevenueCsv.js";
import { financeReportingMoneyMetric, type FinanceRevenueResponse } from "./financialReporting.js";

const PROPERTY = "11280000-0000-4000-8000-000000000001";
const ROOM = "11280000-0000-4000-8000-000000000010";
const money = (amount: string) => ({ amount, currency: "EUR" });
const response = (): FinanceRevenueResponse => ({
  contractVersion: "pms-financials.v1",
  propertyId: PROPERTY,
  currency: "EUR",
  timeZone: "Europe/Berlin",
  generatedAt: "2026-08-04T14:00:00.000Z",
  sourceFreshness: { providerSecret: "do-not-export" },
  incompleteEvidence: [
    {
      code: "room_revenue_currency_mismatch",
      count: 1,
      amount: { amount: "9.0000", currency: "USD" },
    },
  ],
  summary: {
    grossRoom: financeReportingMoneyMetric("350", "80", "EUR"),
    otaCommission: financeReportingMoneyMetric("30", "0", "EUR"),
    netRoom: financeReportingMoneyMetric("320", "80", "EUR"),
    upsell: financeReportingMoneyMetric("25", "10", "EUR"),
    nights: { value: 4, absoluteChange: -3, percentChange: "-0.4286" },
    adr: financeReportingMoneyMetric("87.5", "80", "EUR"),
    attachRate: { value: "0.6667", absoluteChange: "-0.3333", percentChange: "-0.3333" },
  },
  channels: [
    {
      channel: '=HYPERLINK("https://evil")',
      gross: money("200.0000"),
      commission: money("30.0000"),
      net: money("170.0000"),
      share: "0.5714",
    },
    {
      channel: "direct",
      gross: money("100.0000"),
      commission: money("0.0000"),
      net: money("100.0000"),
      share: "0.2857",
    },
  ],
  directSources: [{ source: "email", revenue: money("100.0000"), share: "1.0000" }],
  upsells: [
    { ownership: "property", revenue: money("20.0000") },
    { ownership: "partner", revenue: money("5.0000") },
  ],
  roomTypes: [{ roomTypeId: ROOM, nights: 3, revenue: money("300.0000"), adr: money("100.0000") }],
});
const build = (value = response()) =>
  buildFinanceRevenueCsvArtifact({
    propertyId: PROPERTY,
    response: value,
    query: { from: "2026-08-01", to: "2026-08-04" },
  });

describe("Revenue CSV handoff", () => {
  it("copies every read summary and breakdown value with the requested date and property scope", () => {
    const artifact = build();
    expect(artifact).toMatchObject({
      formatVersion: "pms-financials-revenue.v1",
      contentType: "text/csv; charset=utf-8",
      propertyId: PROPERTY,
      currency: "EUR",
      filters: { from: "2026-08-01", to: "2026-08-04" },
      filename: `pms-financials-revenue-${PROPERTY}-2026-08-01-2026-08-04.csv`,
      rowCount: 22,
    });
    const lines = artifact.body.trimEnd().split("\r\n");
    expect(lines).toHaveLength(23);
    expect(lines).toContain(
      `"${PROPERTY}","2026-08-01","2026-08-04","summary","","grossRoom","350.0000","EUR","270.0000","3.3750"`,
    );
    expect(lines).toContain(
      `"${PROPERTY}","2026-08-01","2026-08-04","summary","","nights","4","","-3","-0.4286"`,
    );
    expect(lines).toContain(
      `"${PROPERTY}","2026-08-01","2026-08-04","room_type","${ROOM}","revenue","300.0000","EUR","",""`,
    );
    expect(artifact.body).not.toMatch(/providerSecret|do-not-export|9\.0000|USD|guest/i);
  });

  it("neutralizes formula-like labels while preserving numeric negatives", () => {
    const body = build().body;
    expect(body).toContain('"\'=HYPERLINK(""https://evil"")"');
    expect(body).toContain('"-3"');
    expect(body).not.toContain('"\'-3"');
  });

  it("rejects a different property, invalid date range, and wrong-currency amounts", () => {
    const wrongProperty = response();
    wrongProperty.propertyId = "11280000-0000-4000-8000-000000000002";
    expect(() => build(wrongProperty)).toThrow(TypeError);
    const wrongCurrency = response();
    wrongCurrency.channels[0]!.net.currency = "USD";
    expect(() => build(wrongCurrency)).toThrow(TypeError);
    expect(() =>
      buildFinanceRevenueCsvArtifact({
        propertyId: PROPERTY,
        response: response(),
        query: { from: "2026-08-05", to: "2026-08-04" },
      }),
    ).toThrow(TypeError);
  });
});
