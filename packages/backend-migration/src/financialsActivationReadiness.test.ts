import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";

import { runFinancialsActivationReadiness } from "./financialsActivationReadiness.js";

const PROPERTY = "11380000-0000-4000-8000-000000000001";
const ready = {
  propertyExists: true,
  pricingConfigured: true,
  missingCategories: 0,
  eligibleBookings: 2,
  assignmentCoverageGaps: 0,
  missingRevenueLines: 0,
  unresolvedRevenueLines: 0,
  unknownAttributionBookings: 0,
  otaSourceMismatches: 0,
  otaLinesWithoutCommission: 0,
  missingCommissionRules: 0,
  ambiguousCommissionRules: 0,
  pendingCommissionExpenses: 0,
  financialsActive: false,
};

describe("Financials activation readiness", () => {
  it("reports every material blocker without hiding counts", async () => {
    const client = {
      async query<T extends QueryResultRow = QueryResultRow>(sql: string) {
        return {
          rows: (sql === "SHOW transaction_read_only"
            ? [{ transaction_read_only: "on" }]
            : [
                {
                  ...ready,
                  propertyExists: false,
                  pricingConfigured: false,
                  missingCategories: 7,
                  assignmentCoverageGaps: 2,
                  missingRevenueLines: 2,
                  unresolvedRevenueLines: 3,
                  unknownAttributionBookings: 1,
                  otaSourceMismatches: 1,
                  otaLinesWithoutCommission: 4,
                  missingCommissionRules: 2,
                  ambiguousCommissionRules: 1,
                  pendingCommissionExpenses: 5,
                  financialsActive: true,
                },
              ]) as unknown as T[],
        };
      },
    };
    const report = await runFinancialsActivationReadiness(client, { propertyId: PROPERTY });
    expect(report.status).toBe("blocked");
    expect(report.summary.blockers).toBe(31);
    expect(report.findings.map(({ code }) => code)).toEqual([
      "PROPERTY_NOT_FOUND",
      "PRICING_NOT_CONFIGURED",
      "DEFAULT_CATEGORIES_MISSING",
      "STAY_SCOPE_INCOMPLETE",
      "REVENUE_BACKFILL_INCOMPLETE",
      "REVENUE_EVIDENCE_MISSING",
      "ATTRIBUTION_UNKNOWN",
      "OTA_REVENUE_SOURCE_MISMATCH",
      "OTA_COMMISSION_EVIDENCE_MISSING",
      "OTA_COMMISSION_RULE_MISSING",
      "OTA_COMMISSION_RULE_AMBIGUOUS",
      "OTA_COMMISSION_EXPENSE_PENDING",
      "MODULE_STATE_MISMATCH",
    ]);
  });

  it("requires a valid property and a read-only transaction", async () => {
    const client = {
      async query<T extends QueryResultRow = QueryResultRow>() {
        return { rows: [{ transaction_read_only: "off" }] as unknown as T[] };
      },
    };
    await expect(
      runFinancialsActivationReadiness(client, { propertyId: PROPERTY }),
    ).rejects.toThrow("read-only");
    await expect(
      runFinancialsActivationReadiness(client, { propertyId: "not-a-uuid" }),
    ).rejects.toThrow("malformed");
  });
});
