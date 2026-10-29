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

/** A booking a channel sent (Booking.com, Airbnb, …), not one made directly or at the desk: a
 * channel update writes its guest's values again. */
export function isChannelBooking(channel: string | null | undefined): boolean {
  return Boolean(channel) && !["direct", "manual"].includes(normalizeChannelKey(channel));
}
