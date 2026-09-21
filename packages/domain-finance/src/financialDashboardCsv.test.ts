import { describe, expect, it } from "vitest";

import {
  buildFinanceDashboardCsvArtifact,
  captureFinanceDashboardExport,
  parseFinanceDashboardExportSnapshot,
} from "./financialDashboardCsv.js";
import {
  financeDashboardPeriods,
  financeReportingMoneyMetric,
  type FinanceDashboardResponse,
} from "./financialReporting.js";

const PROPERTY = "11280000-0000-4000-8000-000000000001";
const AS_OF = "2026-08-04";
const money = (amount: string) => ({ amount, currency: "EUR" });
const response = (): FinanceDashboardResponse => {
  const range = financeDashboardPeriods(AS_OF).daily;
  const start = Date.parse(`${range.from}T00:00:00Z`);
  return {
    contractVersion: "pms-financials.v1",
    propertyId: PROPERTY,
    currency: "EUR",
    timeZone: "Europe/Berlin",
    generatedAt: "2026-08-04T14:00:00.000Z",
    sourceFreshness: { providerSecret: "do-not-export" },
    incompleteEvidence: [{ code: "gap", count: 1, amount: money("9.0000") }],
    cards: {
      revenueToday: financeReportingMoneyMetric("25", "10", "EUR"),
      revenueMtd: financeReportingMoneyMetric("350", "80", "EUR"),
      expensesMtd: financeReportingMoneyMetric("70", "90", "EUR"),
      profitMtd: financeReportingMoneyMetric("280", "-10", "EUR"),
    },
    daily: Array.from({ length: 14 }, (_, index) => ({
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      revenue: money(`${index}.0000`),
      expenses: money("1.0000"),
    })),
    upcoming: [
      {
        date: "2026-08-06",
        kind: '=HYPERLINK("https://evil")',
        amount: money("4.0000"),
        predicted: true,
      },
      { date: "2026-08-07", kind: "rent", amount: money("-3.0000"), predicted: false },
    ],
  };
};
const build = (value = response(), query: { asOf?: string } = { asOf: AS_OF }) =>
  buildFinanceDashboardCsvArtifact({ propertyId: PROPERTY, response: value, query });

describe("Dashboard CSV handoff", () => {
  it("copies card, daily, and upcoming read values at the effective as-of date", () => {
    const artifact = build();
    expect(artifact).toMatchObject({
      formatVersion: "pms-financials-dashboard.v1",
      contentType: "text/csv; charset=utf-8",
      propertyId: PROPERTY,
      currency: "EUR",
      asOf: AS_OF,
      filename: `pms-financials-dashboard-${PROPERTY}-${AS_OF}.csv`,
      rowCount: 34,
    });
    const lines = artifact.body.trimEnd().split("\r\n");
    expect(lines).toHaveLength(35);
    expect(lines).toContain(
      `"${PROPERTY}","${AS_OF}","card","${AS_OF}","revenueToday","","25.0000","EUR","15.0000","1.5000",""`,
    );
    expect(lines).toContain(
      `"${PROPERTY}","${AS_OF}","daily","2026-08-04","expenses","","1.0000","EUR","","",""`,
    );
    expect(lines).toContain(
      `"${PROPERTY}","${AS_OF}","upcoming","2026-08-07","amount","rent","-3.0000","EUR","","","false"`,
    );
    expect(artifact.body).not.toMatch(/providerSecret|do-not-export|"gap"|guest/i);
  });

  it("resolves an omitted as-of from the property time zone and neutralizes formulas", () => {
    const artifact = build(response(), {});
    expect(artifact.asOf).toBe(AS_OF);
    expect(artifact.body).toContain('"\'=HYPERLINK(""https://evil"")"');
    expect(artifact.body).toContain('"-3.0000"');
    expect(artifact.body).not.toContain('"\'-3.0000"');
  });

  it("accepts UTC timestamp precision accepted by Dashboard GET", () => {
    for (const generatedAt of ["2026-08-04T14:00:00Z", "2026-08-04T14:00:00.1Z"]) {
      const value = response();
      value.generatedAt = generatedAt;
      expect(build(value).generatedAt).toBe(generatedAt);
    }
  });

  it("rejects different properties, malformed scope, incomplete days, and wrong-currency money", () => {
    const wrongProperty = response();
    wrongProperty.propertyId = "11280000-0000-4000-8000-000000000002";
    expect(() => build(wrongProperty)).toThrow(TypeError);
    expect(() => build(response(), { asOf: "2026-02-29" })).toThrow(TypeError);
    const missingDay = response();
    missingDay.daily.pop();
    expect(() => build(missingDay)).toThrow(TypeError);
    const wrongCurrency = response();
    wrongCurrency.upcoming[0]!.amount.currency = "USD";
    expect(() => build(wrongCurrency)).toThrow(TypeError);
    const pastUpcoming = response();
    pastUpcoming.upcoming[0]!.date = "2026-08-03";
    expect(() => build(pastUpcoming)).toThrow(TypeError);
    const unsortedUpcoming = response();
    unsortedUpcoming.upcoming.reverse();
    expect(() => build(unsortedUpcoming)).toThrow(TypeError);
    const aliasZone = response();
    aliasZone.timeZone = "Asia/Calcutta";
    expect(() => build(aliasZone)).toThrow(TypeError);
    const canonicalZone = response();
    canonicalZone.timeZone = "Asia/Kolkata";
    expect(() => build(canonicalZone)).not.toThrow();
  });

  it("pins only whitelisted read fields and rebuilds identical CSV after JSONB key reordering", () => {
    const raw = response();
    (raw.upcoming[0] as unknown as Record<string, unknown>)["guestSecret"] = "never-store";
    const snapshot = captureFinanceDashboardExport({
      propertyId: PROPERTY,
      response: raw,
      query: {},
    });
    expect(snapshot.asOf).toBe(AS_OF);
    expect(snapshot.filters).toEqual({ asOf: AS_OF });
    const stored = JSON.stringify(snapshot);
    expect(stored).not.toMatch(/providerSecret|do-not-export|guestSecret|never-store|"gap"/);
    const reorder = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reorder)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, part]) => [key, reorder(part)]),
            )
          : value;
    const parsed = parseFinanceDashboardExportSnapshot(reorder(JSON.parse(stored)));
    expect(parsed).not.toBeNull();
    expect(
      buildFinanceDashboardCsvArtifact({
        propertyId: PROPERTY,
        response: parsed!.manifest[0].response,
        query: parsed!.filters,
      }).body,
    ).toBe(build(raw, {}).body);
  });

  it("rejects tampered snapshot metadata and strips extra stored fields", () => {
    const snapshot = captureFinanceDashboardExport({
      propertyId: PROPERTY,
      response: response(),
      query: { asOf: AS_OF },
    });
    const tampered = JSON.parse(JSON.stringify(snapshot));
    tampered.asOf = "2026-08-03";
    expect(parseFinanceDashboardExportSnapshot(tampered)).toBeNull();
    tampered.asOf = AS_OF;
    tampered.filters = {};
    expect(parseFinanceDashboardExportSnapshot(tampered)).toBeNull();
    tampered.filters = { asOf: AS_OF };
    tampered.manifest[0].response.cards.revenueToday.value.currency = "USD";
    expect(parseFinanceDashboardExportSnapshot(tampered)).toBeNull();
    const extra = JSON.parse(JSON.stringify(snapshot));
    extra.manifest[0].response.upcoming[0].guestSecret = "never-return";
    expect(JSON.stringify(parseFinanceDashboardExportSnapshot(extra))).not.toContain(
      "never-return",
    );
  });
});
