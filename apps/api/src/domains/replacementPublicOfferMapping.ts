import {
  lastRefundDays,
  publicOfferCancellation,
  type PricingPaymentMethod,
  type PublicOfferCancellation,
} from "@vayada/domain-booking";
import type { BookingPublicQuotedOffer } from "@vayada/domain-distribution/booking-publication";
import { pricingOfferOnBookingPage } from "@vayada/domain-pms";
import type { lockCurrentPricingPublication } from "./currentPricingPublication.js";
import { publicPricingOfferBindings } from "./publicPricingRoomStay.js";
import {
  pricingPaymentsNow,
  pricingRatePaymentMethods,
  type PricingPaymentSwitches,
} from "./pricingRatePayability.js";

type Owner = NonNullable<Awaited<ReturnType<typeof lockCurrentPricingPublication>>>;

/** Maps already validated owner evidence. No prices, availability or permission are inferred.
 * Only booking-page offers (VAY-2285); every room keeps at least one (configuration parser). */
export function mapReplacementPublicOffers(owner: Owner):
  | readonly Readonly<{
      roomTypeId: string;
      offers: readonly BookingPublicQuotedOffer[];
    }>[]
  | null {
  const bindings = publicPricingOfferBindings(owner);
  const rooms = owner.publication.rooms.map((room) => {
    const offers = room.offers.filter(pricingOfferOnBookingPage).map((offer) => {
      const terms = owner.terms.filter(
        (t) =>
          t.roomTypeId === room.roomTypeId &&
          t.offerId === offer.id &&
          t.revision === offer.termsRevision,
      );
      const binding = bindings.filter(
        (b) => b.roomTypeId === room.roomTypeId && b.offerId === offer.id,
      );
      if (terms.length !== 1 || binding.length !== 1) return null;
      return {
        ratePlanId: binding[0]!.publicOfferKey,
        currency: owner.publication.currency,
        pricing: {
          kind: "quote_required" as const,
          publicationRevision: owner.publication.revision,
          termsRevision: terms[0]!.revision,
        },
        mealPlan: offer.meal.kind,
      };
    });
    if (!offers.length || offers.some((offer) => !offer)) return null;
    return { roomTypeId: room.roomTypeId, offers: offers as BookingPublicQuotedOffer[] };
  });
  return !rooms.length || rooms.some((room) => !room)
    ? null
    : (rooms as { roomTypeId: string; offers: BookingPublicQuotedOffer[] }[]);
}

/** Each offer's meal text in the hotel's own words (VAY-2281), by public offer key. Offers without one have no
 * entry, so the booking page keeps its own wording for them. */
export function publicOfferMealDescriptions(owner: Owner): ReadonlyMap<string, string> {
  const bindings = publicPricingOfferBindings(owner);
  const descriptions = new Map<string, string>();
  for (const room of owner.publication.rooms)
    for (const offer of room.offers) {
      const binding = bindings.find(
        (b) => b.roomTypeId === room.roomTypeId && b.offerId === offer.id,
      );
      if (binding && offer.meal.description)
        descriptions.set(binding.publicOfferKey, offer.meal.description);
    }
  return descriptions;
}

/** Each offer's cancellation as guests may see it before a quote, by public offer key, so the booking page can name
 * options "Free cancellation" or "Non-refundable" (VAY-2188). A partial refund adds its last refund day, so a stay
 * past it reads as no refund (VAY-2406). An offer without its exact terms has no entry. */
export function publicOfferCancellations(
  owner: Owner,
): ReadonlyMap<string, PublicOfferCancellation> {
  const bindings = publicPricingOfferBindings(owner);
  const cancellations = new Map<string, PublicOfferCancellation>();
  for (const room of owner.publication.rooms)
    for (const offer of room.offers) {
      const terms = owner.terms.find(
        (t) =>
          t.roomTypeId === room.roomTypeId &&
          t.offerId === offer.id &&
          t.revision === offer.termsRevision,
      );
      const binding = bindings.find(
        (b) => b.roomTypeId === room.roomTypeId && b.offerId === offer.id,
      );
      if (!terms || !binding) continue;
      cancellations.set(binding.publicOfferKey, guestOfferCancellation(terms.cancellation));
    }
  return cancellations;
}

/** An offer's cancellation as guests see it; a partial refund adds its last refund day, so a stay past it reads as
 * no refund (VAY-2406). The offers list and the booked rooms of a booking (VAY-2428) both use it. */
export function guestOfferCancellation(
  terms: Parameters<typeof publicOfferCancellation>[0],
): PublicOfferCancellation {
  const cancellation = publicOfferCancellation(terms);
  const days = lastRefundDays(terms);
  return cancellation.kind === "partial_refund" && days !== null
    ? { ...cancellation, days }
    : cancellation;
}

export type PublicOfferPaymentSchedule =
  | { kind: "full" }
  | { kind: "deposit"; percent: number; key: string };

/** How each offer is paid, by public offer key (VAY-2320). One booking is paid one way, as the
 * quote's payment amounts require: rooms combine when all are paid in full or all take the same
 * deposit (`key`), AND they share a way to pay (the catalog's `paymentMethods`). An offer without
 * its exact terms has no entry. */
export function publicOfferPaymentSchedules(
  owner: Owner,
): ReadonlyMap<string, PublicOfferPaymentSchedule> {
  const bindings = publicPricingOfferBindings(owner);
  const schedules = new Map<string, PublicOfferPaymentSchedule>();
  for (const room of owner.publication.rooms)
    for (const offer of room.offers) {
      const terms = owner.terms.find(
        (t) =>
          t.roomTypeId === room.roomTypeId &&
          t.offerId === offer.id &&
          t.revision === offer.termsRevision,
      );
      const binding = bindings.find(
        (b) => b.roomTypeId === room.roomTypeId && b.offerId === offer.id,
      );
      if (!terms || !binding) continue;
      const payment = terms.payment;
      schedules.set(
        binding.publicOfferKey,
        payment.kind === "deposit"
          ? {
              kind: "deposit",
              percent: payment.basisPoints / 100,
              key: [
                "deposit",
                payment.basisPoints,
                payment.balanceDaysBeforeArrival,
                [...(payment.acceptedMethods ?? [])].sort().join(","),
              ].join(":"),
            }
          : { kind: "full" },
      );
    }
  return schedules;
}

/** The ways guests can pay each offer now (pricingRatePaymentMethods, VAY-2309), by public offer
 * key, with the booking page's switches applied to Finance's ready methods. A rate nobody can pay
 * has none and stops selling; the others keep selling (VAY-2304). The booking page prices a stay
 * with a way its rates take. An offer without its exact terms has no entry. */
export function publicOfferPaymentMethods(
  owner: Owner,
  switches: PricingPaymentSwitches,
): ReadonlyMap<string, readonly PricingPaymentMethod[]> {
  const now = pricingPaymentsNow(owner.finance.methods, switches);
  const bindings = publicPricingOfferBindings(owner);
  const methods = new Map<string, readonly PricingPaymentMethod[]>();
  for (const room of owner.publication.rooms)
    for (const offer of room.offers) {
      const terms = owner.terms.find(
        (t) =>
          t.roomTypeId === room.roomTypeId &&
          t.offerId === offer.id &&
          t.revision === offer.termsRevision,
      );
      const binding = bindings.find(
        (b) => b.roomTypeId === room.roomTypeId && b.offerId === offer.id,
      );
      if (terms && binding)
        methods.set(binding.publicOfferKey, pricingRatePaymentMethods(terms, now));
    }
  return methods;
}
