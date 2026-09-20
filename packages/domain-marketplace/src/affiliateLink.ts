export const MARKETPLACE_AFFILIATE_LINK_CONTRACT_VERSION = "marketplace-affiliate-link.v1" as const;

export const MARKETPLACE_AFFILIATE_LINK_PATH = "/r" as const;

export type MarketplaceAffiliateLink = Readonly<{
  contractVersion: typeof MARKETPLACE_AFFILIATE_LINK_CONTRACT_VERSION;
  linkId: string;
  agreementId: string;
  propertyId: string;
  publicToken: string;
  createdAt: string;
}>;

export type MarketplaceAffiliateLinkParseResult =
  | { ok: true; publicToken: string; campaignLabel: string | null }
  | { ok: false; code: "invalid_affiliate_link"; field: "publicToken" | "campaignLabel" };

export type MarketplaceAffiliateSharePathResult =
  | { ok: true; publicToken: string; campaignLabel: string | null; path: string }
  | { ok: false; code: "invalid_affiliate_link"; field: "publicToken" | "campaignLabel" };

const publicTokenPattern = /^va_[A-Za-z0-9_-]{22}$/;
const campaignLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

/**
 * Parses public routing data only. The token is never authority: Marketplace must
 * resolve its persisted agreement and property binding before redirect or capture.
 */
export function parseMarketplaceAffiliateLink(
  publicToken: unknown,
  campaignLabel?: unknown,
): MarketplaceAffiliateLinkParseResult {
  if (typeof publicToken !== "string" || !publicTokenPattern.test(publicToken)) {
    return { ok: false, code: "invalid_affiliate_link", field: "publicToken" };
  }
  if (campaignLabel === undefined || campaignLabel === null) {
    return { ok: true, publicToken, campaignLabel: null };
  }
  if (typeof campaignLabel !== "string" || !campaignLabelPattern.test(campaignLabel)) {
    return { ok: false, code: "invalid_affiliate_link", field: "campaignLabel" };
  }
  return { ok: true, publicToken, campaignLabel };
}

/** Builds a relative public path so deployment origin remains server-owned configuration. */
export function buildMarketplaceAffiliateSharePath(
  publicToken: unknown,
  campaignLabel?: unknown,
): MarketplaceAffiliateSharePathResult {
  const parsed = parseMarketplaceAffiliateLink(publicToken, campaignLabel);
  if (!parsed.ok) return parsed;
  return {
    ...parsed,
    path: `${MARKETPLACE_AFFILIATE_LINK_PATH}/${parsed.publicToken}${
      parsed.campaignLabel === null ? "" : `?campaign=${parsed.campaignLabel}`
    }`,
  };
}
