import { pricingCurrencyScale } from "@vayada/domain-booking/replacement-pricing";
import { bookingWebPublic } from "./client";

export type StayOfferPrice =
  | {
      publicOfferKey: string;
      status: "priced";
      totalMinor: string;
      currency: string;
      /** False when a promo code was sent but doesn't apply to this stay. */
      promoApplied: boolean;
    }
  | { publicOfferKey: string; status: "unavailable" }
  /** Bookable but not priced in this read (past the API's per-request cap): /book prices it. */
  | { publicOfferKey: string; status: "unpriced" };
export type StayRoomPrices = {
  roomTypeId: string;
  /** Rooms of this type the party needs ("2× Deluxe Double Room"); null when it can't fit. */
  roomCount: number | null;
  availability: "available" | "sold_out";
  /** Set only when three or fewer rooms are left ("Only 2 left"). */
  roomsLeft: number | null;
  /** VAY-2320, room by room only: free rooms of this type (up to 9). */
  roomsFree?: number;
  offers: StayOfferPrice[];
};
export type StayPrices = {
  checkIn: string;
  checkOut: string;
  /** VAY-2320: the fewest rooms the group could need; null when none fits, absent from older APIs. */
  suggestedRooms?: number | null;
  rooms: StayRoomPrices[];
};
export type StayQuery = {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  promoCode?: string | null;
  /** VAY-2320: the guests of the one room being chosen, room by room. */
  room?: { adults: number; children: number };
};

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const invalid = () => new Error("Stay prices could not be verified.");

/** The room cards' read-only stay prices (VAY-2190). They preview the stay; the quote on /book
 * stays the binding price. */
export async function getStayPrices(
  slug: string,
  stay: StayQuery,
  signal?: AbortSignal,
): Promise<StayPrices> {
  const params = new URLSearchParams({
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    adults: String(stay.adults),
    children: String(stay.children),
  });
  if (stay.promoCode) params.set("promoCode", stay.promoCode);
  if (stay.room) {
    params.set("roomAdults", String(stay.room.adults));
    params.set("roomChildren", String(stay.room.children));
  }
  const raw = await bookingWebPublic.get<unknown>(
    `/api/booking-web/hotels/${encodeURIComponent(slug)}/pricing-offers/stay-prices?${params}`,
    { signal, cache: "no-store" },
  );
  signal?.throwIfAborted();
  if (
    !object(raw) ||
    raw.version !== "public-pricing-stay-prices.v1" ||
    raw.checkIn !== stay.checkIn ||
    raw.checkOut !== stay.checkOut ||
    !Array.isArray(raw.rooms)
  )
    throw invalid();
  const count = (v: unknown, min: number) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= 99;
  return {
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    ...((raw.suggestedRooms === null || count(raw.suggestedRooms, 1)) && {
      suggestedRooms: raw.suggestedRooms as number | null,
    }),
    rooms: raw.rooms.map((room): StayRoomPrices => {
      if (
        !object(room) ||
        typeof room.roomTypeId !== "string" ||
        !(
          room.roomCount === null ||
          (Number.isSafeInteger(room.roomCount) && (room.roomCount as number) >= 1)
        ) ||
        (room.availability !== "available" && room.availability !== "sold_out") ||
        !(
          room.roomsLeft === null ||
          (Number.isSafeInteger(room.roomsLeft) && (room.roomsLeft as number) >= 1)
        ) ||
        !Array.isArray(room.offers)
      )
        throw invalid();
      return {
        roomTypeId: room.roomTypeId,
        roomCount: room.roomCount as number | null,
        availability: room.availability,
        roomsLeft: room.roomsLeft as number | null,
        ...(count(room.roomsFree, 0) && { roomsFree: room.roomsFree as number }),
        offers: room.offers.map((offer): StayOfferPrice => {
          if (!object(offer) || typeof offer.publicOfferKey !== "string") throw invalid();
          if (offer.status === "unavailable" || offer.status === "unpriced")
            return { publicOfferKey: offer.publicOfferKey, status: offer.status };
          if (
            offer.status !== "priced" ||
            typeof offer.totalMinor !== "string" ||
            !/^(0|[1-9][0-9]*)$/.test(offer.totalMinor) ||
            typeof offer.currency !== "string" ||
            pricingCurrencyScale(offer.currency) === null ||
            typeof offer.promoApplied !== "boolean"
          )
            throw invalid();
          return {
            publicOfferKey: offer.publicOfferKey,
            status: "priced",
            totalMinor: offer.totalMinor,
            currency: offer.currency,
            promoApplied: offer.promoApplied,
          };
        }),
      };
    }),
  };
}
