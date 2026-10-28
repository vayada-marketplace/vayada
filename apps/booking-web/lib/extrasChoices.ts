import {
  pricingCurrencyScale,
  type PublicBookingQuote,
  type PublicBookingQuoteRequest,
} from "@vayada/domain-booking/replacement-pricing";
import type { PricingAddon } from "@/services/api/replacementAddons";
import {
  addonPerNight,
  addonPerPerson,
  replacementExtraDates,
  type ExtraPerson,
  type ReplacementExtrasValue,
} from "@/services/api/replacementAddonSelection";

type Selection = PublicBookingQuoteRequest["selection"];
export type ExtraItem = ReplacementExtrasValue["items"][number];

/** Everyone staying, room by room, adults before children: per-person extras count them in this
 * order ("2/4 guests" covers the first two). */
export function extraGuests(selection: Selection): ExtraPerson[] {
  return selection.rooms.flatMap((room) => [
    ...Array.from({ length: room.guests.adults }, (_, index) => ({
      selectionId: room.selectionId,
      kind: "adult" as const,
      index,
    })),
    ...room.guests.childAgesAtCheckIn.map((_, index) => ({
      selectionId: room.selectionId,
      kind: "child" as const,
      index,
    })),
  ]);
}

/** How many an extra can count: guests for a per-person extra, items otherwise. */
export function extraCountLimit(addon: PricingAddon, selection: Selection): number {
  return addonPerPerson(addon)
    ? Math.min(extraGuests(selection).length, addon.maxGuests ?? 99)
    : addon.maxQuantity;
}

/** A per-stay or per-night extra counts its items for the whole party, which must fit. */
export function extraFitsParty(addon: PricingAddon, selection: Selection): boolean {
  return addonPerPerson(addon) || addon.maxGuests === null
    ? true
    : extraGuests(selection).length <= addon.maxGuests;
}

/** A newly added extra, like the old page: every guest it can take (one item otherwise). Its day
 * comes from when it happens (VAY-2391); only a "guest_pick" extra waits for the guest's day. */
export function newExtraItem(addon: PricingAddon, selection: Selection): ExtraItem {
  return withCount(
    { id: addon.id, quantity: "1", people: [], dates: [] },
    addon,
    selection,
    addonPerPerson(addon) ? extraCountLimit(addon, selection) : 1,
  );
}

export function extraCount(addon: PricingAddon, item: ExtraItem): number {
  return addonPerPerson(addon) ? item.people.length : Number(item.quantity) || 1;
}

export function withCount(
  item: ExtraItem,
  addon: PricingAddon,
  selection: Selection,
  count: number,
): ExtraItem {
  const value = Math.max(1, Math.min(count, extraCountLimit(addon, selection)));
  return addonPerPerson(addon)
    ? { ...item, quantity: "1", people: extraGuests(selection).slice(0, value) }
    : { ...item, quantity: String(value), people: [] };
}

/** A "guest_pick" extra has exactly the day picked; picking it again clears it. */
export function toggleExtraDate(item: ExtraItem, date: string): ExtraItem {
  return { ...item, dates: item.dates[0] === date ? [] : [date] };
}

/** VAY-2391: an added "guest_pick" extra still waiting for its day. */
export const extraNeedsDay = (addon: PricingAddon, item: ExtraItem) =>
  addon.scheduleMode === "guest_pick" && item.dates.length === 0;

/** The days an added extra happens on, as the booking will store them: the arrival or departure
 * day, every night, the guest's day, or none (anytime, or a day still to pick). */
export function extraDates(addon: PricingAddon, item: ExtraItem, selection: Selection): string[] {
  switch (addon.scheduleMode) {
    case "arrival":
      return [selection.checkIn];
    case "departure":
      return [selection.checkOut];
    case "daily":
      return replacementExtraDates(selection, true);
    case "guest_pick":
      return item.dates;
    default:
      return [];
  }
}

/** What an extra costs at its display price, in minor units: the quote is the authority, so the
 * page only shows these when they add up to the quote's extras. */
export function extraAmountMinor(
  addon: PricingAddon,
  item: ExtraItem,
  unitPrice: number | null | undefined,
  selection: Selection,
): bigint | null {
  const unit = unitMinor(unitPrice, addon.currency);
  if (unit === null) return null;
  // A per-night price counts every night of the stay (VAY-2391).
  const nights = addonPerNight(addon) ? replacementExtraDates(selection, true).length : 1;
  return unit * BigInt(extraCount(addon, item)) * BigInt(nights);
}

/** A display price (major units) in minor units of its currency. */
export function unitMinor(price: number | null | undefined, currency: string): bigint | null {
  const scale = pricingCurrencyScale(currency);
  if (scale === null || price === null || price === undefined || !Number.isFinite(price))
    return null;
  return BigInt(Math.round(price * 10 ** scale));
}

/** "Fri", "6 Nov" for a stay date (YYYY-MM-DD), in the page's language. English reads as the old
 * page did ("6 Nov", not "Nov 6"). */
export function formatExtraDay(date: string, locale: string) {
  const day = new Date(`${date}T00:00:00Z`);
  const language = locale === "en" ? "en-GB" : locale;
  return {
    weekday: day.toLocaleDateString(language, { weekday: "short", timeZone: "UTC" }),
    day: day.toLocaleDateString(language, { day: "numeric", month: "short", timeZone: "UTC" }),
  };
}

/** VAY-2391: when a booked extra happens: "Fri 6 Nov"; "6 Nov – 7 Nov" over consecutive days,
 * "Fri 6 Nov · Sun 8 Nov" otherwise; null without a day. */
export function formatExtraDays(
  dates: readonly string[] | undefined,
  locale: string,
): string | null {
  const days = Array.from(new Set(dates ?? [])).sort();
  if (!days.length) return null;
  const label = (date: string) => {
    const { weekday, day } = formatExtraDay(date, locale);
    return `${weekday} ${day}`;
  };
  const consecutive = days.every(
    (date, index) => index === 0 || Date.parse(date) - Date.parse(days[index - 1]!) === 86400000,
  );
  if (days.length === 1) return label(days[0]!);
  return consecutive
    ? `${formatExtraDay(days[0]!, locale).day} – ${formatExtraDay(days[days.length - 1]!, locale).day}`
    : days.map(label).join(" · ");
}

/** The extras' own amounts, only when they add up to what the quote charges for them. */
export function extraLinesMinor(lines: (bigint | null)[], quoted: bigint | null): bigint[] | null {
  if (quoted === null || lines.some((line) => line === null)) return null;
  const known = lines as bigint[];
  return known.reduce((sum, line) => sum + line, BigInt(0)) === quoted ? known : null;
}

/** The quote's extras total in minor units, or null without extras lines. */
export function quoteExtrasMinor(quote: PublicBookingQuote): bigint | null {
  const lines = quote.lines.filter((line) => line.kind === "addon");
  return lines.length
    ? lines.reduce((sum, line) => sum + BigInt(line.amountMinor), BigInt(0))
    : null;
}
