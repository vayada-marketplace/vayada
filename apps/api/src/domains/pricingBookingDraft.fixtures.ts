import { createHash } from "node:crypto";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import {
  bookingQuoteAcceptanceRequirements,
  parseBookingQuoteAcceptanceInput,
} from "./bookingQuoteAcceptanceInput.js";
import type { stagePricingBookingDraft } from "./pricingBookingDraft.js";
type Input = Parameters<typeof stagePricingBookingDraft>[2];
export function pricingDraftFixture(changeQuote?: (quote: Input["current"]["quote"]) => void) {
  const prior = acceptanceFixture(),
    quote = prior.quote_snapshot;
  Object.assign(quote, { paymentMethod: "pay_at_property" });
  Object.assign(quote.evidence, { dueNowMinor: "0", dueLaterMinor: quote.evidence.totalMinor });
  Object.assign(quote.evidence.terms[0], {
    payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
  });
  changeQuote?.(quote);
  const choices = JSON.parse(prior.disclosure_json).choices;
  const disclosure = {
    version: "booking.quote-guest-disclosure.v1" as const,
    quote,
    choices,
    propertyTimeZone: "Europe/Berlin",
  };
  const disclosureJson = JSON.stringify(disclosure),
    policy = {
      propertyId: quote.stay.propertyId,
      sourceRevision: prior.guest_policy_source_revision,
      choices,
      disclosureHash: "sha256:" + createHash("sha256").update(disclosureJson).digest("hex"),
    };
  const requirements = bookingQuoteAcceptanceRequirements(quote, policy)!;
  const command = parseBookingQuoteAcceptanceInput(
    {
      ...prior.acceptance_command,
      acceptance: {
        accepted: true,
        quoteEvidenceId: requirements.quoteEvidenceId,
        guestPolicyEvidenceId: requirements.guestPolicyEvidenceId,
      },
    },
    quote,
    policy,
  )!;
  const scope = {
    propertyId: prior.property_id,
    organizationId: prior.organization_id,
    authorityRevision: "authority-1",
  };
  return {
    bookingId: prior.guest_booking_id,
    publicReference: "VAY-TEST01",
    command,
    // The revalidation owner is mocked; this helper only consumes these fields.
    current: {
      kind: "current_quote_price",
      quote,
      scope,
      sameDay: { propertyTimeZone: "Europe/Berlin" },
    } as unknown as Input["current"],
    disclosure: { ...requirements, disclosure, disclosureJson, checkedAt: prior.accepted_at },
    finance: {
      scope,
      billingPlanSnapshot: "fixed" as const,
      commissionTermsSnapshot: prior.commission_terms_snapshot,
      financeTermsCapturedAt: prior.finance_terms_captured_at,
      validUntil: null,
    },
  } satisfies Input;
}
