import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import { hotelCountryName } from "@/lib/checkoutTerms";

type Cancellation = PublicBookingQuote["rooms"][number]["cancellation"];
type Pin = { latitude: number; longitude: number };

/** The booked terms a stay cancels by (VAY-2360), as the cancel route works them out: each room's terms and
 * lines, the stay's total in minor units and the hotel's time zone. */
export type StayCancellation = {
  checkIn: string;
  currency: string;
  timeZone: string;
  totalMinor: string;
  rooms: Array<{ roomName: string | null; cancellation: Cancellation; subtotalMinor: string }>;
};

/** Where the guest stays, as the confirmation email lists it (VAY-2322): the property with the booked rooms
 * there, or the own address of rooms elsewhere. Exact, so only a confirmed stay has places. */
export type StayPlace =
  | {
      kind: "property";
      rooms: string[];
      streetAddress: string | null;
      area: string | null;
      postalCode: string | null;
      city: string | null;
      countryCode: string | null;
      pin: Pin | null;
      arrivalDirections: string | null;
    }
  | { kind: "elsewhere"; rooms: string[]; address: string | null; pin: Pin | null };

export type BookingStay = { cancellation: StayCancellation | null; places: StayPlace[] };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const minor = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
const day = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const whole = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
const words = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
// A zone this browser doesn't know would break the page's dates: the terms are left out instead.
const zone = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};
const names = (value: unknown) =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];

function cancellation(value: unknown): Cancellation | null {
  if (!record(value)) return null;
  if (value.kind === "non_refundable") return { kind: "non_refundable" };
  const terms = value.terms;
  if (value.kind !== "flexible" || !record(terms)) return null;
  const tiers = terms.partialRefundTiers ?? [];
  if (
    !whole(terms.freeCancellationDeadlineDays, 3650) ||
    // Terms saved without a type are free cancellation, as the server reads them.
    ![undefined, "free", "partial_refund"].includes(terms.flexibleCancellationType as string) ||
    !Array.isArray(tiers) ||
    !tiers.every(
      (tier) =>
        record(tier) && whole(tier.minDaysBeforeCheckIn, 3650) && whole(tier.refundPercent, 100),
    )
  )
    return null;
  return value as Cancellation;
}

function pin(value: unknown): Pin | null {
  if (!record(value)) return null;
  const { latitude, longitude } = value;
  return typeof latitude === "number" &&
    Math.abs(latitude) <= 90 &&
    typeof longitude === "number" &&
    Math.abs(longitude) <= 180
    ? { latitude, longitude }
    : null;
}

function place(value: unknown): StayPlace[] {
  if (!record(value)) return [];
  if (value.kind === "property")
    return [
      {
        kind: "property",
        rooms: names(value.rooms),
        streetAddress: words(value.streetAddress),
        area: words(value.area),
        postalCode: words(value.postalCode),
        city: words(value.city),
        countryCode: words(value.countryCode),
        pin: pin(value.pin),
        arrivalDirections: words(value.arrivalDirections),
      },
    ];
  if (value.kind === "elsewhere")
    return [
      {
        kind: "elsewhere",
        rooms: names(value.rooms),
        address: words(value.address),
        pin: pin(value.pin),
      },
    ];
  return [];
}

/** The stay details, or none of a part that doesn't check out: they add to the page, they never block it. */
export function parseBookingStay(value: unknown): BookingStay {
  if (!record(value) || value.version !== "booking-stay.v1")
    return { cancellation: null, places: [] };
  const terms = value.cancellation;
  const rooms =
    record(terms) && Array.isArray(terms.rooms)
      ? terms.rooms.map((room) =>
          record(room) && minor(room.subtotalMinor) && cancellation(room.cancellation)
            ? {
                roomName: words(room.roomName),
                cancellation: cancellation(room.cancellation)!,
                subtotalMinor: room.subtotalMinor,
              }
            : null,
        )
      : [];
  const valid =
    record(terms) &&
    day(terms.checkIn) &&
    typeof terms.currency === "string" &&
    zone(terms.timeZone) &&
    minor(terms.totalMinor) &&
    rooms.length > 0 &&
    rooms.every(Boolean);
  return {
    cancellation: valid
      ? {
          checkIn: terms.checkIn as string,
          currency: terms.currency as string,
          timeZone: terms.timeZone as string,
          totalMinor: terms.totalMinor as string,
          rooms: rooms as StayCancellation["rooms"],
        }
      : null,
    places: Array.isArray(value.places) ? value.places.flatMap(place) : [],
  };
}

/** A place's address on one line, as the email writes it: street, area, postal code and city, country (in the
 * page's language). */
export function placeAddress(place: StayPlace, locale: string): string | null {
  if (place.kind === "elsewhere") return place.address;
  return (
    [
      place.streetAddress,
      place.area,
      [place.postalCode, place.city].filter(Boolean).join(" "),
      hotelCountryName(place.countryCode, locale),
    ]
      .filter(Boolean)
      .join(", ") || null
  );
}

/** Google Maps directions to a place: its exact pin, else its address. */
export function placeDirectionsUrl(place: StayPlace, address: string | null): string | null {
  const destination = place.pin
    ? `${place.pin.latitude},${place.pin.longitude}`
    : address
      ? encodeURIComponent(address)
      : null;
  return destination ? `https://www.google.com/maps/dir/?api=1&destination=${destination}` : null;
}
