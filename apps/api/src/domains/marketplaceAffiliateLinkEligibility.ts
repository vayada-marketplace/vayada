import type pg from "pg";
import { parseMarketplaceAffiliateLink } from "@vayada/domain-marketplace";
import { readMarketplaceAffiliateAgreementLifecycle } from "./marketplaceAffiliateAgreementLifecycle.js";

/** Resolve in a READ COMMITTED click transaction; retain the activation lock until capture commits. */
export async function readMarketplaceAffiliateLinkEligibility(
  client: pg.PoolClient,
  publicToken: unknown,
): Promise<
  | { status: "unavailable" }
  | {
      status: "eligible";
      linkId: string;
      agreementId: string;
      activationId: string;
      propertyId: string;
      termsId: string;
    }
> {
  // SAVEPOINT fails outside an explicit transaction, where row locks would be lost.
  await client.query("SAVEPOINT affiliate_link_eligibility_guard");
  await client.query("RELEASE SAVEPOINT affiliate_link_eligibility_guard");
  const isolation = (await client.query("SHOW transaction_isolation")).rows[0]
    ?.transaction_isolation;
  if (isolation !== "read committed")
    throw new Error("Affiliate link eligibility requires READ COMMITTED");
  const parsed = parseMarketplaceAffiliateLink(publicToken);
  if (!parsed.ok) return { status: "unavailable" };
  const link = (
    await client.query(
      `SELECT l.id,l.agreement_id,l.activation_id,l.property_id,a.terms_id
       FROM marketplace.affiliate_links l
       JOIN marketplace.affiliate_agreement_activations a
         ON a.id=l.activation_id AND a.agreement_id=l.agreement_id
       WHERE l.public_token=$1`,
      [parsed.publicToken],
    )
  ).rows[0];
  if (!link) return { status: "unavailable" };
  const lifecycle = await readMarketplaceAffiliateAgreementLifecycle(client, link.agreement_id);
  if (lifecycle.status !== "active") return { status: "unavailable" };
  return {
    status: "eligible",
    linkId: link.id,
    agreementId: link.agreement_id,
    activationId: link.activation_id,
    propertyId: link.property_id,
    termsId: link.terms_id,
  };
}
