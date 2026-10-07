import { parseMarketplaceAffiliateOfferTerms } from "@vayada/domain-marketplace";

import { readBookingAffiliateDestinations } from "./bookingAffiliateDestinationRepository.js";
import type { AffiliateAgreementActivationReadiness } from "./marketplaceAffiliateAgreementActivation.js";
import type { AffiliatePublicationPrerequisites } from "./marketplaceAffiliatePublication.js";

/** Rechecks the exact published version through the same Finance and Booking gates as publication. */
export function createAffiliateAgreementActivationReadiness(
  prerequisites: AffiliatePublicationPrerequisites,
): AffiliateAgreementActivationReadiness {
  return async (client, scope) => {
    const row = (
      await client.query<{
        source_draft_id: string;
        disclosure: string;
        attribution_policy_version: string;
      }>(
        `SELECT terms.source_draft_id,terms.disclosure,terms.attribution_policy_version
         FROM marketplace.affiliate_published_terms terms
         WHERE terms.id=$1 AND terms.program_id=$2 AND terms.offer_id=$3
           AND terms.property_id=$4 AND terms.organization_id=$5
           AND NOT EXISTS (
             SELECT 1 FROM marketplace.affiliate_published_terms newer
             WHERE newer.program_id=terms.program_id AND newer.effective_at<=clock_timestamp()
               AND (newer.effective_at,newer.recorded_at,newer.id)>
                   (terms.effective_at,terms.recorded_at,terms.id)
           )
         FOR SHARE OF terms`,
        [
          scope.termsId,
          scope.programId,
          scope.offerId,
          scope.propertyId,
          scope.hotelOrganizationId,
        ],
      )
    ).rows[0];
    if (!row) return { status: "blocked", reasons: ["enrollment_closed"] };

    const disclosure = readDisclosure(row.disclosure);
    if (!disclosure) return { status: "blocked", reasons: ["published_terms_invalid"] };
    const [destination] = await readBookingAffiliateDestinations(
      client,
      scope.propertyId,
      scope.hotelOrganizationId,
      disclosure.terms.bookingDestinationId,
    );
    if (!destination) return { status: "blocked", reasons: ["destination_unavailable"] };
    const publicationScope = {
      propertyId: scope.propertyId,
      organizationId: scope.hotelOrganizationId,
      offerId: scope.offerId,
      draftId: row.source_draft_id,
      terms: disclosure.terms,
    };
    const proof = await prerequisites(client, {
      ...publicationScope,
    });
    if (proof.status === "blocked") return proof;
    if (
      proof.scope.propertyId !== publicationScope.propertyId ||
      proof.scope.organizationId !== publicationScope.organizationId ||
      proof.scope.offerId !== publicationScope.offerId ||
      proof.scope.draftId !== publicationScope.draftId ||
      proof.scope.terms.bookingDestinationId !== publicationScope.terms.bookingDestinationId ||
      proof.scope.terms.financePolicyVersionId !== publicationScope.terms.financePolicyVersionId ||
      proof.scope.terms.attributionWindowDays !== publicationScope.terms.attributionWindowDays
    )
      throw new Error("Invalid activation prerequisite proof");
    if (
      proof.conditionsText !== disclosure.conditionsText ||
      proof.attributionPolicyVersion !== row.attribution_policy_version
    )
      return { status: "blocked", reasons: ["published_conditions_changed"] };
    return {
      status: "ready",
      scope,
      enrollmentOpen: true,
      evidenceReferences: proof.evidenceReferences,
    };
  };
}

function readDisclosure(value: string) {
  try {
    const disclosure: unknown = JSON.parse(value);
    if (!disclosure || typeof disclosure !== "object" || Array.isArray(disclosure)) return null;
    const record = disclosure as Record<string, unknown>;
    const terms = parseMarketplaceAffiliateOfferTerms(record.terms);
    return terms.ok && typeof record.conditionsText === "string" && record.conditionsText.trim()
      ? { terms: terms.terms, conditionsText: record.conditionsText }
      : null;
  } catch {
    return null;
  }
}
