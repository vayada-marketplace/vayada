import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import type { FastifyRequest } from "fastify";
import { parsePublicPricingSelection } from "@vayada/domain-booking";
import { pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { createCurrentPricingQuoteStore } from "../domains/currentPricingQuoteStore.js";
import { PricingStorageError } from "../domains/replacementPricingStore.js";

const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
const validKey = (key: unknown): key is string =>
  typeof key === "string" && /^[\x21-\x7e]{1,200}$/.test(key) && !key.includes(",");

export function requirePublicQuoteKey(request: FastifyRequest): string {
  const count = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const key = request.headers["idempotency-key"];
  if (count !== 1 || !validKey(key)) throw httpError(400, "A single Idempotency-Key is required.");
  return key;
}

/** Public DTO boundary. Private calculation/provenance never leaves the quote store. */
export function createReplacementBookingQuoteIssuer(
  store: Pick<ReturnType<typeof createCurrentPricingQuoteStore>, "issue">,
) {
  return async (slug: string, input: unknown, requestId: unknown, signal?: AbortSignal) => {
    if (
      !validKey(requestId) ||
      !pricingObject(input) ||
      !pricingKeys(input, ["version", "selection", "paymentMethod"]) ||
      input.version !== "public-booking-quote-request.v1" ||
      !["card", "pay_at_property"].includes(input.paymentMethod as string)
    )
      throw httpError(400, "Invalid quote request.");
    const selection = parsePublicPricingSelection(input.selection);
    if (!selection) throw httpError(400, "Invalid quote selection.");
    try {
      const { quote, replayed } = await store.issue(
        slug,
        {
          requestId,
          selection,
          paymentMethod: input.paymentMethod,
        },
        signal,
      );
      if (quote.acceptanceMode !== "instant" && quote.acceptanceMode !== "request")
        throw new PricingStorageError("stale");
      const evidence = quote.evidence;
      return {
        version: "public-booking-quote.v1",
        quoteId: quote.quoteId,
        replayed,
        checkIn: quote.stay.checkIn,
        checkOut: quote.stay.checkOut,
        currency: quote.stay.currency,
        paymentMethod: quote.paymentMethod,
        acceptanceMode: quote.acceptanceMode,
        issuedAt: evidence.issuedAt,
        expiresAt: evidence.expiresAt,
        totalMinor: evidence.totalMinor,
        dueNowMinor: evidence.dueNowMinor,
        dueLaterMinor: evidence.dueLaterMinor,
        lines: evidence.lines.map(({ kind, selectionId, amountMinor }) => ({
          kind,
          selectionId,
          amountMinor,
        })),
        rooms: quote.stay.rooms.map((room) => {
          const terms = evidence.terms.find(
            (t) => t.roomTypeId === room.roomTypeId && t.offerId === room.offerId,
          )!;
          const priced = quote.rooms.find((r) => r.selectionId === room.selectionId)!;
          return {
            selectionId: room.selectionId,
            mealPlan: priced.mealPlan,
            cancellation: structuredClone(terms.cancellation),
            payment: structuredClone(terms.payment),
          };
        }),
      } satisfies PublicBookingQuote;
    } catch (error) {
      if (!(error instanceof PricingStorageError))
        throw Object.assign(new Error("Quote temporarily unavailable.", { cause: error }), {
          statusCode: 503,
        });
      if (error.code === "invalid") throw httpError(400, "Invalid quote request.");
      if (error.code === "idempotency_conflict")
        throw httpError(409, "Quote request changed. Use a new Idempotency-Key.");
      if (error.code === "stale")
        throw Object.assign(httpError(409, "Quote needs refreshing. Request a new quote."), {
          code: "QUOTE_REFRESH_REQUIRED",
        });
      throw httpError(404, "Quote unavailable.");
    }
  };
}
