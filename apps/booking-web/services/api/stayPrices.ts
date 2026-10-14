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
  | { publicOfferKey: string; status: "unavailable" };
export type StayRoomPrices = {
  roomTypeId: string;
  /** Rooms of this type the party needs ("2× Deluxe Double Room"); null when it can't fit. */
  roomCount: number | null;
  availability: "available" | "sold_out";
  /** Set only when three or fewer rooms are left ("Only 2 left"). */
  roomsLeft: number | null;
  offers: StayOfferPrice[];
};
export type StayPrices = { checkIn: string; checkOut: string; rooms: StayRoomPrices[] };
export type StayQuery = {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  promoCode?: string | null;
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
  return {
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
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
        offers: room.offers.map((offer): StayOfferPrice => {
          if (!object(offer) || typeof offer.publicOfferKey !== "string") throw invalid();
          if (offer.status === "unavailable")
            return { publicOfferKey: offer.publicOfferKey, status: "unavailable" };
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
