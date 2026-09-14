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
    const perPerson = addonPerPerson(addon),
      perNight = addonPerNight(addon);
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
    const dates = replacementExtraDates(selection, perNight);
    if (
      !item.dates.length ||
      (!perNight && item.dates.length !== 1) ||
      new Set(item.dates).size !== item.dates.length ||
      item.dates.some((date) => !dates.includes(date))
    )
      return null;
    output.push({
      version: "addon-selection.v2",
      id: item.id,
      quantity: Number(item.quantity),
      people: perPerson ? item.people.map((person) => ({ ...person })) : null,
      dates: [...item.dates].sort(),
    });
  }
  return output;
}
