import { pricingInteger, pricingKeys, pricingObject, type PricingGuests } from "@vayada/domain-pms";

export type PricingAddonPerson = Readonly<{
  selectionId: string;
  kind: "adult" | "child";
  index: number;
}>;
export type PricingAddonSelection = Readonly<{
  id: string;
  quantity: number;
  dates: readonly string[] | null;
}> &
  (
    | Readonly<{ version?: never; people?: never }>
    | Readonly<{
        version: "addon-selection.v2";
        people: readonly PricingAddonPerson[] | null;
      }>
  );

/** Allocation references, not guest identities or owner eligibility. */
export function validPricingAddonPeople(
  addon: Record<string, unknown>,
  rooms: readonly { selectionId: string; guests: PricingGuests }[],
): boolean {
  if (!("version" in addon)) return pricingKeys(addon, ["id", "quantity", "dates"]);
  if (
    !pricingKeys(addon, ["version", "id", "quantity", "dates", "people"]) ||
    addon.version !== "addon-selection.v2"
  )
    return false;
  if (addon.people === null) return true;
  if (!Array.isArray(addon.people) || !addon.people.length || addon.people.length > 99)
    return false;
  const seen = new Set<string>();
  for (const person of addon.people) {
    if (
      !pricingObject(person) ||
      !pricingKeys(person, ["selectionId", "kind", "index"]) ||
      typeof person.selectionId !== "string" ||
      !pricingInteger(person.index) ||
      (person.kind !== "adult" && person.kind !== "child")
    )
      return false;
    const room = rooms.find((r) => r.selectionId === person.selectionId);
    if (
      !room ||
      person.index >=
        (person.kind === "adult" ? room.guests.adults : room.guests.childAgesAtCheckIn.length)
    )
      return false;
    const key = JSON.stringify([person.selectionId, person.kind, person.index]);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
