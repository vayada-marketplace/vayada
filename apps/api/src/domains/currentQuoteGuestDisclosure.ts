import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { lockCurrentBookingGuestChoices } from "./bookingGuestPolicyRepository.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { bookingQuoteAcceptanceRequirements } from "./bookingQuoteAcceptanceInput.js";

/** Internal presentation/acceptance evidence. Caller owns READ COMMITTED and all locks.
 * Revalidate after the guest-owner wait. No booking, inventory or payment mutation. */
export async function lockCurrentQuoteGuestDisclosure(
  client: PoolClient,
  slug: unknown,
  quoteId: unknown,
) {
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope) return null;
  const guest = await lockCurrentBookingGuestChoices(
    client,
    scope.propertyId,
    scope.organizationId,
  );
  if (!guest) return null;
  const current = await lockCurrentQuoteRevalidation(client, slug, quoteId);
  if (
    !current ||
    current.scope.propertyId !== scope.propertyId ||
    current.scope.organizationId !== scope.organizationId ||
    guest.propertyId !== scope.propertyId
  )
    return null;
  // Only the replacement quote supplies amounts and rate terms. The former bundle's
  // rate disclosures, currency, timezone and pricing fingerprints are deliberately absent.
  const disclosure = {
    version: "booking.quote-guest-disclosure.v1" as const,
    quote: current.quote,
    choices: guest.choices,
    propertyTimeZone: current.sameDay.propertyTimeZone,
  };
  const disclosureJson = JSON.stringify(disclosure);
  const policy = {
    ...guest,
    disclosureHash: "sha256:" + createHash("sha256").update(disclosureJson).digest("hex"),
  };
  const requirements = bookingQuoteAcceptanceRequirements(current.quote, policy);
  if (!requirements) return null;
  return {
    ...requirements,
    disclosure: structuredClone(disclosure),
    disclosureJson,
    checkedAt: current.checkedAt,
  };
}
