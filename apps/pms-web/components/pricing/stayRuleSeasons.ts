import {
  parsePricingConfiguration,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { PricingError } from "./pricingAmounts";
import { mainOffer, restrictionOwner } from "./stepPricing";

type Room = PricingConfiguration;
type Offer = Room["offers"][number];
type Restrictions = Extract<Offer["restrictions"], { kind: "own" }>;
type Rules = Restrictions["rules"];
type Range = { from: string; through: string };

/** The main option's own stay rules (options that inherit them follow). Steps 1 and 2 keep the year's closed periods
 * and the seasons' minimum stays here, as stay-rule seasons (`restrictions.seasons`, MM-DD, repeating every year),
 * which pricing-v2 already stores (VAY-2280). */
function owner(room: Room): Offer & { restrictions: Restrictions } {
  const offer = restrictionOwner(room, mainOffer(room));
  if (offer.restrictions.kind !== "own") throw new PricingError("pricing.error.stayRuleOwner");
  return offer as Offer & { restrictions: Restrictions };
}
const same = (a: Range, b: Range) => a.from === b.from && a.through === b.through;
/** Only the days: callers pass price seasons too, and a stay-rule season takes no other keys. */
const days = ({ from, through }: Range): Range => ({ from, through });
function withSeasons(
  room: Room,
  seasons: Restrictions["seasons"],
  error: ConstructorParameters<typeof PricingError>[0],
): Room {
  const offer = owner(room);
  const result = parsePricingConfiguration({
    ...room,
    offers: room.offers.map((value) =>
      value.id === offer.id
        ? { ...offer, restrictions: { ...offer.restrictions, seasons } }
        : value,
    ),
  });
  if (!result) throw new PricingError(error);
  return result;
}
export const stayDefaults = (room: Room): Rules => owner(room).restrictions.rules;
const sameRules = (a: Rules, b: Rules) =>
  a.minArrivalNights === b.minArrivalNights &&
  a.maxStayNights === b.maxStayNights &&
  a.closedToArrival === b.closedToArrival &&
  a.closedToDeparture === b.closedToDeparture &&
  a.stopSell === b.stopSell;

/** Step 1's "Closed every year": the stay-rule seasons that stop sales. */
export const closedPeriods = (room: Room): Range[] =>
  owner(room)
    .restrictions.seasons.filter((season) => season.rules.stopSell)
    .map(({ from, through }) => ({ from, through }));
const dayOf = (monthDay: string) =>
  Math.round(
    (Date.UTC(2000, Number(monthDay.slice(0, 2)) - 1, Number(monthDay.slice(3))) -
      Date.UTC(2000, 0, 1)) /
      86400000,
  );
/** Days in an MM-DD range, counting through the leap year 2000 as the engine does (a range can run over New Year). */
export const rangeDays = ({ from, through }: Range) => {
  const span = dayOf(through) - dayOf(from) + 1;
  return span > 0 ? span : span + 366;
};
export function addClosedPeriod(room: Room, range: Range): Room {
  const offer = owner(room);
  return withSeasons(
    room,
    [
      ...offer.restrictions.seasons,
      { ...days(range), rules: { ...offer.restrictions.rules, stopSell: true } },
    ],
    "pricing.opening.errorOverlap",
  );
}
export function removeClosedPeriods(room: Room, ranges: readonly Range[]): Room {
  const offer = owner(room);
  return withSeasons(
    room,
    offer.restrictions.seasons.filter(
      (season) => !(season.rules.stopSell && ranges.some((range) => same(range, season))),
    ),
    "pricing.opening.errorOverlap",
  );
}

/** A season range's minimum stay: its own stay-rule season (same days, not closed), or the default. */
export function rangeMinimum(room: Room, range: Range): number {
  const offer = owner(room);
  return (
    offer.restrictions.seasons.find((season) => same(season, range) && !season.rules.stopSell)
      ?.rules.minArrivalNights ?? offer.restrictions.rules.minArrivalNights
  );
}
/** Sets the minimum stay of these season ranges: each gets a stay-rule season with the same days (its other rules as
 * the defaults), or loses it when the result equals the defaults. Stay rules may not overlap, so a range that overlaps
 * another rule (for example a closed period) is refused. */
export function setRangeMinimum(room: Room, ranges: readonly Range[], nights: number): Room {
  const offer = owner(room),
    defaults = offer.restrictions.rules;
  let seasons = [...offer.restrictions.seasons];
  for (const range of ranges) {
    const current = seasons.find((season) => same(season, range) && !season.rules.stopSell);
    const rules = { ...(current?.rules ?? defaults), minArrivalNights: nights };
    seasons = seasons.filter((season) => season !== current);
    if (!sameRules(rules, defaults)) seasons.push({ ...days(range), rules });
  }
  return withSeasons(room, seasons, "pricing.seasonTable.minStayError");
}
/** Keeps a season range's stay rule with it when the range's days change (null: the range was removed). Rules that
 * belong to no season are left alone, under More options. */
export function moveRangeRule(room: Room, from: Range, to: Range | null): Room {
  return to && same(from, to) ? room : spreadRangeRule(room, from, to ? [to] : []);
}
/** Gives a season range's stay rule to the ranges it became, e.g. the two parts left when days in its middle move to
 * another season (VAY-2305); none removes it. */
export function spreadRangeRule(room: Room, from: Range, to: readonly Range[]): Room {
  const offer = owner(room);
  const rule = offer.restrictions.seasons.find(
    (season) => same(season, from) && !season.rules.stopSell,
  );
  if (!rule) return room;
  const rest = offer.restrictions.seasons.filter((season) => season !== rule);
  return withSeasons(
    room,
    [...rest, ...to.map((range) => ({ ...days(range), rules: rule.rules }))],
    "pricing.seasonTable.minStayError",
  );
}
