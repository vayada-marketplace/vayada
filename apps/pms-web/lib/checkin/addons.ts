import type { Booking, BookingAddon } from "@/services/bookings";
import type { CheckinRoom } from "./rooms";

export type AddonPricingModel = "per_stay" | "per_night" | "per_guest" | "per_guest_night";

/** An add-on offered at the desk (VAY-2373 D3), priced from the catalog for this stay. */
export interface AddonOffer {
  addon: BookingAddon;
  model: AddonPricingModel;
  /** Nights, guests or guest-nights the price is multiplied by; 1 per stay. */
  units: number;
  /** The price of one: for a nightly item (a scooter a day) one item for the whole stay. */
  amount: number;
  /** Nightly items are sold by the piece; the rest are added once. */
  byQuantity: boolean;
}

export function addonPricingModel(
  addon: Pick<BookingAddon, "perPerson" | "perNight">,
): AddonPricingModel {
  if (addon.perPerson && addon.perNight) return "per_guest_night";
  if (addon.perPerson) return "per_guest";
  if (addon.perNight) return "per_night";
  return "per_stay";
}

/** Guest-nights across the rooms: each room's guests times its own nights. */
export function guestNights(
  booking: Pick<Booking, "adults" | "children" | "nights">,
  rooms: CheckinRoom[],
): number {
  const known = rooms.every((room) => room.guests != null);
  return known && rooms.length
    ? rooms.reduce((sum, room) => sum + (room.guests ?? 0) * room.nights, 0)
    : (booking.adults + booking.children) * booking.nights;
}

export function addonOffer(
  addon: BookingAddon,
  booking: Pick<Booking, "adults" | "children" | "nights">,
  rooms: CheckinRoom[],
): AddonOffer {
  const model = addonPricingModel(addon);
  const units =
    model === "per_guest_night"
      ? guestNights(booking, rooms)
      : model === "per_guest"
        ? booking.adults + booking.children
        : model === "per_night"
          ? booking.nights
          : 1;
  return {
    addon,
    model,
    units,
    amount: Math.round(addon.price * units * 100) / 100,
    byQuantity: model === "per_night",
  };
}
