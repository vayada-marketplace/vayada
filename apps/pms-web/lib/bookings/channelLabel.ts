import { getChannelLabel, normalizeChannelKey } from "@/lib/constants/statusStyles";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** What to say under an empty email and phone (null: nothing). */
export type ContactNotProvided = Record<"email" | "phone", string | null>;

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

// Booking.com stopped sending guest phones on 29 Sep 2026 and Airbnb in late Oct 2026 (outside
// the US and Canada); hosts still see the phone in the Booking.com extranet or the Airbnb app.
const PHONE_ELSEWHERE: Record<string, string> = {
  "booking.com": "bookings.detail.phoneNotProvidedByBookingCom",
  airbnb: "bookings.detail.phoneNotProvidedByAirbnb",
};

/** "Not provided by Airbnb" for an email or phone a channel booking came without (VAY-2577), and
 * for a Booking.com or Airbnb phone also where to find it; null for direct, desk and unknown
 * sources, which keep their own empty state. */
export function notProvidedByChannel(
  channel: string | null | undefined,
  field: "email" | "phone",
  t: Translate,
): string | null {
  const key = normalizeChannelKey(channel);
  if (!NAMED_OTAS.has(key)) return null;
  if (field === "phone" && PHONE_ELSEWHERE[key]) return t(PHONE_ELSEWHERE[key]);
  return t("bookings.detail.notProvidedByChannel", { channel: bookingChannelLabel(channel, t) });
}
