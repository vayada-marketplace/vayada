import { createHash } from "node:crypto";
import {
  bindPublicPricingSelection,
  parsePublicPricingSelection,
  type PublicPricingOfferBinding,
  type StoredPricingRoom,
} from "@vayada/domain-booking";
import { calculateReplacementRoomStay } from "@vayada/domain-pms";
import type { PoolClient } from "pg";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";

type Publication = NonNullable<Awaited<ReturnType<typeof lockPublicPricingPublication>>>;

/** Internal projection from an already validated owner read; not standalone authorization.
 * Versioned keys bind the publication so an old selection cannot silently pick up new prices. */
export function publicPricingOfferBindings(
  owner: Publication,
): readonly PublicPricingOfferBinding[] {
  return owner.publication.rooms.flatMap((room) =>
    room.offers.map((offer) => ({
      propertyId: owner.scope.propertyId,
      roomTypeId: room.roomTypeId,
      offerId: offer.id,
      publicOfferKey:
        "pricing-offer.v2:" +
        createHash("sha256")
          .update(JSON.stringify([owner.pmsSourceRevision, room.roomTypeId, offer.id]))
          .digest("hex"),
    })),
  );
}

/** Internal room/meal component evaluation, NOT a sellable quote or grand total.
 * Caller retains its READ COMMITTED transaction through subsequent owner composition.
 * Promotions/add-ons stay in the bound request for their owners; nothing prices them here.
 * Same-day/calendar/physical inventory, FX and quote acceptance still require validation. */
export async function lockPublicPricingRoomStay(client: PoolClient, slug: unknown, input: unknown) {
  const selection = parsePublicPricingSelection(input);
  if (!selection) return null;
  const owner = await lockPublicPricingPublication(client, slug);
  if (!owner || owner.publication.currency !== selection.currency) return null;
  const stay = bindPublicPricingSelection(
    selection,
    owner.scope.propertyId,
    publicPricingOfferBindings(owner),
  );
  if (!stay) return null;
  const rooms: Array<
    StoredPricingRoom & { roomMinor: string; mealMinor: string; totalMinor: string }
  > = [];
  let roomMinor = 0n,
    mealMinor = 0n;
  for (const selected of stay.rooms) {
    const configuration = owner.publication.rooms.find((r) => r.roomTypeId === selected.roomTypeId);
    if (!configuration) return null;
    const terms = owner.terms.filter((t) => t.roomTypeId === selected.roomTypeId);
    const priced = calculateReplacementRoomStay(configuration, {
      propertyId: stay.propertyId,
      roomTypeId: selected.roomTypeId,
      offerId: selected.offerId,
      expectedRevision: owner.publication.revision,
      expectedTermsRevisions: Object.fromEntries(terms.map((t) => [t.offerId, t.revision])),
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      guests: selected.guests,
    });
    if (priced.kind !== "priced") return null;
    roomMinor += BigInt(priced.roomMinor);
    mealMinor += BigInt(priced.mealMinor);
    if (roomMinor + mealMinor > 999999999999999999n) return null;
    rooms.push({
      selectionId: selected.selectionId,
      configurationRevision: priced.revision,
      termsRevisions: priced.termsRevisions,
      mealPlan: configuration.offers.find((o) => o.id === selected.offerId)!.meal.kind,
      nights: priced.nights,
      roomMinor: priced.roomMinor,
      mealMinor: priced.mealMinor,
      totalMinor: priced.totalMinor,
    });
  }
  return {
    kind: "room_components" as const,
    evaluatorVersion: "booking.room-components.v1",
    stay,
    owner,
    rooms,
    roomMinor: roomMinor.toString(),
    mealMinor: mealMinor.toString(),
    roomAndMealMinor: (roomMinor + mealMinor).toString(),
  };
}
