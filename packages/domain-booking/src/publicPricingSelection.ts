import { validPricingAddonPeople } from "./pricingAddonSelection.js";
import {
  pricingCurrencyScale,
  pricingDate,
  pricingInteger,
  pricingKeys,
  pricingObject,
  type PricingGuests,
} from "@vayada/domain-pms";
import { parseReplacementStay, type ReplacementStay } from "./replacementPricingEvidence.js";

export const PUBLIC_PRICING_SELECTION_VERSION = "public-pricing-selection.v1";
export const PUBLIC_PRICING_SELECTION_V2 = "public-pricing-selection.v2";
export type PublicPricingSelection = Readonly<{
  version: typeof PUBLIC_PRICING_SELECTION_VERSION | typeof PUBLIC_PRICING_SELECTION_V2;
  checkIn: string;
  checkOut: string;
  currency: string;
  rooms: readonly Readonly<{
    selectionId: string;
    publicOfferKey: string;
    guests: PricingGuests;
  }>[];
  addons: ReplacementStay["addons"];
  promoCode: string | null;
}>;
/** Resource ceilings, not property capacity or sellability rules. */
export const PUBLIC_PRICING_SELECTION_LIMITS = {
  rooms: 99,
  guestsPerRoom: 99,
  nights: 366,
  addons: 99,
  addonQuantity: 99,
} as const;
const text = (v: unknown, max = 200): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && v === v.trim();

/** Parse JSON input only. The HTTP adapter must also enforce its byte limit. */
export function parsePublicPricingSelection(value: unknown): PublicPricingSelection | null {
  const limits = PUBLIC_PRICING_SELECTION_LIMITS;
  if (
    !pricingObject(value) ||
    !pricingKeys(value, [
      "version",
      "checkIn",
      "checkOut",
      "currency",
      "rooms",
      "addons",
      "promoCode",
    ]) ||
    (value.version !== PUBLIC_PRICING_SELECTION_VERSION &&
      value.version !== PUBLIC_PRICING_SELECTION_V2) ||
    !pricingDate(value.checkIn) ||
    !pricingDate(value.checkOut) ||
    value.checkOut <= value.checkIn ||
    (Date.parse(value.checkOut) - Date.parse(value.checkIn)) / 86400000 > limits.nights ||
    typeof value.currency !== "string" ||
    pricingCurrencyScale(value.currency) === null ||
    !(value.promoCode === null || text(value.promoCode)) ||
    !Array.isArray(value.rooms) ||
    value.rooms.length < 1 ||
    value.rooms.length > limits.rooms ||
    !Array.isArray(value.addons) ||
    value.addons.length > limits.addons
  )
    return null;
  const selections = new Set<string>();
  for (const room of value.rooms) {
    if (
      !pricingObject(room) ||
      !pricingKeys(room, ["selectionId", "publicOfferKey", "guests"]) ||
      !text(room.selectionId) ||
      selections.has(room.selectionId) ||
      !text(room.publicOfferKey, 512) ||
      !pricingObject(room.guests) ||
      !pricingKeys(room.guests, ["adults", "childAgesAtCheckIn"]) ||
      !pricingInteger(room.guests.adults, 1) ||
      room.guests.adults > limits.guestsPerRoom ||
      !Array.isArray(room.guests.childAgesAtCheckIn) ||
      room.guests.childAgesAtCheckIn.length + room.guests.adults > limits.guestsPerRoom ||
      !Array.from(room.guests.childAgesAtCheckIn).every((age) => pricingInteger(age) && age <= 17)
    )
      return null;
    selections.add(room.selectionId);
  }
  const addons = new Set<string>();
  for (const addon of value.addons) {
    if (
      !pricingObject(addon) ||
      !validPricingAddonPeople(addon, value.rooms as PublicPricingSelection["rooms"]) ||
      (value.version === PUBLIC_PRICING_SELECTION_V2
        ? addon.version !== "addon-selection.v2"
        : "version" in addon) ||
      !text(addon.id) ||
      addons.has(addon.id) ||
      !pricingInteger(addon.quantity, 1) ||
      addon.quantity > limits.addonQuantity
    )
      return null;
    if (
      addon.dates !== null &&
      (!Array.isArray(addon.dates) ||
        addon.dates.length < 1 ||
        addon.dates.length > limits.nights + 1 ||
        new Set(addon.dates).size !== addon.dates.length ||
        !Array.from(addon.dates).every(
          (date) =>
            pricingDate(date) &&
            date >= (value.checkIn as string) &&
            date <= (value.checkOut as string),
        ))
    )
      return null;
    addons.add(addon.id);
  }
  return structuredClone(value) as PublicPricingSelection;
}

/** Supplied by a current, authorized owner read, never by the request body. */
export type PublicPricingOfferBinding = Readonly<{
  propertyId: string;
  publicOfferKey: string;
  roomTypeId: string;
  offerId: string;
}>;

/** Pure binding, not authorization: caller resolves public property and current offers first. */
export function bindPublicPricingSelection(
  value: unknown,
  propertyId: string,
  offers: readonly PublicPricingOfferBinding[],
): ReplacementStay | null {
  const selection = parsePublicPricingSelection(value);
  if (!selection || !text(propertyId)) return null;
  const rooms: ReplacementStay["rooms"][number][] = [];
  for (const room of selection.rooms) {
    const matches = offers.filter(
      (offer) => offer.propertyId === propertyId && offer.publicOfferKey === room.publicOfferKey,
    );
    if (matches.length !== 1 || !text(matches[0].roomTypeId) || !text(matches[0].offerId))
      return null;
    rooms.push({
      selectionId: room.selectionId,
      roomTypeId: matches[0].roomTypeId,
      offerId: matches[0].offerId,
      guests: room.guests,
    });
  }
  return parseReplacementStay({
    propertyId,
    checkIn: selection.checkIn,
    checkOut: selection.checkOut,
    currency: selection.currency,
    rooms,
    addons: selection.addons,
    promoCode: selection.promoCode,
  });
}
