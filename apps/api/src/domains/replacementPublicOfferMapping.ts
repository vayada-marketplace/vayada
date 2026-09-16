import type { BookingPublicQuotedOffer } from "@vayada/domain-distribution/booking-publication";
import type { lockCurrentPricingPublication } from "./currentPricingPublication.js";
import { publicPricingOfferBindings } from "./publicPricingRoomStay.js";

type Owner = NonNullable<Awaited<ReturnType<typeof lockCurrentPricingPublication>>>;

/** Maps already validated owner evidence. No prices, availability or permission are inferred. */
export function mapReplacementPublicOffers(owner: Owner):
  | readonly Readonly<{
      roomTypeId: string;
      offers: readonly BookingPublicQuotedOffer[];
    }>[]
  | null {
  const bindings = publicPricingOfferBindings(owner);
  const rooms = owner.publication.rooms.map((room) => {
    const offers = room.offers.map((offer) => {
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
