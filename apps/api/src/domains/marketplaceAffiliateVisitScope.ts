import { createHash } from "node:crypto";
import type pg from "pg";
import { parseMarketplaceAffiliateOfferTerms } from "@vayada/domain-marketplace";
import { readMarketplaceAffiliateLinkEligibility } from "./marketplaceAffiliateLinkEligibility.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An accepted publication is the only source of destination and attribution-window scope. */
export function parseAffiliateVisitDisclosure(value: unknown) {
  let disclosure: unknown;
  try {
    disclosure = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  if (!disclosure || typeof disclosure !== "object" || Array.isArray(disclosure)) return null;
  const record = disclosure as Record<string, unknown>;
  if (record.contractVersion !== "marketplace-published-affiliate-terms.v1") return null;
  const parsed = parseMarketplaceAffiliateOfferTerms(record.terms);
  if (
    !parsed.ok ||
    !uuid.test(parsed.terms.bookingDestinationId) ||
    parsed.terms.attributionWindowDays > 90
  )
    return null;
  return {
    destinationVersionId: parsed.terms.bookingDestinationId.toLowerCase(),
    attributionWindowDays: parsed.terms.attributionWindowDays,
  };
}

/** Caller owns a READ COMMITTED transaction through capture commit or rollback. */
export async function readMarketplaceAffiliateVisitScope(
  client: pg.PoolClient,
  publicToken: unknown,
): Promise<
  | { status: "unavailable" }
  | {
      status: "eligible";
      linkId: string;
      agreementId: string;
      propertyId: string;
      termsId: string;
      organizationId: string;
      destinationVersionId: string;
      attributionWindowDays: number;
    }
> {
  const link = await readMarketplaceAffiliateLinkEligibility(client, publicToken);
  if (link.status !== "eligible") return { status: "unavailable" };
  const terms = (
    await client.query(
      `SELECT organization_id,disclosure,disclosure_hash
       FROM marketplace.affiliate_published_terms
       WHERE id=$1 AND program_id=$2 AND property_id=$3 FOR SHARE`,
      [link.termsId, link.programId, link.propertyId],
    )
  ).rows[0] as { organization_id: string; disclosure: string; disclosure_hash: string } | undefined;
  if (
    !terms ||
    createHash("sha256").update(terms.disclosure).digest("hex") !== terms.disclosure_hash
  )
    return { status: "unavailable" };
  const accepted = parseAffiliateVisitDisclosure(terms.disclosure);
  if (!accepted) return { status: "unavailable" };
  return {
    status: "eligible",
    linkId: link.linkId,
    agreementId: link.agreementId,
    propertyId: link.propertyId,
    termsId: link.termsId,
    organizationId: terms.organization_id,
    ...accepted,
  };
}
