import {
  parsePricingConfiguration,
  projectReplacementRoomNights,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { changeDatePrice } from "./PricingDates";
import { PricingError } from "./pricingAmounts";
import { recurringTemplate } from "./recurringPricingInputs";
import { addDays, mainOffer, restrictionOwner, seasonsOverlap } from "./stepPricing";
import { spreadRangeRule } from "./stayRuleSeasons";

type Room = PricingConfiguration;
type Offer = Room["offers"][number];
type Rules = Extract<Offer["restrictions"], { kind: "own" }>["rules"];

/** The calendar's picked nights (VAY-2280): one night, or every night from `from` through `to`. */
export type NightSelection = { from: string; to: string };
/** The most nights one selection holds. */
export const MAX_PICKED_NIGHTS = 400;
/** The selection after picking `date`: a first pick selects one night, a second pick selects everything in between,
 * a third starts again. A second pick more than `MAX_PICKED_NIGHTS` away starts again too, so the calendar never
 * outlines nights an edit wouldn't change. */
export function pickNight(selection: NightSelection | null, date: string): NightSelection {
  if (!selection || selection.from !== selection.to) return { from: date, to: date };
  const range =
    date < selection.from ? { from: date, to: selection.from } : { from: selection.from, to: date };
  return addDays(range.from, MAX_PICKED_NIGHTS - 1) >= range.to ? range : { from: date, to: date };
}
export function selectedDates(selection: NightSelection): string[] {
  const dates: string[] = [];
  for (
    let date = selection.from;
    date <= selection.to && dates.length < MAX_PICKED_NIGHTS;
    date = addDays(date, 1)
  )
    dates.push(date);
  return dates;
}

const inSeason = (monthDay: string, from: string, through: string) =>
  from <= through
    ? monthDay >= from && monthDay <= through
    : monthDay >= from || monthDay <= through;
/** The stay rules a night has without a rule of its own: its stay-rule season's, or the option's defaults. */
export function seasonRules(owner: Offer, date: string): Rules {
  if (owner.restrictions.kind !== "own") throw new PricingError("pricing.error.stayRuleOwner");
  return (
    owner.restrictions.seasons.find((season) =>
      inSeason(date.slice(5), season.from, season.through),
    )?.rules ?? owner.restrictions.rules
  );
}
/** The stay rules that apply to a night of the main option (the rules every option that inherits them follows). */
export function nightRules(room: Room, date: string): Rules {
  const owner = restrictionOwner(room, mainOffer(room));
  if (owner.restrictions.kind !== "own") throw new PricingError("pricing.error.stayRuleOwner");
  return (
    owner.restrictions.dates.find((entry) => entry.date === date)?.rules ?? seasonRules(owner, date)
  );
}
const sameRules = (a: Rules, b: Rules) =>
  a.minArrivalNights === b.minArrivalNights &&
  a.maxStayNights === b.maxStayNights &&
  a.closedToArrival === b.closedToArrival &&
  a.closedToDeparture === b.closedToDeparture &&
  a.stopSell === b.stopSell;
/** Changes the stay rules of `dates` on the main option's own rules: each night keeps its other rules. A night whose
 * rules end up as its season's (or the defaults) loses its own entry, so the calendar stays tidy. */
export function setNightRules(room: Room, dates: readonly string[], patch: Partial<Rules>): Room {
  const owner = restrictionOwner(room, mainOffer(room));
  if (owner.restrictions.kind !== "own") throw new PricingError("pricing.error.stayRuleOwner");
  const restrictions = owner.restrictions;
  let entries = [...restrictions.dates];
  for (const date of dates) {
    const current = entries.find((entry) => entry.date === date)?.rules ?? seasonRules(owner, date);
    const next = { ...current, ...patch };
    entries = entries.filter((entry) => entry.date !== date);
    if (!sameRules(next, seasonRules(owner, date))) entries.push({ date, rules: next });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  const result = parsePricingConfiguration({
    ...room,
    offers: room.offers.map((offer) =>
      offer.id === owner.id
        ? { ...owner, restrictions: { ...restrictions, dates: entries } }
        : offer,
    ),
  });
  if (!result) throw new PricingError("pricing.stayDates.errorInvalid");
  return result;
}

/** The main option's own price on a night, if it has one. Other options follow it (linked adjustments still apply). */
export function ownPrice(room: Room, date: string) {
  const main = mainOffer(room);
  return main.price.kind === "independent"
    ? (main.price.calendar.dates.find((entry) => entry.date === date)?.price ?? null)
    : null;
}
/** Gives every night in `dates` the main option's own price (`values` as the price's fields: one per adult for a price
 * per number of guests, else one), or removes them with null. */
export function setOwnPrices(room: Room, dates: readonly string[], values: string[] | null): Room {
  const main = mainOffer(room);
  if (values !== null && !recurringTemplate(main))
    throw new PricingError("pricing.recurring.errorTemplateMissing");
  let next = room;
  for (const date of dates) {
    const exists = !!ownPrice(next, date);
    if (values === null) {
      if (exists) next = changeDatePrice(next, main.id, date, null);
    } else next = changeDatePrice(next, main.id, date, values, !exists);
  }
  return next;
}

/** Each option's price for one night and number of adults (null: no price), from the engine's night evaluator. */
export function nightPrices(
  room: Room,
  date: string,
  adults: number,
): { offerId: string; totalMinor: string | null }[] {
  const revisions = Object.fromEntries(room.offers.map((offer) => [offer.id, offer.termsRevision]));
  return room.offers.map((offer) => {
    const [night] = projectReplacementRoomNights(
      room,
      {
        propertyId: room.propertyId,
        roomTypeId: room.roomTypeId,
        offerId: offer.id,
        expectedRevision: room.revision,
        expectedTermsRevisions: revisions,
        guests: { adults, childAgesAtCheckIn: [] },
      },
      [date],
    );
    return {
      offerId: offer.id,
      totalMinor: night?.kind === "projected" ? night.night.totalMinor : null,
    };
  });
}

const seasonKey = (name: string, tier: string) =>
  JSON.stringify([name.trim().toLowerCase(), tier.trim().toLowerCase()]);
/** "Add the dates to a season" (VAY-2284): the picked nights' days join a season of the main option, every year
 * (seasons are MM-DD). A season with that name and tier keeps its price; a new one starts at the standard price, to
 * change under "Prices and seasons". Seasons may not overlap, and the days must be less than a year. */
export function addToSeason(
  room: Room,
  selection: NightSelection,
  season: { name: string; tier: string },
  /** The season's price when it is no longer in `room` (its days moved, see `moveToSeason`). */
  given?: Extract<Offer["price"], { kind: "independent" }>["calendar"]["seasons"][number]["price"],
): Room {
  const main = mainOffer(room);
  if (main.price.kind !== "independent") throw new PricingError("pricing.seasons.errorIndependent");
  const name = season.name.trim(),
    tier = season.tier.trim();
  if (!name) throw new PricingError("pricing.seasons.errorName");
  if (selectedDates(selection).length > 365) throw new PricingError("pricing.night.seasonTooLong");
  const calendar = main.price.calendar;
  const range = { from: selection.from.slice(5), through: selection.to.slice(5) };
  if (calendar.seasons.some((other) => seasonsOverlap(range, other)))
    throw new PricingError("pricing.steps.seasons.errorOverlap");
  const price =
    given ??
    calendar.seasons.find((other) => seasonKey(other.name, other.tier) === seasonKey(name, tier))
      ?.price ??
    calendar.base;
  if (!price) throw new PricingError("pricing.night.seasonNoStandard");
  const result = parsePricingConfiguration({
    ...room,
    offers: room.offers.map((offer) =>
      offer.id === main.id
        ? {
            ...main,
            price: {
              ...main.price,
              calendar: {
                ...calendar,
                seasons: [...calendar.seasons, { name, tier, ...range, price }],
              },
            },
          }
        : offer,
    ),
  });
  if (!result) throw new PricingError("pricing.seasons.errorInvalid");
  return result;
}

type Range = { from: string; through: string };
/** A day of the engine's MM-DD year (counted through the leap year 2000), and back. */
const dayIndex = (monthDay: string) =>
  Math.round(
    (Date.UTC(2000, Number(monthDay.slice(0, 2)) - 1, Number(monthDay.slice(3))) -
      Date.UTC(2000, 0, 1)) /
      86400000,
  );
export const monthDayOf = (index: number) =>
  new Date(Date.UTC(2000, 0, 1 + index)).toISOString().slice(5, 10);
/** Whether an MM-DD range (one may run over New Year) holds this day of the engine's year. */
export const coversDay = (range: Range, index: number) => {
  const from = dayIndex(range.from),
    through = dayIndex(range.through);
  return from <= through ? index >= from && index <= through : index >= from || index <= through;
};
/** The days of `season` outside `range`, as ranges; a part running over New Year stays one range. */
function outside(season: Range, range: Range): Range[] {
  const kept = Array.from(
    { length: 366 },
    (_, index) => coversDay(season, index) && !coversDay(range, index),
  );
  const runs: Range[] = [];
  let start = -1;
  for (let index = 0; index <= 366; index++) {
    if (index < 366 && kept[index]) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      runs.push({ from: monthDayOf(start), through: monthDayOf(index - 1) });
      start = -1;
    }
  }
  if (runs.length > 1 && kept[0] && kept[365]) {
    const first = runs.shift()!,
      last = runs.pop()!;
    runs.push({ from: last.from, through: first.through });
  }
  return runs;
}
/** "Move these dates to another season" (VAY-2305): the picked days leave every season of the main option, which
 * keeps its other days and their minimum stay, then join `season` as "Add to a season" does, or, with null, take the
 * standard price. Seasons are MM-DD and repeat every year. */
export function moveToSeason(
  room: Room,
  selection: NightSelection,
  season: { name: string; tier: string } | null,
): Room {
  const main = mainOffer(room);
  if (main.price.kind !== "independent") throw new PricingError("pricing.seasons.errorIndependent");
  if (selectedDates(selection).length > 365) throw new PricingError("pricing.night.seasonTooLong");
  const range = { from: selection.from.slice(5), through: selection.to.slice(5) };
  const calendar = main.price.calendar;
  // The target's price before its days move: picking all of a season's days for it must keep its price.
  const price =
    season &&
    calendar.seasons.find(
      (other) => seasonKey(other.name, other.tier) === seasonKey(season.name, season.tier),
    )?.price;
  const split = calendar.seasons.map((value) => ({ value, parts: outside(value, range) }));
  const changed = split.filter(
    ({ value, parts }) =>
      parts.length !== 1 || parts[0].from !== value.from || parts[0].through !== value.through,
  );
  let next = parsePricingConfiguration({
    ...room,
    offers: room.offers.map((offer) =>
      offer.id === main.id
        ? {
            ...main,
            price: {
              ...main.price,
              calendar: {
                ...calendar,
                seasons: split.flatMap(({ value, parts }) =>
                  parts.map((part) => ({ ...value, ...part })),
                ),
              },
            },
          }
        : offer,
    ),
  });
  if (!next) throw new PricingError("pricing.seasons.errorInvalid");
  for (const { value, parts } of changed) next = spreadRangeRule(next, value, parts);
  return season ? addToSeason(next, selection, season, price || undefined) : next;
}
