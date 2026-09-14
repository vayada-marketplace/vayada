import { createHash } from "node:crypto";
import { parseBookingGuestPolicyChoices, parseStoredPricingQuote } from "@vayada/domain-booking";
import { pricingKeys, pricingObject } from "@vayada/domain-pms";

const digest = (value: unknown) =>
  "sha256:" +
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        pricingObject(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest("hex");
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
const nullableText = (value: unknown, max: number) => value === null || text(value, max);

/** Presentation identity only. The caller must obtain this policy from its
 * authorized current owner under the acceptance transaction, not from the guest.
 * Do not supply legacy pricing-derived disclosures as replacement policy evidence. */
export function bookingQuoteAcceptanceRequirements(quoteInput: unknown, policyInput: unknown) {
  const quote = parseStoredPricingQuote(quoteInput);
  if (
    !quote ||
    !pricingObject(policyInput) ||
    !pricingKeys(policyInput, ["propertyId", "sourceRevision", "disclosureHash", "choices"]) ||
    policyInput.propertyId !== quote.stay.propertyId ||
    !text(policyInput.sourceRevision, 200) ||
    policyInput.sourceRevision !== policyInput.sourceRevision.trim() ||
    typeof policyInput.disclosureHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(policyInput.disclosureHash)
  )
    return null;
  const choices = parseBookingGuestPolicyChoices(policyInput.choices);
  if (!choices) return null;
  return {
    quote,
    policy: {
      propertyId: quote.stay.propertyId,
      sourceRevision: policyInput.sourceRevision,
      disclosureHash: policyInput.disclosureHash,
      choices,
    },
    quoteEvidenceId: digest(quote),
    guestPolicyEvidenceId: digest({ ...policyInput, choices }),
  };
}

/** Pure command validation, not public authorization, freshness or booking acceptance.
 * No client-supplied amounts, occupancy or owner scope are accepted. */
export function parseBookingQuoteAcceptanceInput(
  input: unknown,
  quoteInput: unknown,
  policyInput: unknown,
) {
  const requirements = bookingQuoteAcceptanceRequirements(quoteInput, policyInput);
  if (
    !requirements ||
    !pricingObject(input) ||
    !pricingKeys(input, ["version", "requestId", "quoteId", "acceptance", "guest"]) ||
    input.version !== "booking-quote-acceptance.v1" ||
    !text(input.requestId, 200) ||
    input.requestId !== input.requestId.trim() ||
    input.quoteId !== requirements.quote.quoteId ||
    !pricingObject(input.acceptance) ||
    !pricingKeys(input.acceptance, ["accepted", "quoteEvidenceId", "guestPolicyEvidenceId"]) ||
    input.acceptance.accepted !== true ||
    input.acceptance.quoteEvidenceId !== requirements.quoteEvidenceId ||
    input.acceptance.guestPolicyEvidenceId !== requirements.guestPolicyEvidenceId ||
    !pricingObject(input.guest) ||
    !pricingKeys(input.guest, [
      "firstName",
      "lastName",
      "email",
      "phone",
      "countryCode",
      "arrivalTime",
      "specialRequests",
    ])
  )
    return null;
  const guest = input.guest,
    policy = requirements.policy.choices;
  if (
    !text(guest.firstName, 100) ||
    !text(guest.lastName, 100) ||
    !text(guest.email, 254) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email.trim()) ||
    !nullableText(guest.phone, 64) ||
    (policy.phoneRequired && guest.phone === null) ||
    !(
      guest.countryCode === null ||
      (typeof guest.countryCode === "string" && /^[A-Z]{2}$/.test(guest.countryCode))
    ) ||
    !(
      guest.arrivalTime === null ||
      (policy.arrivalTimeEnabled &&
        typeof guest.arrivalTime === "string" &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(guest.arrivalTime))
    ) ||
    !(
      guest.specialRequests === null ||
      (policy.specialRequestsEnabled &&
        typeof guest.specialRequests === "string" &&
        guest.specialRequests.trim().length > 0 &&
        guest.specialRequests.length <= 2000 &&
        !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(guest.specialRequests))
    )
  )
    return null;
  for (const room of requirements.quote.stay.rooms) {
    if (
      (!policy.childrenEnabled && room.guests.childAgesAtCheckIn.length > 0) ||
      room.guests.childAgesAtCheckIn.some(
        (age) => policy.adultAgeThreshold === null || age >= policy.adultAgeThreshold,
      )
    )
      return null;
  }
  const normalized = {
    version: "booking-quote-acceptance.v1" as const,
    requestId: input.requestId,
    quoteId: input.quoteId,
    acceptance: {
      accepted: true as const,
      quoteEvidenceId: requirements.quoteEvidenceId,
      guestPolicyEvidenceId: requirements.guestPolicyEvidenceId,
    },
    guest: {
      firstName: guest.firstName.trim(),
      lastName: guest.lastName.trim(),
      email: guest.email.trim().toLowerCase(),
      phone: guest.phone === null ? null : (guest.phone as string).trim(),
      countryCode: guest.countryCode as string | null,
      arrivalTime: guest.arrivalTime as string | null,
      specialRequests:
        guest.specialRequests === null ? null : (guest.specialRequests as string).trim(),
    },
  };
  return { ...normalized, fingerprint: digest({ ...normalized, requestId: undefined }) };
}
