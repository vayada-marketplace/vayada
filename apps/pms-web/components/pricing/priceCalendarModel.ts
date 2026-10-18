import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { headlineMinor, mainOffer, monthNights } from "./stepPricing";

type Room = PricingConfiguration;
type Offer = Room["offers"][number];
type Season = Extract<Offer["price"], { kind: "independent" }>["calendar"]["seasons"][number];

/** Season colours of the price calendar (VAY-2280), in the order seasons first appear. Literal classes, so Tailwind
 * keeps them. */
export const seasonTones = [
  { cell: "bg-sky-50 border-sky-200", swatch: "bg-sky-50 border-sky-300", dot: "bg-sky-500" },
  {
    cell: "bg-amber-50 border-amber-200",
    swatch: "bg-amber-50 border-amber-300",
    dot: "bg-amber-500",
  },
  { cell: "bg-pink-50 border-pink-200", swatch: "bg-pink-50 border-pink-300", dot: "bg-pink-500" },
  {
    cell: "bg-emerald-50 border-emerald-200",
    swatch: "bg-emerald-50 border-emerald-300",
    dot: "bg-emerald-600",
  },
  {
    cell: "bg-violet-50 border-violet-200",
    swatch: "bg-violet-50 border-violet-300",
    dot: "bg-violet-500",
  },
  { cell: "bg-teal-50 border-teal-200", swatch: "bg-teal-50 border-teal-300", dot: "bg-teal-600" },
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
 * at all, so guests can't book it); unavailable (the engine can't price it for these guests). */
export type CalendarNight = {
  date: string;
  past: boolean;
  today: boolean;
  inStay: boolean;
  kind: "priced" | "closed" | "none" | "unavailable";
  totalMinor: string | null;
  minNights: number;
  noArrival: boolean;
  ownPrice: boolean;
  season: SeasonGroup | null;
};
/** Every night of `month` ("YYYY-MM") for one option and number of adults, from the engine's night evaluator. */
export function calendarNights(
  room: Room,
  offerId: string,
  month: string,
  adults: number,
  today: string,
  stay: { checkIn: string; checkOut: string },
): CalendarNight[] {
  const owner = priceOwner(room, offerId),
    groups = owner ? seasonGroups(owner) : [];
  const seasons = owner?.price.kind === "independent" ? owner.price.calendar.seasons : [];
  return monthNights(room, offerId, month, adults).map(({ date, night }) => {
    const projected = night.kind === "projected" ? night.night : null;
    const rules = projected?.restrictions;
    const sources = projected?.sources.map((source) => source.kind) ?? [];
    const index = sources.includes("season")
      ? seasons.findIndex((season) => inSeason(date.slice(5), season.from, season.through))
      : -1;
    return {
      date,
      past: date < today,
      today: date === today,
      inStay: date >= stay.checkIn && date < stay.checkOut,
      kind: projected
        ? rules?.stopSell
          ? "closed"
          : "priced"
        : night.kind === "unavailable" && night.reason === "missing_price"
          ? "none"
          : "unavailable",
      totalMinor: projected?.totalMinor ?? null,
      minNights: rules?.minArrivalNights ?? 1,
      noArrival: !!rules?.closedToArrival,
      ownPrice: sources.includes("date"),
      season: index >= 0 ? (groups.find((group) => group.indexes.includes(index)) ?? null) : null,
    };
  });
}

/** Adults the calendar can show prices for: every count when the price depends on the number of guests. */
export function calendarAdults(room: Room): number[] {
  const main = mainOffer(room);
  const base = main.price.kind === "independent" ? main.price.calendar.base : null;
  const varies = !!base && base.mode !== "flat";
  return varies ? Array.from({ length: room.capacity.adults }, (_, index) => index + 1) : [];
}

/** The season's headline figure for the legend: its flat price, or its lowest one. */
export const seasonMinor = (group: SeasonGroup) =>
  group.seasons
    .map((season) => BigInt(headlineMinor(season.price)))
    .reduce((low, value) => (value < low ? value : low))
    .toString();
