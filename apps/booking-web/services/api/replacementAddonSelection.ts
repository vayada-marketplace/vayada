import type { PublicBookingQuoteRequest } from "@vayada/domain-booking/replacement-pricing";
import type { PricingAddon } from "./replacementAddons";

type Selection = PublicBookingQuoteRequest["selection"];
export type ExtraPerson = { selectionId: string; kind: "adult" | "child"; index: number };
export type ReplacementExtrasValue = {
  scope: string;
  items: { id: string; quantity: string; people: ExtraPerson[]; dates: string[] }[];
};
export const addonPerPerson = (addon: PricingAddon) =>
  addon.pricingModel === "per_guest" || addon.pricingModel === "per_guest_night";
export const addonPerNight = (addon: PricingAddon) =>
  addon.pricingModel === "per_night" || addon.pricingModel === "per_guest_night";
/** VAY-2232: this check-in is closer than the add-on's notice allows; the quote refuses it too. */
export const addonNeedsNotice = (addon: PricingAddon, checkIn: string) =>
  addon.leadTimeHours !== null && (addon.bookableFrom === null || checkIn < addon.bookableFrom);

/** Increment allocationRevision on every room/guest mutation, even identical-age reorderings. */
export function replacementExtrasScope(
  catalogue: PricingAddon[],
  selection: Selection,
  allocationRevision: number,
): string {
  return JSON.stringify([
    allocationRevision,
    catalogue,
    selection.checkIn,
    selection.checkOut,
    selection.currency,
    selection.rooms,
  ]);
}
/** Date options are not selected dates. A guest must choose each date explicitly. */
export function replacementExtraDates(selection: Selection, nightly: boolean): string[] {
  const start = Date.parse(selection.checkIn),
    end = Date.parse(selection.checkOut);
  const nights = (end - start) / 86400000;
  if (!Number.isInteger(nights) || nights < 1 || nights > 366) return [];
  return Array.from({ length: nights + (nightly ? 0 : 1) }, (_, i) =>
    new Date(start + i * 86400000).toISOString().slice(0, 10),
  );
}
/** VAY-2391: the days a guest can pick for a "guest_pick" extra: the nights of the stay (never the
 * check-out day) on the weekdays the hotel offers it. */
export function addonPickDates(selection: Selection, addon: PricingAddon): string[] {
  return replacementExtraDates(selection, true).filter((date) =>
    addon.bookableWeekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay() || 7),
  );
}
/** UI validation only; the current server quote remains the authority for eligibility and price. */
export function buildReplacementAddonSelection(
  catalogue: PricingAddon[],
  selection: Selection | null,
  allocationRevision: number,
  value: ReplacementExtrasValue | null,
): Selection["addons"] | null {
  if (!selection) return null;
  if (!value) return [];
  if (
    value.scope !== replacementExtrasScope(catalogue, selection, allocationRevision) ||
    value.items.length > 99
  )
    return null;
  const ids = new Set<string>();
  const output: Selection["addons"][number][] = [];
  for (const item of value.items) {
    const matches = catalogue.filter((addon) => addon.id === item.id),
      addon = matches[0];
    if (
      matches.length !== 1 ||
      addon.currency !== selection.currency ||
      ids.has(item.id) ||
      !/^[1-9][0-9]?$/.test(item.quantity) ||
      Number(item.quantity) > addon.maxQuantity
    )
      return null;
    ids.add(item.id);
    const perPerson = addonPerPerson(addon);
    if (
      perPerson
        ? item.quantity !== "1" || !item.people.length || item.people.length > 99
        : item.people.length !== 0
    )
      return null;
    const people = new Set<string>();
    for (const person of item.people) {
      const room = selection.rooms.find((room) => room.selectionId === person.selectionId);
      const key = JSON.stringify([person.selectionId, person.kind, person.index]);
      if (
        !room ||
        !Number.isInteger(person.index) ||
        person.index < 0 ||
        (person.kind !== "adult" && person.kind !== "child") ||
        person.index >=
          (person.kind === "adult" ? room.guests.adults : room.guests.childAgesAtCheckIn.length) ||
        people.has(key)
      )
        return null;
      people.add(key);
    }
    const guestCount = perPerson
      ? item.people.length
      : selection.rooms.reduce(
          (sum, room) => sum + room.guests.adults + room.guests.childAgesAtCheckIn.length,
          0,
        );
    if (addon.maxGuests !== null && guestCount > addon.maxGuests) return null;
    // VAY-2391: only a guest-pick extra sends its day; the server dates the others (check-in,
    // check-out, every night, or no day).
    const pick = addon.scheduleMode === "guest_pick";
    if (
      pick
        ? item.dates.length !== 1 || !addonPickDates(selection, addon).includes(item.dates[0]!)
        : item.dates.length !== 0
    )
      return null;
    output.push({
      version: "addon-selection.v2",
      id: item.id,
      quantity: Number(item.quantity),
      people: perPerson ? item.people.map((person) => ({ ...person })) : null,
      dates: pick ? [item.dates[0]!] : null,
    });
  }
  return output;
}

/** VAY-2393: extras the guest chose for other rooms of the same stay (a room was changed or
 * removed), carried over to these rooms: the same extras, quantities and days. A per-guest extra
 * keeps as many adults and children as before, the first ones of these rooms, and is left out
 * when these rooms have fewer. An extra these rooms can't take (gone from the catalogue, another
 * currency, too many guests) is left out too, so the step never gets stuck on one the guest can't
 * see. Null when nothing carries over. */
export function carryReplacementExtras(
  value: ReplacementExtrasValue,
  catalogue: PricingAddon[],
  selection: Selection,
  allocationRevision: number,
): ReplacementExtrasValue | null {
  const guests = (kind: ExtraPerson["kind"]): ExtraPerson[] =>
    selection.rooms.flatMap((room) =>
      Array.from(
        { length: kind === "adult" ? room.guests.adults : room.guests.childAgesAtCheckIn.length },
        (_, index) => ({ selectionId: room.selectionId, kind, index }),
      ),
    );
  const adults = guests("adult"),
    children = guests("child");
  const scope = replacementExtrasScope(catalogue, selection, allocationRevision);
  const ids = new Set<string>();
  const items = value.items.flatMap((item) => {
    const wantAdults = item.people.filter((person) => person.kind === "adult").length;
    const wantChildren = item.people.length - wantAdults;
    if (wantAdults > adults.length || wantChildren > children.length) return [];
    const carried = item.people.length
      ? { ...item, people: [...adults.slice(0, wantAdults), ...children.slice(0, wantChildren)] }
      : item;
    if (
      ids.has(item.id) ||
      !buildReplacementAddonSelection(catalogue, selection, allocationRevision, {
        scope,
        items: [carried],
      })
    )
      return [];
    ids.add(item.id);
    return [carried];
  });
  return items.length ? { scope, items: items.slice(0, 99) } : null;
}
