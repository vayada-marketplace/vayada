import { describe, expect, it, vi } from "vitest";
import { resolvePgFinanceAffiliatePercentagePolicy as resolve } from "./financeAffiliatePercentagePolicyResolver.js";
const request = {
  propertyId: "15100000-0000-4000-8000-000000000003",
  policyVersionId: "15100000-0000-4000-8000-000000000010",
};
const row = {
  id: request.policyVersionId,
  property_id: request.propertyId,
  contract_version: "finance-affiliate-percentage-policy.v1",
  model: "percentage",
  revenue_basis: "accommodation_excluding_taxes_and_extras",
  eligibility: "verified_completion",
  rate_basis_points: 1250,
  approved_id: request.policyVersionId,
};
describe("stored affiliate percentage validation", () => {
  it("rejects malformed references before database access", async () => {
    const database = { query: vi.fn() };
    await expect(resolve(database, { ...request, policyVersionId: "not-a-uuid" })).resolves.toEqual(
      { status: "unavailable", reason: "not_found" },
    );
    expect(database.query).not.toHaveBeenCalled();
  });
  it("does not disguise database failures as absent policy", async () => {
    const database = { query: vi.fn().mockRejectedValue(new Error("database unavailable")) };
    await expect(resolve(database, request)).rejects.toThrow("database unavailable");
  });
  it.each([
    { rate_basis_points: null },
    { rate_basis_points: "1250" },
    { rate_basis_points: -1 },
    { rate_basis_points: 10001 },
    { rate_basis_points: 12.5 },
    { model: "fixed" },
    { revenue_basis: "total" },
    { eligibility: "booked" },
    { contract_version: "v0" },
  ])("fails closed on invalid persisted policy %j", async (change) => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ ...row, ...change }] }) };
    await expect(resolve(database, request)).resolves.toEqual({
      status: "unavailable",
      reason: "invalid_policy",
    });
  });
});
