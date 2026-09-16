import { pricingInteger, pricingObject, type PricingAdjustment, type RoomPrice } from "./replacementPricing.js";
import { parsePricingConfiguration, pricingDate, validPricingGuests, type PricingGuests,
  type PricingOffer, type PricingRestrictions } from "./replacementPricingConfiguration.js";

export type RoomStayPricingRequest = Readonly<{ propertyId: string; roomTypeId: string; offerId: string;
  expectedRevision: number; expectedTermsRevisions: Readonly<Record<string, string>>;
  checkIn: string; checkOut: string; guests: PricingGuests }>;
export type PricedRoomNight = Readonly<{ date: string; roomMinor: string; mealMinor: string; totalMinor: string;
  sources: readonly Readonly<{ offerId: string; kind: "date" | "season" | "month" | "base" | "weekday" | "linked" }>[] }>;
export type RoomStayPricingResult = Readonly<{ kind: "priced"; version: "pricing.v2"; propertyId: string;
  roomTypeId: string; offerId: string; revision: number; currency: string; guests: PricingGuests;
  termsRevisions: Readonly<Record<string, string>>; nights: readonly PricedRoomNight[];
  roomMinor: string; mealMinor: string; totalMinor: string }> | Readonly<{ kind: "unavailable";
  reason: "invalid_configuration" | "invalid_request" | "invalid_guests" | "stale" | "missing_terms" | "missing_price" | "restriction" | "overflow" }>;
type Reason = Extract<RoomStayPricingResult, { kind: "unavailable" }>["reason"];
class Unavailable extends Error { constructor(readonly reason: Reason) { super(reason); } }
const fail = (reason: Reason): never => { throw new Unavailable(reason); };
const bound = (n: bigint): bigint => n < 0n || n > 999999999999999999n ? fail("overflow") : n;
const positive = (n: bigint): bigint => n <= 0n ? fail("missing_price") : bound(n);
function adjust(n: bigint, rule: PricingAdjustment): bigint {
  return positive(rule.kind === "fixed" ? n + BigInt(rule.deltaMinor) :
    (n * (10000n + BigInt(rule.basisPoints)) + 5000n) / 10000n);
}
function tariff(price: RoomPrice, adults: number): bigint {
  if (price.mode === "flat") return BigInt(price.amountMinor);
  if (price.mode === "occupancy") return BigInt(price.amountsMinor[adults - 1]);
  if (price.mode === "per_person") return positive(BigInt(price.unitMinor) * BigInt(adults));
  return adjust(BigInt(price.baseMinor), price.adjustments[adults - 1]);
}
const inSeason = (day: string, from: string, through: string) => from <= through
  ? day >= from && day <= through : day >= from || day <= through;
/** Pure PMS room-night evaluation. Expected revisions must originate from trusted owner reads. */
export function calculateReplacementRoomStay(configuration: unknown, request: RoomStayPricingRequest): RoomStayPricingResult {
  const config = parsePricingConfiguration(configuration);
  if (!config) return { kind: "unavailable", reason: "invalid_configuration" };
  if (!request || !pricingDate(request.checkIn) || !pricingDate(request.checkOut) || request.checkOut <= request.checkIn ||
      !pricingInteger(request.expectedRevision, 1) || request.propertyId !== config.propertyId || request.roomTypeId !== config.roomTypeId ||
      !pricingObject(request.expectedTermsRevisions)) return { kind: "unavailable", reason: "invalid_request" };
  if (request.expectedRevision !== config.revision) return { kind: "unavailable", reason: "stale" };
  if (!request.guests || !validPricingGuests(request.guests, config.capacity, config.children)) return { kind: "unavailable", reason: "invalid_guests" };
  const offers = new Map(config.offers.map((o) => [o.id, o]));
  const selected = offers.get(request.offerId);
  if (!selected) return { kind: "unavailable", reason: "missing_price" };
  try {
    const chain: PricingOffer[] = [], terms: Record<string, string> = Object.create(null);
    let current: PricingOffer | undefined = selected;
    while (current) {
      chain.push(current);
      const expected = request.expectedTermsRevisions[current.id];
      if (typeof expected !== "string" || !expected) return fail("missing_terms");
      if (expected !== current.termsRevision) return fail("stale");
      terms[current.id] = current.termsRevision;
      current = current.price.kind === "linked" ? offers.get(current.price.parentId) : undefined;
    }
    chain.reverse();
    let restrictionOwner = selected;
    while (restrictionOwner.restrictions.kind === "inherit" && restrictionOwner.price.kind === "linked") restrictionOwner = offers.get(restrictionOwner.price.parentId)!;
    const restrictions = (date: string): PricingRestrictions => {
      const policy = restrictionOwner.restrictions;
      if (policy.kind !== "own") return fail("invalid_configuration");
      return policy.dates.find((r) => r.date === date)?.rules ??
        policy.seasons.find((r) => inSeason(date.slice(5), r.from, r.through))?.rules ?? policy.rules;
    };
    const stayLength = (Date.parse(request.checkOut) - Date.parse(request.checkIn)) / 86400000;
    const arrival = restrictions(request.checkIn);
    if (arrival.closedToArrival || arrival.minArrivalNights > stayLength || restrictions(request.checkOut).closedToDeparture) return fail("restriction");
    const young = request.guests.childAgesAtCheckIn.filter((age) => age < config.children.adultFromAge);
    const adults = request.guests.adults + request.guests.childAgesAtCheckIn.length - young.length;
    const bands = young.map((age) => config.children.bands.findIndex((b) => age >= b.fromAge && age <= b.throughAge));
    const supplement = bound(bands.reduce((sum, index) => sum + BigInt(config.children.bands[index].nightlyMinor), 0n));
    const charge = selected.meal.charge;
    const meal = bound(charge.kind === "room" ? BigInt(charge.amountMinor) : BigInt(charge.adultMinor) * BigInt(adults) +
      bands.reduce((sum, index) => sum + BigInt(charge.childBandAmountsMinor[index]), 0n));
    const nights: PricedRoomNight[] = [];
    let roomTotal = 0n, mealTotal = 0n;
    for (let time = Date.parse(request.checkIn); time < Date.parse(request.checkOut); time += 86400000) {
      const date = new Date(time).toISOString().slice(0, 10), rule = restrictions(date);
      if (rule.stopSell || (rule.maxStayNights !== null && stayLength > rule.maxStayNights)) return fail("restriction");
      let amount = 0n; let sources: Array<PricedRoomNight["sources"][number]> = [];
      const lastOverride = chain.findLastIndex((o) => (o.price.kind === "linked" ? o.price.dateOverrides : o.price.calendar.dates).some((r) => r.date === date));
      for (const offer of chain.slice(Math.max(0, lastOverride))) {
        const price = offer.price;
        const override = (price.kind === "linked" ? price.dateOverrides : price.calendar.dates).find((r) => r.date === date);
        if (override) { amount = positive(tariff(override.price, adults) + supplement); sources = [{ offerId: offer.id, kind: "date" }]; continue; }
        if (price.kind === "linked") { amount = adjust(amount, price.adjustment); sources.push({ offerId: offer.id, kind: "linked" }); continue; }
        const calendar = price.calendar;
        const season = calendar.seasons.find((s) => inSeason(date.slice(5), s.from, s.through));
        const month = calendar.months.find((m) => m.month === Number(date.slice(5, 7)));
        const source = season?.price ?? month?.price ?? calendar.base;
        if (!source) return fail("missing_price");
        amount = positive(tariff(source, adults) + supplement);
        sources = [{ offerId: offer.id, kind: season ? "season" : month ? "month" : "base" }];
        const weekday = calendar.weekdays.find((r) => r.day === (new Date(time).getUTCDay() + 6) % 7);
        if (weekday) { amount = adjust(amount, weekday.adjustment); sources.push({ offerId: offer.id, kind: "weekday" }); }
      }
      roomTotal = bound(roomTotal + amount); mealTotal = bound(mealTotal + meal);
      nights.push({ date, roomMinor: amount.toString(), mealMinor: meal.toString(), totalMinor: bound(amount + meal).toString(), sources });
    }
    return { kind: "priced", version: "pricing.v2", propertyId: config.propertyId, roomTypeId: config.roomTypeId,
      offerId: selected.id, revision: config.revision, currency: config.currency, guests: structuredClone(request.guests), termsRevisions: terms,
      nights, roomMinor: roomTotal.toString(), mealMinor: mealTotal.toString(), totalMinor: bound(roomTotal + mealTotal).toString() };
  } catch (error) { if (error instanceof Unavailable) return { kind: "unavailable", reason: error.reason }; throw error; }
}
