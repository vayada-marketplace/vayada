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

/** A newly added extra, like the old page: every guest it can take (one item otherwise), every
 * night for a nightly extra; a one-day extra waits for the guest to pick its day. */
export function newExtraItem(addon: PricingAddon, selection: Selection): ExtraItem {
  return withCount(
    {
      id: addon.id,
      quantity: "1",
      people: [],
      dates: addonPerNight(addon) ? replacementExtraDates(selection, true) : [],
    },
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

/** A nightly extra keeps at least one night; a one-day extra has exactly the day picked. */
export function toggleExtraDate(addon: PricingAddon, item: ExtraItem, date: string): ExtraItem {
  if (!addonPerNight(addon)) return { ...item, dates: item.dates[0] === date ? [] : [date] };
  const dates = item.dates.includes(date)
    ? item.dates.filter((value) => value !== date)
    : [...item.dates, date].sort();
  return dates.length ? { ...item, dates } : item;
}

/** What an extra costs at its display price, in minor units: the quote is the authority, so the
 * page only shows these when they add up to the quote's extras. */
export function extraAmountMinor(
  addon: PricingAddon,
  item: ExtraItem,
  unitPrice: number | null | undefined,
): bigint | null {
  const unit = unitMinor(unitPrice, addon.currency);
  if (unit === null) return null;
  const nights = addonPerNight(addon) ? item.dates.length : 1;
  return unit * BigInt(extraCount(addon, item)) * BigInt(nights);
}

/** A display price (major units) in minor units of its currency. */
export function unitMinor(price: number | null | undefined, currency: string): bigint | null {
  const scale = pricingCurrencyScale(currency);
  if (scale === null || price === null || price === undefined || !Number.isFinite(price))
    return null;
  return BigInt(Math.round(price * 10 ** scale));
}

/** The quote's extras total in minor units, or null without extras lines. */
export function quoteExtrasMinor(quote: PublicBookingQuote): bigint | null {
  const lines = quote.lines.filter((line) => line.kind === "addon");
  return lines.length
    ? lines.reduce((sum, line) => sum + BigInt(line.amountMinor), BigInt(0))
    : null;
}
