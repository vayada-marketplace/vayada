import { PMS_SUPPORTED_PRICING_CURRENCY_CODES_V1 } from "./pmsPricingCurrencyCapabilities.js";
import { resolvePgFinanceAffiliatePercentagePolicy } from "./financeAffiliatePercentagePolicyResolver.js";
import type { AffiliatePublicationCommercialConditionsPort } from "./marketplaceAffiliatePublicationPrerequisites.js";

const supportedCurrencies = new Set<string>(PMS_SUPPORTED_PRICING_CURRENCY_CODES_V1);

/** Finance-owned creator-visible terms. The publication transaction preserves these exact bytes. */
export const readFinanceAffiliateCommercialConditions: AffiliatePublicationCommercialConditionsPort =
  async (client, scope) => {
    const commission = await resolvePgFinanceAffiliatePercentagePolicy(client, {
      propertyId: scope.propertyId,
      policyVersionId: scope.terms.financePolicyVersionId,
      organizationId: scope.organizationId,
    });
    if (commission.status !== "available")
      return { status: "blocked", reasons: ["commission_policy_unavailable"] };

    const result = await client.query(
      `SELECT currency::text, pricing_currency_revision::text
       FROM pms.property_pricing_settings
       WHERE property_id=$1 FOR SHARE`,
      [scope.propertyId],
    );
    const row = result.rows[0];
    if (!row) return { status: "blocked", reasons: ["settlement_currency_unavailable"] };
    const currency: unknown = row.currency;
    const revision: unknown = row.pricing_currency_revision;
    if (
      typeof currency !== "string" ||
      !supportedCurrencies.has(currency) ||
      typeof revision !== "string" ||
      !/^[1-9]\d*$/.test(revision)
    )
      return { status: "blocked", reasons: ["settlement_currency_unsupported"] };

    return {
      status: "ready",
      attributionPolicyVersion: "last-eligible-click.v1",
      evidenceReferences: [
        `finance:affiliate-percentage-policy:${commission.policyVersionId}`,
        `pms:pricing-currency:${scope.propertyId}:${revision}`,
      ],
      conditionsText: JSON.stringify({
        contractVersion: "finance-affiliate-commercial-conditions.v1",
        commission: {
          percentageRate: commission.policy.percentageRate,
          revenueBasis: commission.policy.revenueBasis,
          eligibility: commission.policy.eligibility,
          cancellationOrNoShow: "no_commission_for_unconsumed_stay",
          refundAdjustment: "accommodation_component_only",
          eligibilityHoldDays: 14,
        },
        settlement: {
          currency,
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
      }),
    };
  };
