import { readBookingAffiliateDestinations } from "./bookingAffiliateDestinationRepository.js";
import {
  parseMarketplaceAffiliateOfferTerms,
  type MarketplaceAffiliateOfferTerms,
} from "@vayada/domain-marketplace";
import pg from "pg";
import type { FinanceAffiliatePolicyResolution } from "@vayada/domain-finance";
import { resolvePgFinanceAffiliatePercentagePolicy } from "./financeAffiliatePercentagePolicyResolver.js";
import { saveMarketplaceAffiliateDraft } from "./marketplaceAffiliateDraftCommand.js";

export type AffiliateDraftRead = {
  revision: number;
  draft: {
    id: string;
    terms: MarketplaceAffiliateOfferTerms;
    commission: FinanceAffiliatePolicyResolution;
    destination: Awaited<ReturnType<typeof readBookingAffiliateDestinations>>[number] | null;
  } | null;
};
export type AffiliateDraftRepository = {
  save(
    input: Parameters<typeof saveMarketplaceAffiliateDraft>[1],
  ): ReturnType<typeof saveMarketplaceAffiliateDraft>;
  read(
    organizationId: string,
    propertyId: string,
    offerId: string,
  ): Promise<AffiliateDraftRead | null>;
  close(): Promise<void>;
};

export function createPgMarketplaceAffiliateDraftRepository(
  connectionString: string,
): AffiliateDraftRepository {
  const pool = new pg.Pool({ connectionString, max: 3 });
  return {
    save: (input) => saveMarketplaceAffiliateDraft(pool, input),
    async read(organizationId, propertyId, offerId) {
      const result = await pool.query(
        `SELECT draft.id, draft.revision, draft.booking_destination_id, draft.finance_policy_version_id,
                draft.attribution_window_days
         FROM marketplace.marketplace_offers offer
         LEFT JOIN LATERAL (
           SELECT * FROM marketplace.affiliate_offer_terms_drafts
           WHERE offer_id=offer.id AND property_id=offer.property_id AND organization_id=offer.organization_id
           ORDER BY revision DESC LIMIT 1
         ) draft ON true
         WHERE offer.id=$1 AND offer.property_id=$2 AND offer.organization_id=$3
           AND offer.offer_status NOT IN ('archived','suspended')`,
        [offerId, propertyId, organizationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (!row.id) return { revision: 0, draft: null };
      const parsed = parseMarketplaceAffiliateOfferTerms({
        bookingDestinationId: row.booking_destination_id,
        financePolicyVersionId: row.finance_policy_version_id,
        attributionWindowDays: row.attribution_window_days,
      });
      if (!parsed.ok) throw new Error("Stored affiliate draft is invalid");
      const commission = await resolvePgFinanceAffiliatePercentagePolicy(pool, {
        propertyId,
        policyVersionId: parsed.terms.financePolicyVersionId,
      });
      const destinations = await readBookingAffiliateDestinations(
        pool,
        propertyId,
        organizationId,
        parsed.terms.bookingDestinationId,
      );
      return {
        revision: row.revision,
        draft: {
          id: row.id,
          terms: parsed.terms,
          commission,
          destination: destinations[0] ?? null,
        },
      };
    },
    close: () => pool.end(),
  };
}
