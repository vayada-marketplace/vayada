import { isMinorAmount, parsePricingAdjustment, parseRoomPrice, pricingCurrencyScale,
  pricingInteger, pricingKeys, pricingObject, type PricingAdjustment, type RoomPrice } from "./replacementPricing.js";

export type ChildBand = Readonly<{ fromAge: number; throughAge: number; nightlyMinor: string; countsTowardCapacity: boolean }>;
export type PricingGuests = Readonly<{ adults: number; childAgesAtCheckIn: readonly number[] }>;
export type PricingCapacity = Readonly<{ total: number; adults: number; children: number }>;
export type PricingChildPolicy = Readonly<{ adultFromAge: number; bands: readonly ChildBand[] }>;
export type PricingCalendar = Readonly<{
  base: RoomPrice | null;
  months: readonly Readonly<{ month: number; price: RoomPrice }>[];
  seasons: readonly Readonly<{ name: string; tier: string; from: string; through: string; price: RoomPrice }>[];
  weekdays: readonly Readonly<{ day: number; adjustment: PricingAdjustment }>[];
  dates: readonly Readonly<{ date: string; price: RoomPrice }>[];
}>;
export type PricingRestrictions = Readonly<{
  minArrivalNights: number; maxStayNights: number | null;
  closedToArrival: boolean; closedToDeparture: boolean; stopSell: boolean;
}>;
export type PricingMeal = Readonly<{
  kind: "room_only" | "breakfast" | "half_board" | "full_board" | "all_inclusive";
  charge: { kind: "room"; amountMinor: string } |
    { kind: "person"; adultMinor: string; childBandAmountsMinor: readonly string[] };
}>;
export type PricingOffer = Readonly<{
  id: string; termsRevision: string; meal: PricingMeal;
  price: { kind: "independent"; calendar: PricingCalendar } |
    { kind: "linked"; parentId: string; adjustment: PricingAdjustment; dateOverrides: PricingCalendar["dates"] };
  restrictions: { kind: "own"; rules: PricingRestrictions; seasons: readonly Readonly<{ from: string; through: string; rules: PricingRestrictions }>[]; dates: readonly Readonly<{ date: string; rules: PricingRestrictions }>[] } | { kind: "inherit" };
}>;
export type PricingConfiguration = Readonly<{
  version: "pricing.v2"; propertyId: string; roomTypeId: string; revision: number;
  currency: string; capacity: PricingCapacity; children: PricingChildPolicy;
  offers: readonly PricingOffer[];
}>;
export function pricingDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === value;
}
const monthDay = (value: unknown): value is string => typeof value === "string" && value.length === 5 && pricingDate(`2000-${value}`);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;

export function validPricingGuests(guests: PricingGuests, capacity: PricingCapacity, policy: PricingChildPolicy): boolean {
  if (!pricingInteger(guests.adults, 1) || !Array.isArray(guests.childAgesAtCheckIn) ||
      guests.childAgesAtCheckIn.length > capacity.children) return false;
  let adults = guests.adults, counted = guests.adults;
  for (const age of guests.childAgesAtCheckIn) {
    if (!pricingInteger(age) || age > 17) return false;
    if (age >= policy.adultFromAge) { adults++; counted++; continue; }
    const band = policy.bands.find((b) => age >= b.fromAge && age <= b.throughAge);
    if (!band) return false;
    if (band.countsTowardCapacity) counted++;
  }
  return adults <= capacity.adults && counted <= capacity.total;
}
function validCalendar(value: unknown, capacity: number): value is PricingCalendar {
  if (!pricingObject(value) || !pricingKeys(value, ["base", "months", "seasons", "weekdays", "dates"]) ||
      (value.base !== null && !parseRoomPrice(value.base, capacity))) return false;
  for (const key of ["months", "seasons", "weekdays", "dates"]) if (!Array.isArray(value[key])) return false;
  const { months, seasons, weekdays, dates } = value as unknown as PricingCalendar;
  if (!Array.from(months).every((r) => pricingObject(r) && pricingKeys(r, ["month", "price"]) &&
      pricingInteger(r.month, 1) && r.month <= 12 && parseRoomPrice(r.price, capacity)) || !unique(months.map((r) => r.month))) return false;
  if (!Array.from(dates).every((r) => pricingObject(r) && pricingKeys(r, ["date", "price"]) &&
      pricingDate(r.date) && parseRoomPrice(r.price, capacity)) || !unique(dates.map((r) => r.date))) return false;
  if (!Array.from(weekdays).every((r) => pricingObject(r) && pricingKeys(r, ["day", "adjustment"]) &&
      pricingInteger(r.day) && r.day <= 6 && parsePricingAdjustment(r.adjustment)) || !unique(weekdays.map((r) => r.day))) return false;
  const covered = new Set<string>();
  for (const r of Array.from(seasons)) {
    if (!pricingObject(r) || !pricingKeys(r, ["name", "tier", "from", "through", "price"]) || typeof r.name !== "string" || typeof r.tier !== "string" ||
        !monthDay(r.from) || !monthDay(r.through) || !parseRoomPrice(r.price, capacity)) return false;
    for (let time = Date.UTC(2000, 0, 1); time < Date.UTC(2001, 0, 1); time += 86400000) {
      const day = new Date(time).toISOString().slice(5, 10);
      const matches = r.from <= r.through ? day >= r.from && day <= r.through : day >= r.from || day <= r.through;
      if (matches && covered.has(day)) return false;
      if (matches) covered.add(day);
    }
  }
  return true;
}
function validRestrictionRules(r: unknown): boolean {
  if (!pricingObject(r)) return false;
  return pricingKeys(r, ["minArrivalNights", "maxStayNights", "closedToArrival", "closedToDeparture", "stopSell"]) &&
    pricingInteger(r.minArrivalNights, 1) && (r.maxStayNights === null || pricingInteger(r.maxStayNights, r.minArrivalNights)) &&
    [r.closedToArrival, r.closedToDeparture, r.stopSell].every((v) => typeof v === "boolean");
}
function validRestrictions(value: unknown): value is PricingOffer["restrictions"] {
  if (!pricingObject(value)) return false;
  if (value.kind === "inherit") return pricingKeys(value, ["kind"]);
  if (value.kind !== "own" || !pricingKeys(value, ["kind", "rules", "seasons", "dates"]) ||
      !validRestrictionRules(value.rules) || !Array.isArray(value.seasons) || !Array.isArray(value.dates)) return false;
  const price = { mode: "flat", amountMinor: "1" };
  if (!Array.from(value.seasons).every((r) => pricingObject(r) && pricingKeys(r, ["from", "through", "rules"]) && validRestrictionRules(r.rules)) ||
      !Array.from(value.dates).every((r) => pricingObject(r) && pricingKeys(r, ["date", "rules"]) && validRestrictionRules(r.rules))) return false;
  return validCalendar({ base: null, months: [], weekdays: [],
    seasons: value.seasons.map((r) => ({ name: "restriction", tier: "restriction", from: r.from, through: r.through, price })),
    dates: value.dates.map((r) => ({ date: r.date, price })) }, 1);
}
/** Strict snapshot boundary. Dates and prices stay declarative; no evaluator here. */
export function parsePricingConfiguration(value: unknown): PricingConfiguration | null {
  if (!pricingObject(value) || !pricingKeys(value, ["version", "propertyId", "roomTypeId", "revision", "currency", "capacity", "children", "offers"]) ||
      value.version !== "pricing.v2" || !text(value.propertyId) || !text(value.roomTypeId) || !pricingInteger(value.revision, 1) ||
      typeof value.currency !== "string" || pricingCurrencyScale(value.currency) === null ||
      !pricingObject(value.capacity) || !pricingKeys(value.capacity, ["total", "adults", "children"])) return null;
  const c = value.capacity;
  if (!pricingInteger(c.total, 1) || !pricingInteger(c.adults, 1) || !pricingInteger(c.children) || c.adults > c.total) return null;
  if (!pricingObject(value.children) || !pricingKeys(value.children, ["adultFromAge", "bands"]) ||
      !pricingInteger(value.children.adultFromAge, 1) || value.children.adultFromAge > 18 || !Array.isArray(value.children.bands)) return null;
  let nextAge = 0;
  for (const band of Array.from(value.children.bands)) {
    if (!pricingObject(band) || !pricingKeys(band, ["fromAge", "throughAge", "nightlyMinor", "countsTowardCapacity"]) ||
        band.fromAge !== nextAge || !pricingInteger(band.throughAge, nextAge) || band.throughAge >= value.children.adultFromAge ||
        !isMinorAmount(band.nightlyMinor) || typeof band.countsTowardCapacity !== "boolean") return null;
    nextAge = band.throughAge + 1;
  }
  if (nextAge !== value.children.adultFromAge || !Array.isArray(value.offers) || value.offers.length === 0) return null;
  const offers = new Map<string, PricingOffer>();
  for (const offer of Array.from(value.offers)) {
    if (!pricingObject(offer) || !pricingKeys(offer, ["id", "termsRevision", "meal", "price", "restrictions"]) ||
        !text(offer.id) || offers.has(offer.id) || !text(offer.termsRevision) || !validRestrictions(offer.restrictions) ||
        !pricingObject(offer.meal) || !pricingKeys(offer.meal, ["kind", "charge"]) ||
        !["room_only", "breakfast", "half_board", "full_board", "all_inclusive"].includes(offer.meal.kind as string) ||
        !pricingObject(offer.meal.charge) || !pricingObject(offer.price)) return null;
    const charge = offer.meal.charge;
    if (charge.kind === "room") {
      if (!pricingKeys(charge, ["kind", "amountMinor"]) || !isMinorAmount(charge.amountMinor)) return null;
    } else if (charge.kind === "person") {
      if (!pricingKeys(charge, ["kind", "adultMinor", "childBandAmountsMinor"]) || !isMinorAmount(charge.adultMinor) ||
          !Array.isArray(charge.childBandAmountsMinor) || charge.childBandAmountsMinor.length !== value.children.bands.length ||
          !Array.from(charge.childBandAmountsMinor).every(isMinorAmount)) return null;
    } else return null;
    if (offer.meal.kind === "room_only" && (charge.kind !== "room" || charge.amountMinor !== "0")) return null;
    const price = offer.price;
    if (price.kind === "independent") {
      if (!pricingKeys(price, ["kind", "calendar"]) || !validCalendar(price.calendar, c.adults) || offer.restrictions.kind !== "own") return null;
    } else if (price.kind === "linked") {
      if (!pricingKeys(price, ["kind", "parentId", "adjustment", "dateOverrides"]) || !text(price.parentId) || !parsePricingAdjustment(price.adjustment) || !validCalendar({ base: null, months: [], seasons: [], weekdays: [], dates: price.dateOverrides }, c.adults)) return null;
    } else return null;
    offers.set(offer.id, offer as unknown as PricingOffer);
  }
  for (const start of offers.values()) {
    const seen = new Set<string>();
    let current: PricingOffer | undefined = start;
    while (current?.price.kind === "linked") {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      current = offers.get(current.price.parentId);
      if (!current) return null; // Links cannot escape the property/room/currency snapshot.
    }
  }
  return structuredClone(value) as PricingConfiguration;
}
