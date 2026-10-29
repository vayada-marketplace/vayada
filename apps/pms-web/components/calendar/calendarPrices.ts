import { pricingCurrencyScale } from "@vayada/domain-pms/replacement-pricing";
import { calendarNights } from "@/components/pricing/priceCalendarModel";
import { money, sampleAdults } from "@/components/pricing/stepPricing";
import type { PricingSnapshot } from "@/services/api/replacementPricingClient";
import type { CalendarRoomType } from "@/services/calendar";

/** One rate's price for a night, in minor units of the publication's currency. */
export type NightRate = { offerId: string; totalMinor: string };

/** Each room type's open rates per night ("YYYY-MM-DD"), cheapest first (VAY-2411). The prices are the engine's, as on
 * the Prices tab (standard price, seasons, months, weekdays and own date prices, for its sample guests), and only the
 * rates the calendar can book count. A night closed to sale or without a price has no rates. */
export function calendarNightRates(
  publication: Pick<PricingSnapshot, "rooms">,
  roomTypes: readonly CalendarRoomType[],
  dates: readonly string[],
): Record<string, Record<string, NightRate[]>> {
  const months = Array.from(new Set(dates.map((date) => date.slice(0, 7))));
  const shown = new Set(dates);
  const byRoomType: Record<string, Record<string, NightRate[]>> = {};
  for (const roomType of roomTypes) {
    const room = publication.rooms.find(
      (value) => value.roomTypeId.toLowerCase() === roomType.id.toLowerCase(),
    );
    if (!room) continue;
    const rateIds = new Set(roomType.ratePlans.map((plan) => plan.id));
    const nights: Record<string, NightRate[]> = {};
    try {
      for (const offer of room.offers.filter((value) => rateIds.has(value.id)))
        for (const month of months)
          for (const night of calendarNights(room, offer.id, month, sampleAdults(room), "", {
            checkIn: "",
            checkOut: "",
          }))
            if (shown.has(night.date) && night.kind === "priced" && night.totalMinor !== null)
              (nights[night.date] ??= []).push({ offerId: offer.id, totalMinor: night.totalMinor });
    } catch {
      // A room the engine can't read shows no prices; the rest of the calendar still works.
      continue;
    }
    for (const rates of Object.values(nights))
      rates.sort((a, b) => (BigInt(a.totalMinor) < BigInt(b.totalMinor) ? -1 : 1));
    byRoomType[roomType.id] = nights;
  }
  return byRoomType;
}

/** A day cell's price: "$81", or a compact figure ("25K", "1.3M") when the full price wouldn't fit the column. */
export function cellPrice(minor: string, currency: string, locale: string) {
  const full = money(minor, currency);
  if (full.length <= 7) return full;
  const scale = pricingCurrencyScale(currency) ?? 2;
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(
    Number(minor) / 10 ** scale,
  );
}

/** Whether a booking or block holds the room on the night of `date`; stays end on their check-out day. */
export const nightTaken = (
  stays: ReadonlyArray<{ start: string; end: string }>,
  date: string,
): boolean => stays.some(({ start, end }) => start <= date && date < end);
