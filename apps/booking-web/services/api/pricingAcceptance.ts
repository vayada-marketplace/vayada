import {
  parsePublicQuoteGuestDisclosure,
  type PublicBookingQuote,
  type PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import {
  expireCheckoutIdempotencyKeyAt,
  getCheckoutIdempotencyKey,
} from "@/lib/storage/bookingDraft";
import { ApiError, bookingWebPublic } from "./client";

export type PricingAcceptanceGuest = Readonly<{
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  countryCode?: string | null;
  arrivalTime?: string | null;
  specialRequests?: string | null;
}>;

export type PricingAcceptanceResult =
  | Readonly<{
      kind: "accepted";
      bookingId: string;
      bookingReference: string;
      acceptanceId: string;
      acceptedAt: string;
      checkedAt: string;
    }>
  | Readonly<{
      kind: "replayed";
      bookingId: string;
      bookingReference: string;
      replayed: true;
    }>;

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const bookingReference = (value: unknown): value is string =>
  typeof value === "string" && /^VAY-[A-Z0-9]{6,32}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function parsePricingAcceptanceResult(value: unknown): PricingAcceptanceResult | null {
  if (
    exact(value, ["kind", "bookingId", "bookingReference", "replayed"]) &&
    value.kind === "replayed" &&
    uuid(value.bookingId) &&
    bookingReference(value.bookingReference) &&
    value.replayed === true
  )
    return structuredClone(value) as PricingAcceptanceResult;
  if (
    exact(value, [
      "kind",
      "bookingId",
      "bookingReference",
      "acceptanceId",
      "acceptedAt",
      "checkedAt",
    ]) &&
    value.kind === "accepted" &&
    uuid(value.bookingId) &&
    bookingReference(value.bookingReference) &&
    uuid(value.acceptanceId) &&
    iso(value.acceptedAt) &&
    iso(value.checkedAt) &&
    value.checkedAt >= value.acceptedAt
  )
    return structuredClone(value) as PricingAcceptanceResult;
  return null;
}

const optional = (value: string | null | undefined) => value?.trim() || null;

/** Builds only the currently supported instant, pay-at-property acceptance.
 * The server re-reads and validates every quote, policy and finance owner. */
export async function acceptPricingQuote(
  slug: string,
  quote: PublicBookingQuote,
  disclosure: PublicQuoteGuestDisclosure,
  guest: PricingAcceptanceGuest,
  signal?: AbortSignal,
): Promise<PricingAcceptanceResult> {
  const verifiedDisclosure = parsePublicQuoteGuestDisclosure(disclosure, quote);
  if (
    quote.acceptanceMode !== "instant" ||
    quote.paymentMethod !== "pay_at_property" ||
    quote.dueNowMinor !== "0" ||
    quote.dueLaterMinor !== quote.totalMinor ||
    !verifiedDisclosure ||
    Date.parse(quote.expiresAt) <= Date.now()
  )
    throw new Error("This price cannot be booked online. Please refresh the price.");

  const normalizedGuest = {
    firstName: guest.firstName.trim(),
    lastName: guest.lastName.trim(),
    email: guest.email.trim().toLowerCase(),
    phone: optional(guest.phone),
    countryCode: optional(guest.countryCode)?.toUpperCase() ?? null,
    arrivalTime: optional(guest.arrivalTime),
    specialRequests: optional(guest.specialRequests),
  };
  const acceptance = {
    accepted: true as const,
    quoteEvidenceId: verifiedDisclosure.quoteEvidenceId,
    guestPolicyEvidenceId: verifiedDisclosure.guestPolicyEvidenceId,
  };
  const identity = JSON.stringify([slug, quote.quoteId, acceptance, normalizedGuest]);
  const requestId = getCheckoutIdempotencyKey("pricing-acceptance", identity);
  const command = {
    version: "booking-quote-acceptance.v1" as const,
    requestId,
    quoteId: quote.quoteId,
    acceptance,
    guest: normalizedGuest,
  };

  let raw: unknown;
  try {
    raw = await bookingWebPublic.post<unknown>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/quotes/${encodeURIComponent(quote.quoteId)}/accept`,
      command,
      { headers: { "Idempotency-Key": requestId }, signal, cache: "no-store" },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      expireCheckoutIdempotencyKeyAt(
        "pricing-acceptance",
        identity,
        new Date().toISOString(),
        requestId,
      );
    throw error;
  }
  signal?.throwIfAborted();
  const result = parsePricingAcceptanceResult(raw);
  if (!result) throw new Error("The booking confirmation could not be verified. Please try again.");
  expireCheckoutIdempotencyKeyAt("pricing-acceptance", identity, quote.expiresAt, requestId);
  return result;
}
