import {
  pricingCurrencyScale,
  type PublicBookingQuoteRequest,
} from "@vayada/domain-booking/replacement-pricing";
import { bookingWebPublic } from "./client";

export const mealLabels = {
  room_only: "Room only",
  breakfast: "Breakfast included",
  half_board: "Half board",
  full_board: "Full board",
  all_inclusive: "All inclusive",
};
export type PricingRoom = {
  roomTypeId: string;
  name: string;
  offers: { publicOfferKey: string; currency: string; mealPlan: keyof typeof mealLabels }[];
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
/** Read only the fields needed for selection; never manufacture a nightly price. */
export async function getReplacementOffers(
  slug: string,
  signal?: AbortSignal,
): Promise<PricingRoom[]> {
  const raw = await bookingWebPublic.get<unknown>(
    `/api/booking-web/hotels/${encodeURIComponent(slug)}/pricing-offers`,
    { signal, cache: "no-store" },
  );
  signal?.throwIfAborted();
  if (!object(raw) || raw.version !== "public-pricing-offers.v1" || !Array.isArray(raw.rooms))
    throw new Error("Room options could not be verified.");
  const ids = new Set<string>(),
    keys = new Set<string>();
  return raw.rooms.map((room) => {
    if (
      !object(room) ||
      typeof room.roomTypeId !== "string" ||
      !room.roomTypeId ||
      ids.has(room.roomTypeId) ||
      typeof room.name !== "string" ||
      !room.name.trim() ||
      !Array.isArray(room.offers) ||
      !room.offers.length
    )
      throw new Error("Room options could not be verified.");
    ids.add(room.roomTypeId);
    return {
      roomTypeId: room.roomTypeId,
      name: room.name,
      offers: room.offers.map((offer) => {
        if (
          !object(offer) ||
          typeof offer.publicOfferKey !== "string" ||
          !/^pricing-offer\.v2:[a-f0-9]{64}$/.test(offer.publicOfferKey) ||
          keys.has(offer.publicOfferKey) ||
          typeof offer.currency !== "string" ||
          pricingCurrencyScale(offer.currency) === null ||
          typeof offer.mealPlan !== "string" ||
          !Object.hasOwn(mealLabels, offer.mealPlan)
        )
          throw new Error("Room options could not be verified.");
        keys.add(offer.publicOfferKey);
        return {
          publicOfferKey: offer.publicOfferKey,
          currency: offer.currency,
          mealPlan: offer.mealPlan as keyof typeof mealLabels,
        };
      }),
    };
  });
}
export type RoomChoice = {
  selectionId: string;
  publicOfferKey: string;
  adults: string;
  childAges: string[];
};
/** Blank age fields remain unknown, including for infants: zero must be explicitly chosen. */
export function roomQuoteRequest(
  rooms: PricingRoom[],
  choices: RoomChoice[],
  checkIn: string,
  checkOut: string,
  paymentMethod: PublicBookingQuoteRequest["paymentMethod"],
): PublicBookingQuoteRequest | null {
  const date = (v: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v;
  if (
    !date(checkIn) ||
    !date(checkOut) ||
    checkOut <= checkIn ||
    (Date.parse(checkOut) - Date.parse(checkIn)) / 86400000 > 366 ||
    !choices.length ||
    choices.length > 99
  )
    return null;
  const offers = rooms.flatMap((room) => room.offers),
    currencies = new Set<string>(),
    ids = new Set<string>();
  for (const choice of choices) {
    const matches = offers.filter((offer) => offer.publicOfferKey === choice.publicOfferKey);
    if (
      matches.length !== 1 ||
      !choice.selectionId ||
      ids.has(choice.selectionId) ||
      !/^[1-9][0-9]?$/.test(choice.adults) ||
      choice.childAges.length + Number(choice.adults) > 99 ||
      choice.childAges.some((age) => !/^(?:[0-9]|1[0-7])$/.test(age))
    )
      return null;
    currencies.add(matches[0].currency);
    ids.add(choice.selectionId);
  }
  if (currencies.size !== 1) return null;
  return {
    version: "public-booking-quote-request.v1",
    paymentMethod,
    selection: {
      version: "public-pricing-selection.v1",
      checkIn,
      checkOut,
      currency: Array.from(currencies)[0],
      addons: [],
      promoCode: null,
      rooms: choices.map((choice) => ({
        selectionId: choice.selectionId,
        publicOfferKey: choice.publicOfferKey,
        guests: { adults: Number(choice.adults), childAgesAtCheckIn: choice.childAges.map(Number) },
      })),
    },
  };
}
export function displayQuoteMoney(minor: string, currency: string): string {
  const scale = pricingCurrencyScale(currency);
  if (scale === null || !/^(0|[1-9][0-9]*)$/.test(minor)) throw new Error("Invalid amount");
  const digits = minor.padStart(scale + 1, "0");
  return `${currency} ${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}
