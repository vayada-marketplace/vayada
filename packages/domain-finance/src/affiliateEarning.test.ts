import { describe, expect, it } from "vitest";
import {
  calculateAffiliateEarning as calculate,
  type AffiliateEarningScope,
} from "./affiliateEarning.js";
import { parseFinanceAffiliatePercentagePolicy } from "./affiliatePercentagePolicy.js";
const scope: AffiliateEarningScope = {
  propertyId: "hotel-1",
  creatorProfileId: "creator-1",
  agreementId: "agreement-1",
  policyVersionId: "policy-1",
  bookingId: "booking-1",
  stayItemId: "room-1",
  currency: "EUR",
  currencyMinorUnit: 2,
  rounding: "half_up",
};
const input = () => ({
  scope: { ...scope },
  policy: {
    policyVersionId: "policy-1",
    propertyId: "hotel-1",
    approvalStatus: "approved" as const,
    policy: parseFinanceAffiliatePercentagePolicy({ percentageRate: "10" })!,
  },
  evidence: {
    status: "verified" as const,
    stay: "completed" as const,
    netAccommodationMinor: "50000",
    references: ["evidence-1"],
  },
  previous: null,
});

describe("affiliate earning amount", () => {
  it.each([
    ["50000", "5000"],
    ["45000", "4500"],
    ["40000", "4000"],
    ["0", "0"],
  ])("calculates net accommodation %s -> %s", (net, total) => {
    const request = input();
    request.evidence.netAccommodationMinor = net;
    expect(calculate(request)).toMatchObject({
      status: "calculated",
      snapshot: { scope, commissionMinor: total },
      adjustmentMinor: total,
    });
  });
  it("derives a correction from the revised total and preserves the previous paid/calculated snapshot", () => {
    const previous = { scope: { ...scope }, commissionMinor: "5000" };
    const request = {
      ...input(),
      previous,
      evidence: { ...input().evidence, netAccommodationMinor: "40000" },
    };
    expect(calculate(request)).toMatchObject({
      snapshot: { commissionMinor: "4000" },
      adjustmentMinor: "-1000",
    });
    expect(previous.commissionMinor).toBe("5000");
    expect(calculate({ ...request, previous: { scope, commissionMinor: "4000" } })).toMatchObject({
      adjustmentMinor: "0",
    });
    expect(
      calculate({ ...request, evidence: { ...request.evidence, netAccommodationMinor: "0" } }),
    ).toMatchObject({ adjustmentMinor: "-5000" });
  });
  it.each(["cancelled", "no_show"] as const)(
    "assigns no commission to unconsumed %s items",
    (stay) => {
      expect(
        calculate({
          ...input(),
          evidence: { ...input().evidence, stay, netAccommodationMinor: null },
        }),
      ).toMatchObject({ snapshot: { commissionMinor: "0" } });
      expect(calculate({ ...input(), evidence: { ...input().evidence, stay } })).toMatchObject({
        status: "needs_review",
        reason: "conflicting_evidence",
      });
    },
  );
  it("keeps missing and conflicting evidence unresolved rather than reversing a previous earning", () => {
    for (const evidence of [
      { status: "incomplete" as const },
      { stay: "unknown" as const },
      { netAccommodationMinor: null },
      { references: [] },
    ])
      expect(
        calculate({
          ...input(),
          previous: { scope, commissionMinor: "5000" },
          evidence: { ...input().evidence, ...evidence },
        }),
      ).toMatchObject({ status: "pending" });
    expect(
      calculate({ ...input(), evidence: { ...input().evidence, status: "conflicting" } }),
    ).toMatchObject({ status: "needs_review" });
  });
  it("requires the exact approved historical policy, including its property and model", () => {
    for (const policy of [
      null,
      { ...input().policy, policyVersionId: "new-policy" },
      { ...input().policy, propertyId: "hotel-2" },
      { ...input().policy, approvalStatus: "draft" as const },
      { ...input().policy, policy: { ...input().policy.policy, rateBasisPoints: 2000 } },
    ])
      expect(calculate({ ...input(), policy })).toMatchObject({
        status: "pending",
        reason: "policy_unavailable",
      });
  });
  it("rejects adjustment scope changes instead of crossing hotels, creators, items or currencies", () => {
    for (const key of [
      "propertyId",
      "creatorProfileId",
      "agreementId",
      "policyVersionId",
      "bookingId",
      "stayItemId",
      "currency",
    ] as const)
      expect(
        calculate({
          ...input(),
          previous: {
            scope: { ...scope, [key]: key === "currency" ? "USD" : "other" },
            commissionMinor: "5000",
          },
        }),
      ).toMatchObject({ reason: "previous_scope_mismatch" });
    expect(
      calculate({
        ...input(),
        previous: { scope: { ...scope, currencyMinorUnit: 0 }, commissionMinor: "5000" },
      }),
    ).toMatchObject({ reason: "previous_scope_mismatch" });
  });
  it("rounds the new total once using explicit half-up and exact large integer arithmetic", () => {
    for (const [net, total] of [
      ["4", "0"],
      ["5", "1"],
      ["15", "2"],
      ["90071992547409935", "9007199254740994"],
    ])
      expect(
        calculate({ ...input(), evidence: { ...input().evidence, netAccommodationMinor: net! } }),
      ).toMatchObject({ snapshot: { commissionMinor: total } });
    for (const rate of ["0", "100"])
      expect(
        calculate({
          ...input(),
          policy: {
            ...input().policy,
            policy: parseFinanceAffiliatePercentagePolicy({ percentageRate: rate })!,
          },
        }),
      ).toMatchObject({ snapshot: { commissionMinor: rate === "0" ? "0" : "50000" } });
  });
  it("rejects malformed amounts and absent rounding; copies output scope/evidence", () => {
    for (const net of ["-1", "1.5", "01", "1e3", "9".repeat(31)])
      expect(
        calculate({ ...input(), evidence: { ...input().evidence, netAccommodationMinor: net } }),
      ).toMatchObject({ reason: "invalid_input" });
    expect(
      calculate({ ...input(), scope: { ...scope, rounding: undefined } } as unknown as Parameters<
        typeof calculate
      >[0]),
    ).toMatchObject({ reason: "invalid_input" });
    const request = input(),
      result = calculate(request);
    request.scope.propertyId = "changed";
    request.evidence.references[0] = "changed";
    expect(result).toMatchObject({ snapshot: { scope }, evidenceReferences: ["evidence-1"] });
  });
});
