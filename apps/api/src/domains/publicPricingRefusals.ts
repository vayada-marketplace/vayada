import {
  calculateReplacementRoomStay,
  projectReplacementRoomNight,
  type PricingConfiguration,
} from "@vayada/domain-pms";
import type { PoolClient } from "pg";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { publicPricingOfferBindings } from "./publicPricingRoomStay.js";

type Dates = { checkIn: string; checkOut: string };
type Guests = { adults: number; childAges: readonly number[] };

/** Why a free room's rates refuse the stay (`roomRefusal`). */
export type Refusal =
  | { status: "minimum_stay"; minNights: number }
  | { status: "too_small" | "closed" };

const DAY = 86_400_000;
const nightsOf = (dates: Dates) =>
  Math.round((Date.parse(dates.checkOut) - Date.parse(dates.checkIn)) / DAY);
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** One rate's room-stay request with these guests, against the room's own terms revisions. */
const stayRequest = (room: PricingConfiguration, offerId: string, guests: Guests) => ({
  propertyId: room.propertyId,
  roomTypeId: room.roomTypeId,
  offerId,
  expectedRevision: room.revision,
  expectedTermsRevisions: Object.fromEntries(
    room.offers.map((offer) => [offer.id, offer.termsRevision]),
  ),
  guests: { adults: guests.adults, childAgesAtCheckIn: [...guests.childAges] },
});

/**
 * Why a free room's listed rates (`offerIds`) don't price a stay, from the published prices' own
 * rules, as the quote's calculation applies them: a minimum stay from that arrival
 * ("minimum_stay", the smallest any rate asks), guests the prices don't take ("too_small"), else
 * any other rule ("closed").
 */
export function roomRefusal(
  room: PricingConfiguration,
  offerIds: readonly string[],
  dates: Dates,
  guests: Guests,
): Refusal {
  let minNights: number | null = null,
    tooSmall = offerIds.length > 0;
  for (const offerId of offerIds) {
    const request = stayRequest(room, offerId, guests);
    const stay = calculateReplacementRoomStay(room, { ...request, ...dates });
    if (stay.kind === "unavailable" && stay.reason === "invalid_guests") continue;
    tooSmall = false;
    if (stay.kind !== "unavailable" || stay.reason !== "restriction") continue;
    const arrival = projectReplacementRoomNight(room, { ...request, date: dates.checkIn });
    const rules = arrival.kind === "projected" ? arrival.night.restrictions : null;
    if (rules && !rules.closedToArrival && rules.minArrivalNights > nightsOf(dates))
      minNights = Math.min(minNights ?? rules.minArrivalNights, rules.minArrivalNights);
  }
  if (minNights !== null) return { status: "minimum_stay", minNights };
  return { status: tooSmall ? "too_small" : "closed" };
}

/**
 * VAY-2613: for rates the booking page's stay prices refused (by public offer key, with the guests
 * they were priced for), the minimum stay from this arrival that refuses each one, so the room card
 * can say "Minimum stay 2 nights for these dates" instead of only "Not available". It is named only
 * when a stay that long from this arrival prices, so it never points the guest to a stay another
 * rule (a stop-sell night, a maximum stay, a closed departure) refuses too. Rates refused for
 * anything else, or no longer in the current publication, are left out. Caller owns the
 * transaction.
 */
export async function lockPublicPricingMinimumStays(
  client: PoolClient,
  slug: string,
  dates: Dates,
  refused: readonly { publicOfferKey: string; guests: Guests }[],
): Promise<Map<string, number>> {
  const minimum = new Map<string, number>();
  const owner = await lockPublicPricingPublication(client, slug);
  if (!owner) return minimum;
  const bindings = new Map(
    publicPricingOfferBindings(owner).map((binding) => [binding.publicOfferKey, binding]),
  );
  for (const { publicOfferKey, guests } of refused) {
    const binding = bindings.get(publicOfferKey);
    const room =
      binding && owner.publication.rooms.find((one) => one.roomTypeId === binding.roomTypeId);
    if (!binding || !room) continue;
    const refusal = roomRefusal(room, [binding.offerId], dates, guests);
    if (refusal.status !== "minimum_stay") continue;
    const longer = calculateReplacementRoomStay(room, {
      ...stayRequest(room, binding.offerId, guests),
      checkIn: dates.checkIn,
      checkOut: addDays(dates.checkIn, refusal.minNights),
    });
    if (longer.kind === "priced") minimum.set(publicOfferKey, refusal.minNights);
  }
  return minimum;
}
