import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import { parseBookingQuoteAcceptanceInput } from "./bookingQuoteAcceptanceInput.js";
import { decodeCurrentPricingQuoteRecord } from "./currentPricingQuoteStore.js";
import { persistPricingBookingAddons } from "./persistPricingBookingAddons.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import type { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import type { lockCurrentQuoteGuestDisclosure } from "./currentQuoteGuestDisclosure.js";
import type { lockFinancePricingAcceptanceTerms } from "./financePricingAcceptanceTerms.js";

type Input = {
  current: NonNullable<Awaited<ReturnType<typeof lockCurrentQuoteRevalidation>>>;
  disclosure: NonNullable<Awaited<ReturnType<typeof lockCurrentQuoteGuestDisclosure>>>;
  command: NonNullable<ReturnType<typeof parseBookingQuoteAcceptanceInput>>;
  finance: NonNullable<Awaited<ReturnType<typeof lockFinancePricingAcceptanceTerms>>>;
  bookingId: string;
  publicReference: string;
};
const iso = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

/** Draft/booker staging only, currently pay-at-property. All owner results MUST
 * originate on this same retained READ COMMITTED transaction, never posted scope.
 * Caller owns ID/reference allocation, all remaining writes, final freshness and
 * full rollback on any failure. No accepted receipt, confirmation or side effects. */
export async function stagePricingBookingDraft(client: PoolClient, slug: unknown, input: Input) {
  const fail = (): never => {
    throw new Error("Pricing booking draft is unavailable");
  };
  const { current, disclosure, command, finance, bookingId, publicReference } = input;
  const scope = await lockPublicPricingAuthority(client, slug);
  if (
    !scope ||
    !isDeepStrictEqual(scope, current.scope) ||
    !isDeepStrictEqual(scope, finance.scope) ||
    current.kind !== "current_quote_price" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bookingId) ||
    !/^VAY-[A-Z0-9]{6,32}$/.test(publicReference)
  )
    return fail();
  const row = (
    await client.query(
      "SELECT id,payload FROM booking.pricing_quotes WHERE id=$1 AND property_id=$2 AND organization_id=$3",
      [current.quote.quoteId, scope.propertyId, scope.organizationId],
    )
  ).rows[0];
  const stored = row
    ? decodeCurrentPricingQuoteRecord(row.payload, scope.propertyId, row.id)
    : null;
  if (
    !stored ||
    !isDeepStrictEqual(stored.quote, current.quote) ||
    !isDeepStrictEqual(stored.quote, disclosure.quote)
  )
    return fail();
  const quote = stored.quote;
  let displayed: unknown;
  try {
    displayed = JSON.parse(disclosure.disclosureJson);
  } catch {
    return fail();
  }
  if (
    !isDeepStrictEqual(displayed, disclosure.disclosure) ||
    !isDeepStrictEqual(disclosure.disclosure.quote, quote) ||
    !isDeepStrictEqual(disclosure.disclosure.choices, disclosure.policy.choices) ||
    disclosure.disclosure.propertyTimeZone !== current.sameDay.propertyTimeZone ||
    disclosure.policy.disclosureHash !==
      "sha256:" + createHash("sha256").update(disclosure.disclosureJson).digest("hex")
  )
    return fail();
  const { fingerprint, ...rawCommand } = command;
  void fingerprint;
  const parsed = parseBookingQuoteAcceptanceInput(rawCommand, quote, disclosure.policy);
  if (
    !parsed ||
    !isDeepStrictEqual(parsed, command) ||
    parsed.acceptance.quoteEvidenceId !== disclosure.quoteEvidenceId ||
    parsed.acceptance.guestPolicyEvidenceId !== disclosure.guestPolicyEvidenceId ||
    quote.paymentMethod !== "pay_at_property" ||
    quote.evidence.dueNowMinor !== "0" ||
    quote.evidence.dueLaterMinor !== quote.evidence.totalMinor
  )
    return fail();
  const terms = finance.commissionTermsSnapshot;
  if (
    !["commission", "fixed"].includes(finance.billingPlanSnapshot) ||
    ![
      terms.bookingEngineFeePercent,
      terms.channelManagerFeePercent,
      terms.affiliatePlatformFeePercent,
    ].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) ||
    !iso(terms.financeConfigUpdatedAt) ||
    !iso(finance.financeTermsCapturedAt) ||
    terms.financeConfigUpdatedAt > finance.financeTermsCapturedAt
  )
    return fail();
  const scale = pricingCurrencyScale(quote.stay.currency);
  if (scale === null) return fail();
  const numerator = BigInt(quote.evidence.totalMinor) * 100n,
    unit = 10n ** BigInt(scale);
  if (numerator % unit !== 0n || numerator / unit > 999999999999999n) return fail();
  const cents = numerator / unit,
    amount = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  const guest = parsed.guest;
  await client.query(
    `WITH draft AS (
    INSERT INTO booking.guest_bookings(id,property_id,public_reference,source_system,booking_channel,direct_booking_source,
      lifecycle_status,payment_status,expected_payment_method,check_in,check_out,adults,children,room_count,currency,
      total_amount,balance_amount,booking_metadata,billing_plan_snapshot,commission_terms_snapshot,finance_terms_captured_at)
    VALUES($1,$2,$3,'booking','direct','booking_engine','draft','unpaid','pay_at_property',$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14)
    RETURNING id
  ) INSERT INTO booking.booking_guests(guest_booking_id,guest_role,first_name,last_name,email,phone,country_code,arrival_time,special_requests)
    SELECT id,'booker',$15,$16,$17,$18,$19,$20,$21 FROM draft`,
    [
      bookingId,
      scope.propertyId,
      publicReference,
      quote.stay.checkIn,
      quote.stay.checkOut,
      quote.stay.rooms.reduce((n, room) => n + room.guests.adults, 0),
      quote.stay.rooms.reduce((n, room) => n + room.guests.childAgesAtCheckIn.length, 0),
      quote.stay.rooms.length,
      quote.stay.currency,
      amount,
      {
        targetSource: "pricing_quote_draft",
        pricingQuoteId: quote.quoteId,
        requestFingerprint: parsed.fingerprint,
        paymentMethod: quote.paymentMethod,
        pricingSelections: quote.stay.rooms,
      },
      finance.billingPlanSnapshot,
      terms,
      finance.financeTermsCapturedAt,
      guest.firstName,
      guest.lastName,
      guest.email,
      guest.phone,
      guest.countryCode,
      guest.arrivalTime,
      guest.specialRequests,
    ],
  );
  await persistPricingBookingAddons(client, slug, current, bookingId);
  if (!isDeepStrictEqual(await lockPublicPricingAuthority(client, slug), scope)) return fail();
  return { bookingId, publicReference };
}
