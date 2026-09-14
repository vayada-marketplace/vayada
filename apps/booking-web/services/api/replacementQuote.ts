import {
  parsePublicBookingQuote,
  type PublicBookingQuoteRequest,
} from "@vayada/domain-booking/replacement-pricing";
import { bookingWebPublic } from "./client";
import {
  expireCheckoutIdempotencyKeyAt,
  getCheckoutIdempotencyKey,
} from "@/lib/storage/bookingDraft";

/** Requires actual age-aware offer selection. No conversion from legacy count-only requests. */
export async function requestReplacementQuote(
  slug: string,
  request: PublicBookingQuoteRequest,
  signal?: AbortSignal,
) {
  const body = structuredClone(request);
  const identity = JSON.stringify([slug, body]);
  const key = getCheckoutIdempotencyKey("replacement-quote", identity);
  const raw = await bookingWebPublic.post<unknown>(
    `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/quote`,
    body,
    { headers: { "Idempotency-Key": key }, signal, cache: "no-store" },
  );
  signal?.throwIfAborted();
  const quote = parsePublicBookingQuote(raw, body);
  if (!quote) throw new Error("The quote could not be verified. Please try again.");
  if (Date.parse(quote.issuedAt) > Date.now())
    throw new Error("The quote time could not be verified. Please check your device clock.");
  expireCheckoutIdempotencyKeyAt("replacement-quote", identity, quote.expiresAt, key);
  if (Date.parse(quote.expiresAt) <= Date.now())
    throw new Error("This quote has expired. Please refresh the price.");
  return quote;
}
