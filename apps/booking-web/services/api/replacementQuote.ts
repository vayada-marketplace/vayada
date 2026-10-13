import {
  parsePublicBookingQuote,
  type PublicBookingQuoteRequest,
} from "@vayada/domain-booking/replacement-pricing";
import { deviceTimeOf, observeServerTime, serverNow } from "@/lib/serverClock";
import { ApiError, bookingWebPublic } from "./client";
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
  let raw: unknown;
  try {
    raw = await bookingWebPublic.post<unknown>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/quote`,
      body,
      { headers: { "Idempotency-Key": key }, signal, cache: "no-store" },
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.detail &&
      typeof error.detail === "object" &&
      "code" in error.detail &&
      error.detail.code === "QUOTE_REFRESH_REQUIRED"
    )
      expireCheckoutIdempotencyKeyAt("replacement-quote", identity, new Date().toISOString(), key);
    throw error;
  }
  signal?.throwIfAborted();
  const quote = parsePublicBookingQuote(raw, body);
  if (!quote) throw new Error("The quote could not be verified. Please try again.");
  // A fresh quote was issued just now: it calibrates the server clock, so a device clock that is
  // behind or ahead no longer rejects it. A replay keeps its original, older issue time.
  if (!quote.replayed) observeServerTime(quote.issuedAt);
  expireCheckoutIdempotencyKeyAt(
    "replacement-quote",
    identity,
    new Date(deviceTimeOf(quote.expiresAt)).toISOString(),
    key,
  );
  if (Date.parse(quote.expiresAt) <= serverNow())
    throw new Error("This quote has expired. Please refresh the price.");
  return quote;
}
