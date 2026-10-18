import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import type { FastifyRequest } from "fastify";
import { isManualPricingPaymentMethod, parsePublicPricingSelection } from "@vayada/domain-booking";
import { pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { GuestModuleSwitches } from "../domains/bookingGuestModules.js";
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
  /** The bank-transfer and PayPal methods acceptance can take: none while
   * REPLACEMENT_PRICING_MANUAL_PAYMENT_ACCEPTANCE_ENABLED is off, and bank transfer only with the
   * bank-details binding. */
  manualMethods: readonly string[] = [],
  /** The hotel's Feature Hub Add-ons and Promos switches (VAY-2200). */
  guestModules?: (slug: string) => Promise<GuestModuleSwitches>,
  /** Card quotes that leave the rest to pay at the property: deposits
   * (REPLACEMENT_PRICING_DEPOSIT_ACCEPTANCE_ENABLED, VAY-2205). */
  cardSplits = false,
) {
  return async (slug: string, input: unknown, requestId: unknown, signal?: AbortSignal) => {
    if (
      !validKey(requestId) ||
      !pricingObject(input) ||
      !pricingKeys(input, ["version", "selection", "paymentMethod"]) ||
      input.version !== "public-booking-quote-request.v1" ||
      !(
        ["card", "pay_at_property"].includes(input.paymentMethod as string) ||
        (isManualPricingPaymentMethod(input.paymentMethod) &&
          manualMethods.includes(input.paymentMethod))
      )
    )
      throw httpError(400, "Invalid quote request.");
    const selection = parsePublicPricingSelection(input.selection);
    if (!selection) throw httpError(400, "Invalid quote selection.");
    // Only new quotes are gated: accepting a quote issued before a switch keeps the shown price.
    if (guestModules && (selection.addons.length > 0 || selection.promoCode !== null)) {
      let switches: GuestModuleSwitches;
      try {
        switches = await guestModules(slug);
      } catch (error) {
        if (typeof (error as { statusCode?: unknown }).statusCode === "number") throw error;
        throw Object.assign(new Error("Quote temporarily unavailable.", { cause: error }), {
          statusCode: 503,
        });
      }
      if (selection.addons.length > 0 && !switches.addOns)
        throw Object.assign(httpError(422, "Extras aren't available at this hotel."), {
          code: "ADDONS_UNAVAILABLE",
        });
      if (selection.promoCode !== null && !switches.promoCodes)
        throw Object.assign(httpError(422, "Promo codes aren't available at this hotel."), {
          code: "PROMO_CODES_UNAVAILABLE",
        });
    }
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
      if (quote.paymentMethod === "card" && evidence.dueLaterMinor !== "0" && !cardSplits)
        throw new PricingStorageError("denied", "card_deposit_unavailable");
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
      // VAY-2145: check-in is too close for this method's payment deadline.
      if (error.code === "denied" && error.reason === "manual_payment_too_soon")
        throw Object.assign(
          httpError(422, "This payment method isn't available this close to check-in."),
          { code: "MANUAL_PAYMENT_TOO_SOON" },
        );
      // VAY-2205: part now by card, the rest at the property, while deposits are switched off.
      if (error.code === "denied" && error.reason === "card_deposit_unavailable")
        throw Object.assign(
          httpError(422, "Paying part now by card isn't available at this hotel yet."),
          { code: "CARD_DEPOSIT_UNAVAILABLE" },
        );
      // VAY-2232: an extra needs more notice than this stay gives.
      if (error.code === "denied" && error.reason === "addon_lead_time")
        throw Object.assign(httpError(422, "An extra needs more notice than this stay gives."), {
          code: "ADDON_NEEDS_NOTICE",
        });
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
