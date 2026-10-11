import {
  parsePricingConfiguration,
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import type { ReplacementOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import { formatCurrency } from "@/lib/formatCurrency";
import { decimalAmount, PricingError, type Translate } from "./pricingAmounts";

/** The step-by-step Prices tab's view of one room's pricing-v2 configuration. Pure: every change goes back through
 * `parsePricingConfiguration`, so a step never writes a room the engine would refuse. */
const ZERO = BigInt(0);
type Room = PricingConfiguration;
type Offer = Room["offers"][number];
type Calendar = Extract<Offer["price"], { kind: "independent" }>["calendar"];
export type RoomPrice = NonNullable<Calendar["base"]>;
/** What naming and summaries need from an option's cancellation and payment terms. */
export type OptionTerms = Pick<ReplacementOfferTerms, "cancellation" | "payment">;

/** The room's main option: its first offer with its own prices. Every linked offer ends at an independent one, so a
 * valid room always has one. */
export function mainOffer(room: Room): Offer {
  const main = room.offers.find((offer) => offer.price.kind === "independent");
  if (!main) throw new PricingError("pricing.error.offerMissing");
  return main;
}

/** Money as guests read it: "€100", or "€100.50" when it has cents. Display only; prices stay minor-unit strings. */
export function money(minor: string, currency: string) {
  const scale = pricingCurrencyScale(currency) ?? 2;
  const negative = minor.startsWith("-"),
    digits = minor.replace(/^-/, "");
  const decimal = decimalAmount(digits, scale);
  const whole = !decimal.includes(".") || /\.0+$/.test(decimal);
  return `${negative ? "−" : ""}${formatCurrency(Number(decimal), currency, whole ? 0 : scale)}`;
}

/** One figure for a price: the flat or included-guests amount, the per-adult unit, or the lowest occupancy amount. */
export function headlineMinor(price: RoomPrice): string {
  if (price.mode === "flat") return price.amountMinor;
  if (price.mode === "per_person") return price.unitMinor;
  if (price.mode === "included_guests") return price.baseMinor;
  return price.amountsMinor.reduce((low, amount) => (BigInt(amount) < BigInt(low) ? amount : low));
}

/** Option names, since the engine stores none: from the meal plan and the cancellation terms ("Flexible",
 * "Non-refundable + breakfast"). Without terms (still loading, or failed) the meal plan and position name it. Later
 * options with the same name are numbered. */
export function optionNames(
  room: Room,
  terms: Readonly<Record<string, OptionTerms | undefined>>,
  t: Translate,
) {
  const names: Record<string, string> = {},
    used = new Map<string, number>();
  room.offers.forEach((offer, index) => {
    const cancellation = terms[offer.id]?.cancellation.kind;
    const name = cancellation
      ? t(`pricing.steps.name.${cancellation}.${offer.meal.kind}`)
      : t("pricing.steps.name.fallback", {
          number: index + 1,
          meal: t(`pricing.meal.${offer.meal.kind}`),
        });
    const count = (used.get(name) ?? 0) + 1;
    used.set(name, count);
    names[offer.id] =
      count === 1 ? name : t("pricing.steps.name.numbered", { name, number: count });
  });
  return names;
}

/** The option card's one-line summary: meal, price relation, cancellation ("Breakfast +€15 · Free cancellation up to 7
 * days before"). */
export function optionSummary(
  room: Room,
  offer: Offer,
  names: Readonly<Record<string, string>>,
  terms: OptionTerms | undefined,
  t: Translate,
) {
  const meal = t(`pricing.steps.meal.${offer.meal.kind}`),
    charge = offer.meal.charge;
  const parts = [
    offer.meal.kind === "room_only"
      ? meal
      : charge.kind === "room"
        ? t("pricing.steps.summary.mealRoom", {
            meal,
            amount: money(charge.amountMinor, room.currency),
          })
        : t("pricing.steps.summary.mealPerson", {
            meal,
            amount: money(charge.adultMinor, room.currency),
          }),
  ];
  if (offer.price.kind === "linked") {
    const { adjustment, parentId } = offer.price;
    if (parentId !== mainOffer(room).id)
      parts.push(t("pricing.steps.summary.basedOn", { name: names[parentId] ?? "" }));
    const delta = BigInt(
      adjustment.kind === "percentage" ? adjustment.basisPoints : adjustment.deltaMinor,
    );
    if (delta !== ZERO)
      parts.push(
        adjustment.kind === "percentage"
          ? t(
              delta < ZERO
                ? "pricing.steps.summary.cheaperPercent"
                : "pricing.steps.summary.morePercent",
              { percent: Math.abs(adjustment.basisPoints) / 100 },
            )
          : t(
              delta < ZERO
                ? "pricing.steps.summary.cheaperAmount"
                : "pricing.steps.summary.moreAmount",
              { amount: money(adjustment.deltaMinor.replace(/^-/, ""), room.currency) },
            ),
      );
  } else if (offer.id !== mainOffer(room).id) parts.push(t("pricing.steps.summary.ownPrices"));
  const cancellation = terms?.cancellation;
  if (cancellation?.kind === "non_refundable") parts.push(t("pricing.steps.summary.noRefund"));
  else if (cancellation) {
    const days = cancellation.terms.freeCancellationDeadlineDays;
    parts.push(
      t(
        days === 0
          ? "pricing.steps.summary.freeCancellation.zero"
          : days === 1
            ? "pricing.steps.summary.freeCancellation.one"
            : "pricing.steps.summary.freeCancellation.other",
        { days },
      ),
    );
  }
  return parts.join(" · ");
}

/** Weekend surcharges the step offers as one choice: Friday and Saturday nights (engine days 4 and 5), the same
 * percentage for both. */
export const weekendChoices = [1000, 1500, 2000] as const;
const FRIDAY = 4,
  SATURDAY = 5;
/** "none" (no Friday or Saturday rule), a chip's basis points, or "other" (any other Friday/Saturday rule). Rules
 * for other days are separate: see `otherWeekdays`. */
export function weekendChoice(offer: Offer): "none" | (typeof weekendChoices)[number] | "other" {
  if (offer.price.kind !== "independent") return "none";
  const weekdays = offer.price.calendar.weekdays;
  const friday = weekdays.find((rule) => rule.day === FRIDAY)?.adjustment,
    saturday = weekdays.find((rule) => rule.day === SATURDAY)?.adjustment;
  if (!friday && !saturday) return "none";
  const chip = weekendChoices.find(
    (bp) => bp === (friday?.kind === "percentage" ? friday.basisPoints : null),
  );
  return chip && saturday?.kind === "percentage" && saturday.basisPoints === chip ? chip : "other";
}
/** The offer's weekday rules for days other than Friday and Saturday. */
export const otherWeekdays = (offer: Offer) =>
  offer.price.kind === "independent"
    ? offer.price.calendar.weekdays.filter((rule) => rule.day !== FRIDAY && rule.day !== SATURDAY)
    : [];
/** Sets (or, with null, clears) the weekend surcharge on Friday and Saturday; other days keep their rules. */
export function setWeekend(room: Room, offerId: string, basisPoints: number | null): Room {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "independent")
    throw new PricingError("pricing.weekdays.errorIndependent");
  const weekdays = [
    ...otherWeekdays(offer),
    ...(basisPoints === null
      ? []
      : [FRIDAY, SATURDAY].map((day) => ({
          day,
          adjustment: { kind: "percentage" as const, basisPoints },
        }))),
  ].sort((a, b) => a.day - b.day);
  const price = { ...offer.price, calendar: { ...offer.price.calendar, weekdays } };
  const result = parsePricingConfiguration({
    ...room,
    offers: room.offers.map((value) => (value.id === offerId ? { ...offer, price } : value)),
  });
  if (!result) throw new PricingError("pricing.weekdays.errorRange");
  return result;
}

/** One stretch of the year bar: consecutive days that take their price from the same season, month price or normal
 * price. Days count through the leap year 2000, as the engine's season check does (MM-DD, so 02-29 exists). */
export type YearPiece = {
  start: number;
  days: number;
  source:
    | { kind: "season"; index: number }
    | { kind: "month"; month: number }
    | { kind: "base" }
    | { kind: "none" };
  price: RoomPrice | null;
  /** Cheaper ("low") or dearer ("high") than the normal price. */
  tone: "low" | "high" | "normal";
};
const inSeason = (day: string, from: string, through: string) =>
  from <= through ? day >= from && day <= through : day >= from || day <= through;
export function yearPieces(offer: Offer): YearPiece[] {
  if (offer.price.kind !== "independent") return [];
  const calendar = offer.price.calendar,
    pieces: YearPiece[] = [];
  const normal = calendar.base ? BigInt(headlineMinor(calendar.base)) : null;
  for (let day = 0; day < 366; day++) {
    const date = new Date(Date.UTC(2000, 0, 1 + day)).toISOString().slice(5, 10),
      month = Number(date.slice(0, 2));
    const index = calendar.seasons.findIndex((season) =>
      inSeason(date, season.from, season.through),
    );
    const monthPrice = calendar.months.find((entry) => entry.month === month)?.price;
    const source: YearPiece["source"] =
      index >= 0
        ? { kind: "season", index }
        : monthPrice
          ? { kind: "month", month }
          : calendar.base
            ? { kind: "base" }
            : { kind: "none" };
    const last = pieces.at(-1);
    if (last && JSON.stringify(last.source) === JSON.stringify(source)) {
      last.days++;
      continue;
    }
    const price = index >= 0 ? calendar.seasons[index].price : (monthPrice ?? calendar.base);
    const figure = price ? BigInt(headlineMinor(price)) : null;
    const tone =
      normal === null || figure === null || source.kind === "base" || figure === normal
        ? "normal"
        : figure < normal
          ? "low"
          : "high";
    pieces.push({ start: day, days: 1, source, price, tone });
  }
  return pieces;
}

/** The offer whose stay rules apply to `offer`: itself, or the parent it inherits them from. */
export function restrictionOwner(room: Room, offer: Offer): Offer {
  let owner = offer;
  while (owner.restrictions.kind === "inherit" && owner.price.kind === "linked") {
    const parentId: string = owner.price.parentId;
    owner = room.offers.find((value) => value.id === parentId)!;
  }
  return owner;
}
/** Options whose stay rules are their own, not the main option's: step 5 names them instead of changing them. */
export const ownRuleOptions = (room: Room) => {
  const main = mainOffer(room);
  return room.offers.filter(
    (offer) => offer.id !== main.id && restrictionOwner(room, offer).id !== main.id,
  );
};
/** Sets the main option's minimum nights (options that inherit its rules follow). Max stay and the closed flags stay. */
export function setMinimumNights(room: Room, nights: number): Room {
  const main = mainOffer(room);
  if (main.restrictions.kind !== "own") throw new PricingError("pricing.stayRules.errorInherited");
  const restrictions = {
    ...main.restrictions,
    rules: { ...main.restrictions.rules, minArrivalNights: nights },
  };
  const result = parsePricingConfiguration({
    ...room,
    offers: room.offers.map((offer) => (offer.id === main.id ? { ...offer, restrictions } : offer)),
  });
  if (!result) throw new PricingError("pricing.stayRules.errorInvalid");
  return result;
}

/** "0–5 free · 6–17 €20 per night": each child age group and its nightly charge. */
export function childrenSummary(room: Room, t: Translate) {
  return room.children.bands
    .map((band) => {
      const ages =
        band.fromAge === band.throughAge
          ? String(band.fromAge)
          : `${band.fromAge}–${band.throughAge}`;
      return band.nightlyMinor === "0"
        ? t("pricing.steps.children.free", { ages })
        : t("pricing.steps.children.paid", {
            ages,
            amount: money(band.nightlyMinor, room.currency),
          });
    })
    .join(" · ");
}
