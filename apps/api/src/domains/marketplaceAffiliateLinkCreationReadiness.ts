import { createHash } from "node:crypto";
import type { AffiliateLinkCreationReadiness } from "./marketplaceAffiliateLinkCreation.js";
import { readNativeAffiliateDestinationSafety } from "./bookingAffiliateNativeDestinationSafety.js";
import { parseAffiliateVisitDisclosure } from "./marketplaceAffiliateVisitScope.js";

/** Rechecks the activated terms and their exact native Booking destination. */
export const readMarketplaceAffiliateLinkCreationReadiness: AffiliateLinkCreationReadiness = async (
  client,
  scope,
) => {
  const terms = (
    await client.query(
      `SELECT terms.organization_id,terms.disclosure,terms.disclosure_hash
         FROM marketplace.affiliate_agreement_activations activation
         JOIN marketplace.affiliate_published_terms terms ON terms.id=activation.terms_id
           AND terms.program_id=activation.program_id AND terms.property_id=$3
         WHERE activation.id=$1 AND activation.agreement_id=$2 AND activation.terms_id=$4
           AND activation.program_id=$5
         FOR SHARE OF activation,terms`,
      [scope.activationId, scope.agreementId, scope.propertyId, scope.termsId, scope.programId],
    )
  ).rows[0] as { organization_id: string; disclosure: string; disclosure_hash: string } | undefined;
  if (
    !terms ||
    createHash("sha256").update(terms.disclosure).digest("hex") !== terms.disclosure_hash
  )
    return { status: "blocked", reasons: ["published_terms_unavailable"] };
  const disclosure = parseAffiliateVisitDisclosure(terms.disclosure);
  if (!disclosure) return { status: "blocked", reasons: ["published_terms_unavailable"] };
  const safety = await readNativeAffiliateDestinationSafety(client, {
    propertyId: scope.propertyId,
    organizationId: terms.organization_id,
    destinationVersionId: disclosure.destinationVersionId,
  });
  return safety.status === "approved"
    ? { status: "ready", scope }
    : { status: "blocked", reasons: ["destination_unavailable"] };
};
