/** VAY-1501: draft shape only; application services authorize and resolve references. */
export const MARKETPLACE_AFFILIATE_OFFER_TERMS_VERSION =
  "marketplace-affiliate-offer-terms.v1" as const;

export const MARKETPLACE_AFFILIATE_MVP_RULES = {
  participation: "hotel_approval",
  creditScope: "linked_hotel",
  attribution: "last_eligible_click",
  earningEligibility: "verified_completion",
  agreementLifecycle: "independent_of_collaboration",
} as const;

export type MarketplaceAffiliateOfferTerms = Readonly<{
  bookingDestinationId: string;
  financePolicyVersionId: string;
  attributionWindowDays: number;
}>;

export type MarketplaceAffiliateOfferTermsVersion = Readonly<{
  contractVersion: typeof MARKETPLACE_AFFILIATE_OFFER_TERMS_VERSION;
  termsVersionId: string;
  programId: string;
  offerId: string;
  propertyId: string;
  effectiveAt: string;
  terms: MarketplaceAffiliateOfferTerms;
  rules: Readonly<typeof MARKETPLACE_AFFILIATE_MVP_RULES>;
}>;

export type MarketplaceAffiliateOfferTermsParseResult =
  | { ok: true; terms: MarketplaceAffiliateOfferTerms }
  | {
      ok: false;
      code: "invalid_affiliate_offer_terms";
      field: "input" | keyof MarketplaceAffiliateOfferTerms;
    };

const fields = ["bookingDestinationId", "financePolicyVersionId", "attributionWindowDays"] as const;

/** Does not grant publication, validate foreign records or establish earning eligibility. */
export function parseMarketplaceAffiliateOfferTerms(
  input: unknown,
): MarketplaceAffiliateOfferTermsParseResult {
  const invalid = (
    field: "input" | keyof MarketplaceAffiliateOfferTerms,
  ): MarketplaceAffiliateOfferTermsParseResult => ({
    ok: false,
    code: "invalid_affiliate_offer_terms",
    field,
  });
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("input");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !fields.some((field) => field === key))) {
    return invalid("input");
  }
  for (const field of ["bookingDestinationId", "financePolicyVersionId"] as const) {
    const reference = value[field];
    if (
      typeof reference !== "string" ||
      reference.length === 0 ||
      reference.length > 256 ||
      !/^[A-Za-z0-9_-]+$/.test(reference)
    ) {
      return invalid(field);
    }
  }
  const days = value.attributionWindowDays;
  if (
    typeof days !== "number" ||
    !Number.isSafeInteger(days) ||
    days <= 0 ||
    !Number.isSafeInteger(days * 86_400_000)
  ) {
    return invalid("attributionWindowDays");
  }
  return {
    ok: true,
    terms: {
      bookingDestinationId: value.bookingDestinationId as string,
      financePolicyVersionId: value.financePolicyVersionId as string,
      attributionWindowDays: days,
    },
  };
}
