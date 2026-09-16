import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseStoredPricingQuote } from "@vayada/domain-booking";
import { parsePmsInventoryReservationBundle, pricingKeys, pricingObject } from "@vayada/domain-pms";
import { parseBookingQuoteAcceptanceInput } from "./bookingQuoteAcceptanceInput.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** Decode a historical acceptance row, not current authorization or a completed
 * replay. Repository callers must verify booking/receipt links under current scope.
 * Never apply today's prices, guest policies or clock to historical consent. */
export function decodePricingAcceptanceHistory(
  input: unknown,
  propertyId: string,
  organizationId: string,
) {
  if (
    !pricingObject(input) ||
    input.property_id !== propertyId ||
    input.organization_id !== organizationId ||
    ![
      input.id,
      input.property_id,
      input.organization_id,
      input.pricing_quote_id,
      input.guest_booking_id,
      input.command_receipt_id,
    ].every(uuid) ||
    !iso(input.accepted_at) ||
    !iso(input.finance_terms_captured_at) ||
    input.finance_terms_captured_at > input.accepted_at ||
    typeof input.disclosure_json !== "string"
  )
    return null;
  const quote = parseStoredPricingQuote(input.quote_snapshot);
  if (
    !quote ||
    quote.quoteId !== input.pricing_quote_id ||
    quote.stay.propertyId !== propertyId ||
    input.accepted_at < quote.evidence.issuedAt ||
    input.accepted_at >= quote.evidence.expiresAt
  )
    return null;
  let disclosure: unknown;
  try {
    disclosure = JSON.parse(input.disclosure_json);
  } catch {
    return null;
  }
  if (
    !pricingObject(disclosure) ||
    !pricingKeys(disclosure, ["version", "quote", "choices", "propertyTimeZone"]) ||
    disclosure.version !== "booking.quote-guest-disclosure.v1" ||
    !isDeepStrictEqual(disclosure.quote, input.quote_snapshot) ||
    typeof disclosure.propertyTimeZone !== "string" ||
    !disclosure.propertyTimeZone.length ||
    input.disclosure_hash !== `sha256:${hash(input.disclosure_json)}`
  )
    return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: disclosure.propertyTimeZone });
  } catch {
    return null;
  }
  const policy = {
    propertyId,
    sourceRevision: input.guest_policy_source_revision,
    disclosureHash: input.disclosure_hash,
    choices: disclosure.choices,
  };
  const parsed = parseBookingQuoteAcceptanceInput(input.acceptance_command, quote, policy);
  if (!parsed) return null;
  const { fingerprint, ...command } = parsed;
  if (
    !isDeepStrictEqual(command, input.acceptance_command) ||
    command.requestId !== input.request_id ||
    input.key_hash !== hash(command.requestId) ||
    input.request_fingerprint_hash !== fingerprint.slice(7)
  )
    return null;
  const reservation = parsePmsInventoryReservationBundle(input.inventory_reservation_bundle);
  const finance = input.commission_terms_snapshot;
  if (
    !reservation ||
    !isDeepStrictEqual(reservation, input.inventory_reservation_bundle) ||
    !["commission", "fixed"].includes(input.billing_plan_snapshot as string) ||
    !pricingObject(finance) ||
    !pricingKeys(finance, [
      "bookingEngineFeePercent",
      "channelManagerFeePercent",
      "affiliatePlatformFeePercent",
      "financeConfigUpdatedAt",
    ]) ||
    ![
      finance.bookingEngineFeePercent,
      finance.channelManagerFeePercent,
      finance.affiliatePlatformFeePercent,
    ].every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100,
    ) ||
    !iso(finance.financeConfigUpdatedAt) ||
    finance.financeConfigUpdatedAt > input.finance_terms_captured_at
  )
    return null;
  return {
    id: input.id as string,
    propertyId,
    organizationId,
    bookingId: input.guest_booking_id as string,
    commandReceiptId: input.command_receipt_id as string,
    quote,
    command,
    fingerprint,
    policy,
    disclosureJson: input.disclosure_json,
    propertyTimeZone: disclosure.propertyTimeZone,
    reservation,
    billingPlan: input.billing_plan_snapshot as "commission" | "fixed",
    commissionTerms: structuredClone(finance),
    financeTermsCapturedAt: input.finance_terms_captured_at,
    acceptedAt: input.accepted_at,
  };
}
