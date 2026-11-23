import { getChannelLabel, normalizeChannelKey } from "@/lib/constants/statusStyles";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Where a booking came from, in the reader's language ("Direct", "Booking.com", …). */
export function bookingChannelLabel(channel: string | null | undefined, t: Translate): string {
  const keys: Record<string, string> = {
    direct: "calendar.channelDirect",
    manual: "calendar.channelDirect",
    airbnb: "calendar.channelAirbnb",
    "booking.com": "calendar.channelBookingCom",
    expedia: "calendar.channelExpedia",
    other: "calendar.channelOther",
  };
  const normalized = normalizeChannelKey(channel);
  return keys[normalized] ? t(keys[normalized]) : getChannelLabel(channel ?? "");
}

/** A booking a channel sent (Booking.com, Airbnb, …), not one made directly or at the desk. */
export function isChannelBooking(channel: string | null | undefined): boolean {
  return Boolean(channel) && !["direct", "manual"].includes(normalizeChannelKey(channel));
}

const NAMED_OTAS = new Set([
  "airbnb",
  "booking.com",
  "expedia",
  "agoda",
  "vrbo",
  "hostelworld",
  "tripadvisor",
  "hotels.com",
]);

/** "Not provided by Airbnb" for an email or phone a channel booking came without (VAY-2577);
 * null for direct, desk and unknown sources, which keep their own empty state. */
export function notProvidedByChannel(
  channel: string | null | undefined,
  t: Translate,
): string | null {
  if (!NAMED_OTAS.has(normalizeChannelKey(channel))) return null;
  return t("bookings.detail.notProvidedByChannel", { channel: bookingChannelLabel(channel, t) });
}
