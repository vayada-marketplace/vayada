/**
 * The old public pricing model (offers, calendar, checkout quote snapshots) is retired
 * (VAY-1543 slice C.2). Guests price and book through the room-and-price flow instead:
 * GET /hotels/:slug/pricing-offers, POST /hotels/:slug/bookings/quote and
 * POST /hotels/:slug/bookings/quotes/:quoteId/accept.
 */
export const PRICING_RETIRED_MESSAGE =
  "The old booking flow has been retired. Price and book through the room-and-price flow: " +
  "GET /api/booking-web/hotels/{slug}/pricing-offers, POST /api/booking-web/hotels/{slug}/bookings/quote, " +
  "then POST /api/booking-web/hotels/{slug}/bookings/quotes/{quoteId}/accept.";

export function pricingRetiredError(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(PRICING_RETIRED_MESSAGE), {
    statusCode: 410,
    code: "PRICING_RETIRED",
  });
}
