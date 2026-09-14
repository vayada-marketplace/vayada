import { describe, expect, it } from "vitest";
import {
  parseFinanceAffiliatePercentagePolicy as parse,
  resolveFinanceAffiliatePercentagePolicy as resolve,
  type FinanceAffiliatePercentagePolicyRecord,
} from "./affiliatePercentagePolicy.js";

describe("hotel-chosen affiliate percentage policy", () => {
  it.each([
    ["0", 0, "0.00"],
    ["0.01", 1, "0.01"],
    ["10", 1000, "10.00"],
    ["12.5", 1250, "12.50"],
    ["99.99", 9999, "99.99"],
    ["100.00", 10000, "100.00"],
  ])("normalizes %s exactly", (rate, bps, display) => {
    const policy = parse({ percentageRate: rate });
    expect(policy).toMatchObject({
      rateBasisPoints: bps,
      percentageRate: display,
      model: "percentage",
      revenueBasis: "accommodation_excluding_taxes_and_extras",
      eligibility: "verified_completion",
    });
    expect(Object.isFrozen(policy)).toBe(true);
  });
  it.each([
    undefined,
    null,
    10,
    "",
    " ",
    " 10",
    "10 ",
    "-1",
    "100.01",
    "101",
    "0.001",
    "1e1",
    "01",
    ".5",
    "10%",
    "12,5",
    "Infinity",
  ])("rejects invalid or implicit rate %s", (percentageRate) => {
    expect(parse({ percentageRate })).toBeNull();
  });
  it("rejects absent input, policy overrides and accessors", () => {
    for (const input of [
      null,
      [],
      {},
      "10",
      { percentageRate: "10", model: "fixed" },
      { percentageRate: "10", propertyId: "other" },
      { percentageRate: "10", revenueBasis: "total" },
    ])
      expect(parse(input)).toBeNull();
    expect(
      parse({
        get percentageRate() {
          throw new Error("must not execute");
        },
      }),
    ).toBeNull();
  });
  const version = (rate = "10"): FinanceAffiliatePercentagePolicyRecord => ({
    policyVersionId: "v1",
    propertyId: "hotel-1",
    approvalStatus: "approved",
    policy: parse({ percentageRate: rate })!,
  });
  const request = { policyVersionId: "v1", propertyId: "hotel-1" };
  it("requires exact version, hotel and approval without falling back", () => {
    expect(resolve(null, request)).toMatchObject({ reason: "not_found" });
    expect(resolve(version(), { ...request, policyVersionId: "v2" })).toMatchObject({
      reason: "not_found",
    });
    expect(resolve(version(), { ...request, propertyId: "hotel-2" })).toMatchObject({
      reason: "scope_mismatch",
    });
    expect(resolve({ ...version(), approvalStatus: "draft" }, request)).toMatchObject({
      reason: "not_approved",
    });
    expect(resolve(version(), request)).toMatchObject({
      status: "available",
      policy: { rateBasisPoints: 1000 },
    });
  });
  it("rejects inconsistent stored basis points and altered commission basis", () => {
    const record = version();
    expect(
      resolve({ ...record, policy: { ...record.policy, rateBasisPoints: 500 } }, request),
    ).toMatchObject({ reason: "invalid_policy" });
    expect(
      resolve({ ...record, policy: { ...record.policy, revenueBasis: "total" } as never }, request),
    ).toMatchObject({ reason: "invalid_policy" });
  });
  it("returns a detached policy and preserves an older version when a rate changes", () => {
    const original = version();
    const result = resolve(original, request);
    const newer = { ...version("20"), policyVersionId: "v2" };
    expect(resolve(newer, request)).toMatchObject({ reason: "not_found" });
    expect(result).toMatchObject({ policyVersionId: "v1", policy: { rateBasisPoints: 1000 } });
    if (result.status === "available") expect(result.policy).not.toBe(original.policy);
  });
});
