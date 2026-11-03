import {
  pricingOfferOnBookingPage,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import {
  datesNights,
  mainOffer,
  money,
  monthNights,
  restrictionOwner,
  sampleAdults,
} from "./stepPricing";

type Room = PricingConfiguration;
type Offer = Room["offers"][number];
type Season = Extract<Offer["price"], { kind: "independent" }>["calendar"]["seasons"][number];

/** Season colours of the price calendar (VAY-2280; the CEO's solid fills, VAY-2305), in the order seasons first appear; `year` fills the Year view's
 * small date cells (VAY-2284). Literal classes, so Tailwind keeps them. */
export const seasonTones = [
  {
    cell: "bg-sky-100 border-sky-100",
    year: "bg-sky-200 border-sky-200",
    swatch: "bg-sky-100 border-sky-300",
    dot: "bg-sky-500",
  },
  {
    cell: "bg-amber-100 border-amber-100",
    year: "bg-amber-200 border-amber-200",
    swatch: "bg-amber-100 border-amber-300",
    dot: "bg-amber-500",
  },
  {
    cell: "bg-pink-100 border-pink-100",
    year: "bg-pink-200 border-pink-200",
    swatch: "bg-pink-100 border-pink-300",
    dot: "bg-pink-500",
  },
  {
    cell: "bg-emerald-100 border-emerald-100",
    year: "bg-emerald-200 border-emerald-200",
    swatch: "bg-emerald-100 border-emerald-300",
    dot: "bg-emerald-600",
  },
  {
    cell: "bg-violet-100 border-violet-100",
    year: "bg-violet-200 border-violet-200",
    swatch: "bg-violet-100 border-violet-300",
    dot: "bg-violet-500",
  },
  {
    cell: "bg-teal-100 border-teal-100",
    year: "bg-teal-200 border-teal-200",
    swatch: "bg-teal-100 border-teal-300",
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
// recent answers are kept (the legend's, and the Save bar's).
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

/** One option's nights from `today` (YYYY-MM-DD) through the same date 12 months on, in one engine call: past nights
 * don't count, and rooms are open for sale that far ahead. */
function nightsAhead(room: Room, offerId: string, adults: number, today: string) {
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const dates: string[] = [];
  for (
    let time = Date.UTC(year, month - 1, day), end = Date.UTC(year + 1, month - 1, day);
    time <= end;
    time += 86_400_000
  )
    dates.push(new Date(time).toISOString().slice(0, 10));
  return datesNights(room, offerId, dates, adults);
}
/** Nights ahead (`nightsAhead`) that no price covers, so guests can't book them ("Price rules", VAY-2280). */
export function nightsWithoutPrice(
  room: Room,
  offerId: string,
  adults: number,
  today: string,
): number {
  return cached(
    JSON.stringify(["gaps", room, offerId, adults, today]),
    () =>
      nightsAhead(room, offerId, adults, today).filter(
        (night) => night.kind === "unavailable" && night.reason === "missing_price",
      ).length,
  );
}
/** Whether any of the room's prices depends on the number of adults ("Price depends on number of guests"). */
function pricedPerGuest(room: Room): boolean {
  return room.offers.some(({ price }) =>
    (price.kind === "independent"
      ? [
          price.calendar.base,
          ...[...price.calendar.months, ...price.calendar.seasons, ...price.calendar.dates].map(
            (value) => value.price,
          ),
        ]
      : price.dateOverrides.map((value) => value.price)
    ).some((value) => !!value && value.mode !== "flat"),
  );
}
/** The lowest price a guest can book for a night (VAY-2466): the Rooms list's "from" and the Prices tab's "Guests from"
 * bar, so both say the same. Any open night ahead (`nightsAhead`) at the standard, a season or a single date's own
 * price, over the rates the booking page sells (not `notSelling`, VAY-2304), and for every number of adults when a
 * price depends on it (else the sample guests). Null without any. */
export function guestsFromMinor(
  room: Room,
  today: string,
  notSelling: readonly string[] = [],
): string | null {
  return cached(JSON.stringify(["from", room, today, notSelling]), () => {
    const adults = pricedPerGuest(room)
      ? Array.from({ length: room.capacity.adults }, (_, index) => index + 1)
      : [sampleAdults(room)];
    let low: bigint | null = null;
    for (const offer of room.offers)
      if (pricingOfferOnBookingPage(offer) && !notSelling.includes(offer.id))
        for (const count of adults)
          for (const night of nightsAhead(room, offer.id, count, today))
            // Priced and open, as the calendar's priced nights (`projectNights`).
            if (night.kind === "projected" && !night.night.restrictions.stopSell) {
              const amount = BigInt(night.night.totalMinor);
              if (low === null || amount < low) low = amount;
            }
    return low === null ? null : low.toString();
  });
}
