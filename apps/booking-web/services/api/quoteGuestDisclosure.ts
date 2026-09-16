import {
  parsePublicQuoteGuestDisclosure,
  type PublicBookingQuote,
} from "@vayada/domain-booking/replacement-pricing";
import { bookingWebPublic } from "./client";

/** The caller retires this presentation on selection/quote changes and expiry. */
export async function getQuoteGuestDisclosure(
  slug: string,
  quote: PublicBookingQuote,
  signal?: AbortSignal,
) {
  const expected = structuredClone(quote);
  const raw = await bookingWebPublic.get<unknown>(
    `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/quotes/${encodeURIComponent(expected.quoteId)}/guest-disclosure`,
    { signal, cache: "no-store" },
  );
  signal?.throwIfAborted();
  const disclosure = parsePublicQuoteGuestDisclosure(raw, expected);
  if (
    !disclosure ||
    Date.parse(disclosure.checkedAt) > Date.now() ||
    Date.parse(disclosure.expiresAt) <= Date.now()
  )
    throw new Error("Guest policies could not be verified. Refresh your price and try again.");
  return disclosure;
}
