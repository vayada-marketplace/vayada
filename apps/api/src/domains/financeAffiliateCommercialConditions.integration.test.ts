import { beforeEach, describe, expect, it } from "vitest";
import {
  databaseUrl,
  id,
  publicationCommandFixture,
  terms,
} from "./affiliatePublicationCommandTestFixture.js";
import { readFinanceAffiliateCommercialConditions as read } from "./financeAffiliateCommercialConditions.js";
import type { AffiliatePublicationScope } from "./marketplaceAffiliatePublication.js";

describe.skipIf(!databaseUrl)("Finance affiliate commercial conditions", () => {
  const fixture = publicationCommandFixture();
  const scope = (): AffiliatePublicationScope => ({
    propertyId: id(3),
    organizationId: id(4),
    offerId: id(2),
    draftId: id(20),
    terms,
  });
  const transact = async (input = scope()) => {
    const client = await fixture.pool().connect();
    try {
      await client.query("BEGIN");
      return await read(client, input);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  };

  beforeEach(async () => {
    await fixture
      .pool()
      .query("UPDATE pms.property_pricing_settings SET currency='EUR',pricing_currency_revision=1");
  });

  it("returns deterministic approved terms and exact immutable evidence", async () => {
    const result = await transact();
    expect(result).toMatchObject({
      status: "ready",
      attributionPolicyVersion: "last-eligible-click.v1",
      evidenceReferences: [
        `finance:affiliate-percentage-policy:${terms.financePolicyVersionId}`,
        `pms:pricing-currency:${id(3)}:1`,
      ],
    });
    if (result.status !== "ready") throw new Error("expected ready conditions");
    expect(JSON.parse(result.conditionsText)).toEqual({
      contractVersion: "finance-affiliate-commercial-conditions.v1",
      commission: {
        percentageRate: "12.50",
        revenueBasis: "accommodation_excluding_taxes_and_extras",
        eligibility: "verified_completion",
        cancellationOrNoShow: "no_commission_for_unconsumed_stay",
        refundAdjustment: "accommodation_component_only",
        eligibilityHoldDays: 14,
      },
      settlement: {
        currency: "EUR",
        currencyMinorUnit: 2,
        foreignExchange: "none_exact_currency_required",
        creatorCommissionFunding: "hotel_funds_full_displayed_commission",
        creatorFeeDeduction: "none",
        payoutSchedule: {
          selection: "creator_preference",
          allowed: ["manual", "monthly", "threshold"],
          default: "none",
          monthlyRun: "next_15th_00:00:00Z",
          threshold: "explicit_same_currency_amount",
          hiddenMinimum: false,
          preferenceHistory: "changes_do_not_rewrite_history",
        },
        transferFailure: {
          states: ["processing", "failed"],
          uncertainProviderOutcome: "processing",
          neverAssumePaid: true,
          retry: "finance_ops_idempotent_reconciliation",
          creatorCommunicationOwner: "marketplace_support",
          bookingEvidenceDisputeOwner: "hotel",
        },
      },
    });
  });

  it("blocks an unapproved policy", async () => {
    await fixture.pool().query(
      `INSERT INTO finance.affiliate_percentage_policy_versions
       (id,property_id,contract_version,model,revenue_basis,eligibility,rate_basis_points,
        created_by_user_id,created_by_organization_id,request_id)
       SELECT $1,property_id,contract_version,model,revenue_basis,eligibility,1000,
              created_by_user_id,created_by_organization_id,'draft'
       FROM finance.affiliate_percentage_policy_versions WHERE id=$2`,
      [id(12), id(10)],
    );
    await expect(
      transact({ ...scope(), terms: { ...terms, financePolicyVersionId: id(12) } }),
    ).resolves.toEqual({ status: "blocked", reasons: ["commission_policy_unavailable"] });
  });

  it.each([
    ["wrong organization", { organizationId: id(7) }],
    ["wrong property", { propertyId: id(6) }],
  ])("blocks a policy in the %s without exposing its scope", async (_name, change) => {
    await expect(transact({ ...scope(), ...change })).resolves.toEqual({
      status: "blocked",
      reasons: ["commission_policy_unavailable"],
    });
  });

  it("blocks missing and unsupported settlement currency", async () => {
    await fixture.pool().query("DELETE FROM pms.property_pricing_settings");
    await expect(transact()).resolves.toEqual({
      status: "blocked",
      reasons: ["settlement_currency_unavailable"],
    });
    await fixture
      .pool()
      .query("INSERT INTO pms.property_pricing_settings VALUES ($1,'JPY',2)", [id(3)]);
    await expect(transact()).resolves.toEqual({
      status: "blocked",
      reasons: ["settlement_currency_unsupported"],
    });
  });

  it("uses the exact selected historical policy instead of the latest rate", async () => {
    await fixture.pool().query(
      `INSERT INTO finance.affiliate_percentage_policy_versions
       (id,property_id,contract_version,model,revenue_basis,eligibility,rate_basis_points,
        created_by_user_id,created_by_organization_id,request_id)
       SELECT $1,property_id,contract_version,model,revenue_basis,eligibility,2500,
              created_by_user_id,created_by_organization_id,'newer'
       FROM finance.affiliate_percentage_policy_versions WHERE id=$2`,
      [id(11), id(10)],
    );
    await fixture.pool().query(
      `INSERT INTO finance.affiliate_percentage_policy_approvals
       (policy_version_id,property_id,approved_by_user_id,approved_by_organization_id,request_id)
       VALUES ($1,$2,$3,$4,'newer')`,
      [id(11), id(3), id(1), id(4)],
    );
    const result = await transact();
    if (result.status !== "ready") throw new Error("expected historical conditions");
    expect(JSON.parse(result.conditionsText).commission.percentageRate).toBe("12.50");
    expect(result.evidenceReferences[0]).toContain(id(10));
  });
});
