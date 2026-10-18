import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { mainOffer, money, monthNights, restrictionOwner } from "./stepPricing";

type Room = PricingConfiguration;
type Offer = Room["offers"][number];
type Season = Extract<Offer["price"], { kind: "independent" }>["calendar"]["seasons"][number];

/** Season colours of the price calendar (VAY-2280), in the order seasons first appear; `year` fills the Year view's
 * small date cells (VAY-2284). Literal classes, so Tailwind keeps them. */
export const seasonTones = [
  {
    cell: "bg-sky-50 border-sky-200",
    year: "bg-sky-200 border-sky-200",
    swatch: "bg-sky-50 border-sky-300",
    dot: "bg-sky-500",
  },
  {
    cell: "bg-amber-50 border-amber-200",
    year: "bg-amber-200 border-amber-200",
    swatch: "bg-amber-50 border-amber-300",
    dot: "bg-amber-500",
  },
  {
    cell: "bg-pink-50 border-pink-200",
    year: "bg-pink-200 border-pink-200",
    swatch: "bg-pink-50 border-pink-300",
    dot: "bg-pink-500",
  },
  {
    cell: "bg-emerald-50 border-emerald-200",
    year: "bg-emerald-200 border-emerald-200",
    swatch: "bg-emerald-50 border-emerald-300",
    dot: "bg-emerald-600",
  },
  {
    cell: "bg-violet-50 border-violet-200",
    year: "bg-violet-200 border-violet-200",
    swatch: "bg-violet-50 border-violet-300",
    dot: "bg-violet-500",
  },
  {
    cell: "bg-teal-50 border-teal-200",
    year: "bg-teal-200 border-teal-200",
    swatch: "bg-teal-50 border-teal-300",
    dot: "bg-teal-600",
  },
] as const;

/** One season as the hotel sees it: seasons stored with the same name and tier are one season with several date
 * ranges (pricing-v2 keeps one range per season). `tone` indexes `seasonTones`, cycling. */
export type SeasonGroup = {
  key: string;
  name: string;
  tier: string;
  tone: number;
  indexes: number[];
  seasons: Season[];
};
export function seasonGroups(offer: Offer): SeasonGroup[] {
  if (offer.price.kind !== "independent") return [];
  const groups: SeasonGroup[] = [];
  offer.price.calendar.seasons.forEach((season, index) => {
    const key = JSON.stringify([
      season.name.trim().toLowerCase(),
      season.tier.trim().toLowerCase(),
    ]);
    const group = groups.find((value) => value.key === key);
    if (group) {
      group.indexes.push(index);
      group.seasons.push(season);
    } else
      groups.push({
        key,
        name: season.name,
        tier: season.tier,
        tone: groups.length % seasonTones.length,
        indexes: [index],
        seasons: [season],
      });
  });
  return groups;
}

const inSeason = (monthDay: string, from: string, through: string) =>
  from <= through
    ? monthDay >= from && monthDay <= through
    : monthDay >= from || monthDay <= through;

/** The offer whose calendar prices `offerId`'s nights: itself, or the independent option it is linked to. */
function priceOwner(room: Room, offerId: string): Offer | undefined {
  let offer = room.offers.find((value) => value.id === offerId);
  for (let hops = 0; offer?.price.kind === "linked" && hops < room.offers.length; hops++) {
    const parentId: string = offer.price.parentId;
    offer = room.offers.find((value) => value.id === parentId);
  }
  return offer ?? mainOffer(room);
}

/** One night of the calendar. `kind`: priced; closed (stop-sell; its price still shows in the label); none (no price
 * at all, so guests can't book it); unavailable (the engine can't price it for these guests). A closed night is "not
 * open" unless a stay rule of its own date closes it (VAY-2284: closed periods and closed dates look different). */
export type CalendarNight = {
  date: string;
  past: boolean;
  today: boolean;
  inStay: boolean;
  kind: "priced" | "closed" | "none" | "unavailable";
  notOpen: boolean;
  totalMinor: string | null;
  minNights: number;
  noArrival: boolean;
  ownPrice: boolean;
  season: SeasonGroup | null;
};
type ProjectedNight = Omit<CalendarNight, "past" | "today" | "inStay">;
/** Every night of `month` ("YYYY-MM") for one option and number of adults, from the engine's night evaluator. */
function projectNights(
  room: Room,
  offerId: string,
  month: string,
  adults: number,
): ProjectedNight[] {
  const owner = priceOwner(room, offerId),
    groups = owner ? seasonGroups(owner) : [];
  const seasons = owner?.price.kind === "independent" ? owner.price.calendar.seasons : [];
  const offer = room.offers.find((value) => value.id === offerId);
  const ruleOwner = offer && restrictionOwner(room, offer);
  const dateRules = ruleOwner?.restrictions.kind === "own" ? ruleOwner.restrictions.dates : [];
  return monthNights(room, offerId, month, adults).map(({ date, night }) => {
    const projected = night.kind === "projected" ? night.night : null;
    const rules = projected?.restrictions;
    const sources = projected?.sources.map((source) => source.kind) ?? [];
    // The season by its days, whatever priced the night: an own price keeps its season's colour (VAY-2284).
    const index = seasons.findIndex((season) =>
      inSeason(date.slice(5), season.from, season.through),
    );
    const closed = !!projected && !!rules?.stopSell;
    return {
      date,
      kind: projected
        ? closed
          ? "closed"
          : "priced"
        : night.kind === "unavailable" && night.reason === "missing_price"
          ? "none"
          : "unavailable",
      notOpen: closed && !dateRules.some((value) => value.date === date && value.rules.stopSell),
      totalMinor: projected?.totalMinor ?? null,
      minNights: rules?.minArrivalNights ?? 1,
      noArrival: !!rules?.closedToArrival,
      ownPrice: sources.includes("date"),
      season: index >= 0 ? (groups.find((group) => group.indexes.includes(index)) ?? null) : null,
    };
  });
}
export function calendarNights(
  room: Room,
  offerId: string,
  month: string,
  adults: number,
  today: string,
  stay: { checkIn: string; checkOut: string },
): CalendarNight[] {
  return projectNights(room, offerId, month, adults).map((night) => ({
    ...night,
    past: night.date < today,
    today: night.date === today,
    inStay: night.date >= stay.checkIn && night.date < stay.checkOut,
  }));
}

/** A night's name for screen readers, the same in the Month and Year views: "8 September 2026, €100, closed". */
export function nightLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  night: CalendarNight,
  title: string,
  currency: string,
  selected: boolean,
) {
  return [
    `${Number(night.date.slice(8))} ${title}`,
    night.kind === "none" ? "" : night.totalMinor ? money(night.totalMinor, currency) : "—",
    night.kind === "closed"
      ? t(night.notOpen ? "pricing.calendar.notOpenState" : "pricing.steps.calendar.closed")
      : "",
    night.kind === "none" ? t("pricing.calendar.noPriceState") : "",
    night.noArrival && night.kind !== "closed" ? t("pricing.steps.calendar.noArrival") : "",
    night.ownPrice ? t("pricing.calendar.ownPriceState") : "",
    selected ? t("pricing.calendar.selectedState") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

export type PriceRange = { lowMinor: string; highMinor: string };
type LegendRanges = { standard: PriceRange | null; seasons: Record<string, PriceRange> };
// The editor rebuilds the room on every render; a year's nights are worked out again only when it changes. A few
// recent answers are kept (the legend's, and the Save bar's for each rate).
const cache = new Map<string, unknown>();
function cached<T>(key: string, work: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  const value = work();
  cache.set(key, value);
  if (cache.size > 6) cache.delete(cache.keys().next().value!);
  return value;
}
/** The legend's prices (VAY-2284): the lowest and highest open night of `year` at the standard price and in each
 * season (by season key), for one option and number of adults. Own prices of single dates don't count. */
export function legendRanges(
  room: Room,
  offerId: string,
  adults: number,
  year: string,
): LegendRanges {
  return cached(JSON.stringify(["ranges", room, offerId, adults, year]), () =>
    yearRanges(room, offerId, adults, year),
  );
}
function yearRanges(room: Room, offerId: string, adults: number, year: string): LegendRanges {
  const found: Record<string, { low: bigint; high: bigint }> = {};
  for (let month = 1; month <= 12; month++)
    for (const night of projectNights(
      room,
      offerId,
      `${year}-${String(month).padStart(2, "0")}`,
      adults,
    )) {
      if (night.kind !== "priced" || night.ownPrice || night.totalMinor === null) continue;
      const key = night.season?.key ?? "",
        amount = BigInt(night.totalMinor),
        range = found[key];
      if (!range) found[key] = { low: amount, high: amount };
      else {
        if (amount < range.low) range.low = amount;
        if (amount > range.high) range.high = amount;
      }
    }
  const ranges = Object.fromEntries(
    Object.entries(found).map(([key, { low, high }]) => [
      key,
      { lowMinor: low.toString(), highMinor: high.toString() },
    ]),
  );
  const { [""]: standard = null, ...seasons } = ranges;
  return { standard, seasons };
}

/** Adults the calendar can show prices for: every count when the price depends on the number of guests. */
export function calendarAdults(room: Room): number[] {
  const main = mainOffer(room);
  const base = main.price.kind === "independent" ? main.price.calendar.base : null;
  const varies = !!base && base.mode !== "flat";
  return varies ? Array.from({ length: room.capacity.adults }, (_, index) => index + 1) : [];
}

const monthAfter = (month: string, delta: number) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1))
    .toISOString()
    .slice(0, 7);
/** Nights from `today` (YYYY-MM-DD) through the same date 12 months on that no price covers, so guests can't book them
 * ("Price rules", VAY-2280). Past nights don't count. */
export function nightsWithoutPrice(
  room: Room,
  offerId: string,
  adults: number,
  today: string,
): number {
  const end = new Date(
    Date.UTC(
      Number(today.slice(0, 4)) + 1,
      Number(today.slice(5, 7)) - 1,
      Number(today.slice(8, 10)),
    ),
  )
    .toISOString()
    .slice(0, 10);
  return cached(
    JSON.stringify(["gaps", room, offerId, adults, today]),
    () =>
      Array.from({ length: 13 }, (_, index) =>
        projectNights(room, offerId, monthAfter(today.slice(0, 7), index), adults),
      )
        .flat()
        .filter((night) => night.kind === "none" && night.date >= today && night.date <= end)
        .length,
  );
}
/** The lowest nightly price guests pay in `year` at the standard or a season price, for these rates and adults (the
 * Save bar's "Guests pay from", VAY-2280); null without any. */
export function lowestNightMinor(
  room: Room,
  offerIds: readonly string[],
  adults: number,
  year: string,
): string | null {
  const lows = offerIds.flatMap((offerId) => {
    const { standard, seasons } = legendRanges(room, offerId, adults, year);
    return [standard, ...Object.values(seasons)].flatMap((range) =>
      range ? [BigInt(range.lowMinor)] : [],
    );
  });
  return lows.length ? lows.reduce((low, value) => (value < low ? value : low)).toString() : null;
}
