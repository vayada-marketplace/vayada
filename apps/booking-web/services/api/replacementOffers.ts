import {
  isPricingPaymentMethod,
  pricingAmountStep,
  pricingCurrencyScale,
  type PricingPaymentMethod,
  type PublicBookingQuoteRequest,
  type PublicOfferCancellation,
} from "@vayada/domain-booking/replacement-pricing";
import { catalogRoomSorting, type RoomSorting } from "@/lib/roomSorting";
import { bookingWebPublic } from "./client";

export const mealLabels = {
  room_only: "Room only",
  breakfast: "Breakfast included",
  half_board: "Half board",
  full_board: "Full board",
  all_inclusive: "All inclusive",
};
/** An offer's cancellation as the public catalog states it (VAY-2188); absent from older APIs. */
export type OfferCancellation = PublicOfferCancellation;
export type PricingOffer = {
  publicOfferKey: string;
  currency: string;
  mealPlan: keyof typeof mealLabels;
  cancellation?: OfferCancellation;
  /** The meal in the hotel's own words (VAY-2281); absent when it wrote none or it's malformed. */
  mealDescription?: string;
  /** The ways guests can pay this rate now (VAY-2309); absent from older APIs or when malformed. */
  paymentMethods?: PricingPaymentMethod[];
  /** How the rate is paid (VAY-2320): rooms combine when paid in full, or with the same deposit
   * (`key`), and they share a way to pay. Absent from older APIs or when malformed. */
  paymentSchedule?: { kind: "full" } | { kind: "deposit"; percent: number; key: string };
};
/** Room content for the booking page's room cards (VAY-2190). Each field is absent when the
 * API doesn't send it or sends it malformed; selection never depends on it. */
export type RoomContent = {
  description?: string;
  occupancy?: { maxGuests: number; maxAdults: number; maxChildren: number };
  images?: { url: string; alt: string | null }[];
  size?: { value: number; unit: "sqm" };
  category?: string;
  /** VAY-2410: for the details' facts line; bathrooms may be fractional (1.5). */
  bedrooms?: number;
  bathrooms?: number;
  amenities?: string[];
  /** The room's own place (VAY-2126): its pin and address, or (VAY-2321) a pin rounded to its area with the
   * area's name, never its street. While the hotel's location map is off, only rooms that show their place in
   * their details send it (VAY-2445). */
  location?:
    | { latitude: number; longitude: number; address?: string; approximate?: undefined }
    | { latitude: number; longitude: number; approximate: true; area?: string };
  /** "Same as property" (VAY-2321): the room is at the property's pin. */
  atProperty?: boolean;
  /** The room's "Show map in room details" switch (VAY-2321). */
  showMapInDetails?: boolean;
};
export type PricingRoom = RoomContent & {
  roomTypeId: string;
  name: string;
  offers: PricingOffer[];
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown, min: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min;
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const photoUrl = (v: unknown): v is string => {
  try {
    return typeof v === "string" && ["https:", "http:"].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};
function roomContent(room: Record<string, unknown>): RoomContent {
  const { occupancy: o, size, images, amenities, location: l } = room;
  return {
    ...(text(room.description) && { description: room.description }),
    ...(object(o) &&
      count(o.maxGuests, 1) &&
      count(o.maxAdults, 1) &&
      count(o.maxChildren, 0) && {
        occupancy: { maxGuests: o.maxGuests, maxAdults: o.maxAdults, maxChildren: o.maxChildren },
      }),
    ...(Array.isArray(images) && {
      images: images.flatMap((image) =>
        object(image) && photoUrl(image.url)
          ? [{ url: image.url, alt: text(image.alt) ? image.alt : null }]
          : [],
      ),
    }),
    ...(object(size) &&
      typeof size.value === "number" &&
      size.value > 0 &&
      size.unit === "sqm" && { size: { value: size.value, unit: "sqm" as const } }),
    ...(text(room.category) && { category: room.category }),
    ...(count(room.bedrooms, 1) && { bedrooms: room.bedrooms }),
    ...(typeof room.bathrooms === "number" && room.bathrooms > 0 && { bathrooms: room.bathrooms }),
    ...(Array.isArray(amenities) && { amenities: amenities.filter(text) }),
    ...(object(l) &&
      typeof l.latitude === "number" &&
      Math.abs(l.latitude) <= 90 &&
      typeof l.longitude === "number" &&
      Math.abs(l.longitude) <= 180 && {
        location:
          l.approximate === true
            ? {
                latitude: l.latitude,
                longitude: l.longitude,
                approximate: true as const,
                ...(text(l.area) && { area: l.area }),
              }
            : {
                latitude: l.latitude,
                longitude: l.longitude,
                ...(text(l.address) && { address: l.address }),
              },
      }),
    ...(typeof room.atProperty === "boolean" && { atProperty: room.atProperty }),
    ...(typeof room.showMapInDetails === "boolean" && {
      showMapInDetails: room.showMapInDetails,
    }),
  };
}
function offerCancellation(v: unknown): OfferCancellation | undefined {
  if (!object(v)) return undefined;
  const days = count(v.days, 0) && v.days <= 365 ? v.days : null;
  if (v.kind === "non_refundable") return { kind: v.kind };
  // A partial refund's last refund day (VAY-2406); absent from older APIs.
  if (v.kind === "partial_refund") return days === null ? { kind: v.kind } : { kind: v.kind, days };
  if (v.kind === "free_until_days_before_arrival" && days !== null) return { kind: v.kind, days };
  return undefined;
}
/** Read only the fields needed for selection; never manufacture a nightly price. */
export async function getReplacementOffers(
  slug: string,
  signal?: AbortSignal,
): Promise<PricingRoom[]> {
  return (await getReplacementCatalog(slug, signal)).rooms;
}

/** The property's place on the guest maps (VAY-2126, read live): its own pin as its visibility shows it
 * (rounded to the area for "Approximate"), used when no room has a pin. */
export type CatalogLocationMap = {
  property: { latitude: number; longitude: number; approximate: boolean } | null;
};

/** The catalog's rooms, the location map while the hotel shows it, the property's place for the rooms' own
 * details maps, sent whether the location map is on or not (VAY-2445), and the hotel's own Room Sorting once
 * it saved one (VAY-2449; null: the defaults). */
export async function getReplacementCatalog(
  slug: string,
  signal?: AbortSignal,
): Promise<{
  rooms: PricingRoom[];
  locationMap: CatalogLocationMap | null;
  detailsMap: CatalogLocationMap | null;
  roomSorting: RoomSorting | null;
}> {
  const raw = await bookingWebPublic.get<unknown>(
    `/api/booking-web/hotels/${encodeURIComponent(slug)}/pricing-offers`,
    { signal, cache: "no-store" },
  );
  signal?.throwIfAborted();
  if (!object(raw) || raw.version !== "public-pricing-offers.v1" || !Array.isArray(raw.rooms))
    throw new Error("Room options could not be verified.");
  const ids = new Set<string>(),
    keys = new Set<string>();
  const rooms = raw.rooms.map((room) => {
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
      ...roomContent(room),
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
        const cancellation = offerCancellation(offer.cancellation);
        return {
          publicOfferKey: offer.publicOfferKey,
          currency: offer.currency,
          mealPlan: offer.mealPlan as keyof typeof mealLabels,
          ...(cancellation && { cancellation }),
          ...(text(offer.mealDescription) &&
            offer.mealDescription.length <= 200 && { mealDescription: offer.mealDescription }),
          ...(Array.isArray(offer.paymentMethods) &&
            offer.paymentMethods.every(isPricingPaymentMethod) && {
              paymentMethods: Array.from(new Set(offer.paymentMethods)),
            }),
          ...(paymentSchedule(offer.paymentSchedule) && {
            paymentSchedule: paymentSchedule(offer.paymentSchedule)!,
          }),
        };
      }),
    };
  });
  return {
    rooms,
    locationMap: catalogLocationMap(raw.locationMap),
    detailsMap: catalogLocationMap(raw.detailsMap),
    roomSorting: catalogRoomSorting(raw.roomSorting),
  };
}

function paymentSchedule(v: unknown): PricingOffer["paymentSchedule"] {
  if (!object(v)) return undefined;
  if (v.kind === "full") return { kind: "full" };
  return v.kind === "deposit" &&
    typeof v.percent === "number" &&
    v.percent > 0 &&
    v.percent < 100 &&
    text(v.key) &&
    v.key.length <= 200
    ? { kind: "deposit", percent: v.percent, key: v.key }
    : undefined;
}

function catalogLocationMap(v: unknown): CatalogLocationMap | null {
  if (!object(v)) return null;
  const p = v.property;
  return {
    property:
      object(p) &&
      typeof p.latitude === "number" &&
      Math.abs(p.latitude) <= 90 &&
      typeof p.longitude === "number" &&
      Math.abs(p.longitude) <= 180
        ? { latitude: p.latitude, longitude: p.longitude, approximate: p.approximate === true }
        : null,
  };
}
export type RoomChoice = {
  selectionId: string;
  publicOfferKey: string;
  adults: string;
  childAges: string[];
};
/** VAY-2309: the ways every chosen rate takes, or null while a chosen rate's ways are unknown. */
export function chosenRatesPaymentMethods(
  rooms: PricingRoom[],
  choices: RoomChoice[],
): PricingPaymentMethod[] | null {
  const offers = rooms.flatMap((room) => room.offers);
  let common: PricingPaymentMethod[] | null = null;
  for (const choice of choices) {
    const methods = offers.find(
      (offer) => offer.publicOfferKey === choice.publicOfferKey,
    )?.paymentMethods;
    if (!methods) return null;
    common = (common ?? methods).filter((method) => methods.includes(method));
  }
  return common;
}
/** Blank age fields remain unknown, including for infants: zero must be explicitly chosen. */
export function roomQuoteRequest(
  rooms: PricingRoom[],
  choices: RoomChoice[],
  checkIn: string,
  checkOut: string,
  paymentMethod: PublicBookingQuoteRequest["paymentMethod"],
  promoCode = "",
): PublicBookingQuoteRequest | null {
  const date = (v: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v;
  if (
    promoCode.trim().length > 200 ||
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
      promoCode: promoCode.trim() || null,
      rooms: choices.map((choice) => ({
        selectionId: choice.selectionId,
        publicOfferKey: choice.publicOfferKey,
        guests: { adults: Number(choice.adults), childAgesAtCheckIn: choice.childAges.map(Number) },
      })),
    },
  };
}
/** Major units of a quote amount, for display-only conversion. */
export function quoteMoneyAmount(minor: string, currency: string): number {
  return Number(minor) / 10 ** (pricingCurrencyScale(currency) ?? 2);
}

export function displayQuoteMoney(minor: string, currency: string): string {
  const scale = pricingCurrencyScale(currency);
  if (scale === null || !/^(0|[1-9][0-9]*)$/.test(minor)) throw new Error("Invalid amount");
  // Whole-unit currencies (IDR, VAY-2085) show no decimals, like the other booking views;
  // amounts are whole rupiah already, and anything else rounds half-up for display.
  const step = pricingAmountStep(currency);
  if (step > 1)
    return `${currency} ${((BigInt(minor) + BigInt(step / 2)) / BigInt(step)).toString()}`;
  const digits = minor.padStart(scale + 1, "0");
  return `${currency} ${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}
