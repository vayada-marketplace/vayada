import {
  parsePricingConfiguration,
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import type { PricingPaymentMethod } from "@vayada/domain-booking/replacement-pricing";
import { decimalAmount, PricingError } from "./pricingAmounts";
import { changeLinkedAdjustment } from "./PricingLinkedAdjustment";
import { changeMealCharges } from "./PricingMealCharges";
import {
  deleteBlocker,
  mainOffer,
  otherWeekdays,
  presetOption,
  weekendChoice,
  type OptionTerms,
} from "./stepPricing";

/** The simple Prices card (VAY-2188): a lens over the same pricing-v2 room and terms. It reads the main option, its
 * cancellation and the two options its switches stand for; everything else is listed under More options, unchanged.
 * Every edit here goes back through `parsePricingConfiguration` and changes only its own part. */
type Room = PricingConfiguration;
type Offer = Room["offers"][number];
type Terms = Readonly<Record<string, OptionTerms | undefined>>;
type Cancellation = OptionTerms["cancellation"];

/** The free-cancellation deadlines the card offers, in days before arrival; a saved other number is shown too. */
export const cancellationDays = [1, 2, 3, 5, 7, 14, 30] as const;
/** A first price's defaults: free cancellation until 3 days before arrival, a non-refundable option 10% cheaper. */
export const defaultFreeDays = 3;
export const defaultDiscount = "10";

/** The main option's cancellation as the card shows it. "own": the hotel's own terms (a partial refund or a text),
 * which only the option's window edits. */
export type SimpleCancellation =
  | { kind: "free"; days: number }
  | { kind: "non_refundable" }
  | { kind: "own" };
export function simpleCancellation(cancellation: Cancellation): SimpleCancellation {
  if (cancellation.kind === "non_refundable") return { kind: "non_refundable" };
  const terms = cancellation.terms;
  const plain =
    (terms.flexibleCancellationType ?? "free") === "free" &&
    terms.text === undefined &&
    terms.partialRefundCancelWindowDays === undefined &&
    terms.partialRefundAmountPercent === undefined &&
    terms.partialRefundTiers === undefined;
  return plain ? { kind: "free", days: terms.freeCancellationDeadlineDays } : { kind: "own" };
}
/** Terms for a card choice: no refund, or free until `days` before arrival with the full amount after that. */
export function cancellationTerms(
  choice: Exclude<SimpleCancellation, { kind: "own" }>,
): Cancellation {
  return choice.kind === "non_refundable"
    ? { kind: "non_refundable" }
    : {
        kind: "flexible",
        terms: {
          type: "free_until_days_before_arrival",
          freeCancellationDeadlineDays: choice.days,
          afterDeadlinePenalty: "full_booking_amount",
          noShowPenalty: "full_booking_amount",
        },
      };
}

/** Key order doesn't matter for terms read back from the server. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The card's view of a room, or null while an option's terms are still unknown. */
export type SimpleRoom = {
  main: Offer;
  mainTerms: OptionTerms;
  cancellation: SimpleCancellation;
  /** The room-only option non-refundable and a percentage cheaper than the main option, if there is one. */
  nonRefundable: Offer | null;
  /** The breakfast option at the main option's price, with its cancellation and payment, if there is one. */
  breakfast: Offer | null;
  /** Every other option, in the room's order (More options lists them with their own windows). */
  others: Offer[];
};
export function simpleRoom(room: Room, terms: Terms): SimpleRoom | null {
  if (room.offers.some((offer) => !terms[offer.id])) return null;
  const main = mainOffer(room),
    mainTerms = terms[main.id]!,
    cancellation = simpleCancellation(mainTerms.cancellation);
  // A switch stands for an option based on the main option with nothing of its own: no date prices, the main
  // option's stay rules and payment, and no options based on it (switching it off deletes it).
  const plainLinked = (offer: Offer) =>
    offer.id !== main.id &&
    offer.price.kind === "linked" &&
    offer.price.parentId === main.id &&
    offer.price.dateOverrides.length === 0 &&
    offer.restrictions.kind === "inherit" &&
    !deleteBlocker(room, offer.id) &&
    same(terms[offer.id]!.payment, mainTerms.payment);
  const nonRefundable =
    cancellation.kind === "free"
      ? (room.offers.find(
          (offer) =>
            plainLinked(offer) &&
            offer.meal.kind === "room_only" &&
            offer.price.kind === "linked" &&
            offer.price.adjustment.kind === "percentage" &&
            offer.price.adjustment.basisPoints < 0 &&
            terms[offer.id]!.cancellation.kind === "non_refundable",
        ) ?? null)
      : null;
  const breakfast =
    cancellation.kind === "own"
      ? null
      : (room.offers.find(
          (offer) =>
            plainLinked(offer) &&
            offer.meal.kind === "breakfast" &&
            (offer.meal.charge.kind === "room" ||
              offer.meal.charge.childBandAmountsMinor.every((amount) => amount === "0")) &&
            offer.price.kind === "linked" &&
            offer.price.adjustment.kind === "fixed" &&
            offer.price.adjustment.deltaMinor === "0" &&
            same(terms[offer.id]!.cancellation, mainTerms.cancellation),
        ) ?? null);
  return {
    main,
    mainTerms,
    cancellation,
    nonRefundable,
    breakfast,
    others: room.offers.filter(
      (offer) => offer !== main && offer !== nonRefundable && offer !== breakfast,
    ),
  };
}

/** A switch turned on: a new option based on the main option, with its stay rules and payment. Non-refundable is
 * `percent` cheaper; breakfast keeps the price and adds `amount` per room or per adult (children 0). */
export function switchOption(
  room: Room,
  offerId: string,
  kind: "non_refundable" | "breakfast",
  value: { percent: string } | { amount: string; basis: "room" | "person" },
  mainTerms: OptionTerms,
) {
  return presetOption(
    room,
    offerId,
    kind,
    {
      discount: "percent" in value ? value.percent : defaultDiscount,
      mealAmount: "amount" in value ? value.amount : "",
      mealBasis: "basis" in value ? value.basis : "room",
      methods: [...(mainTerms.payment.acceptedMethods ?? [])],
    },
    mainTerms,
  );
}
/** The non-refundable option `percent` (0 < percent < 100, two decimals at most) cheaper. */
export function setDiscount(room: Room, offerId: string, percent: string): Room {
  const value = percent.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) <= 0 || Number(value) >= 100)
    throw new PricingError("pricing.steps.preset.errorDiscount");
  return changeLinkedAdjustment(room, offerId, { kind: "percentage", value: `-${value}` });
}
/** The breakfast option's price per room or per adult; children's breakfast stays as it is. */
export function setBreakfastAmount(room: Room, offerId: string, amount: string): Room {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.meal.kind === "room_only")
    throw new PricingError("pricing.mealCharges.errorOffer");
  const charge = offer.meal.charge,
    scale = pricingCurrencyScale(room.currency);
  if (scale === null) throw new PricingError("pricing.error.currencyUnavailable");
  // changeMealCharges takes every amount as typed; the children's are passed back unchanged.
  return changeMealCharges(room, offerId, [
    amount,
    ...(charge.kind === "person"
      ? charge.childBandAmountsMinor.map((minor) => decimalAmount(minor, scale))
      : []),
  ]);
}

/** New terms for the options the card's cancellation covers: the main option and the breakfast option that follows
 * it. The non-refundable option keeps its own. */
export function cancellationEdits(
  simple: SimpleRoom,
  terms: Terms,
  choice: Exclude<SimpleCancellation, { kind: "own" }>,
): { offerId: string; terms: OptionTerms }[] {
  const cancellation = cancellationTerms(choice);
  return [simple.main, ...(simple.breakfast ? [simple.breakfast] : [])].map((offer) => ({
    offerId: offer.id,
    terms: { ...terms[offer.id]!, cancellation },
  }));
}
/** New terms for every option the card covers (main and both switches), accepting `methods`. */
export function paymentEdits(
  simple: SimpleRoom,
  terms: Terms,
  methods: readonly PricingPaymentMethod[],
): { offerId: string; terms: OptionTerms }[] {
  if (!methods.length) throw new PricingError("pricing.error.paymentMethodRequired");
  return [simple.main, simple.nonRefundable, simple.breakfast]
    .filter((offer): offer is Offer => !!offer)
    .map((offer) => {
      const current = terms[offer.id]!;
      return {
        offerId: offer.id,
        terms: { ...current, payment: { ...current.payment, acceptedMethods: [...methods] } },
      };
    });
}

type Calendar = Extract<Offer["price"], { kind: "independent" }>["calendar"];
type Price = NonNullable<Calendar["base"]>;
/** Rewrites the main option's normal, monthly and season prices (one mode, as the engine requires) with `next`.
 * Single-date prices keep theirs. */
function repriceMain(room: Room, next: (price: Price) => Price): Room {
  const main = mainOffer(room);
  if (main.price.kind !== "independent") throw new PricingError("pricing.error.offerMissing");
  const calendar = main.price.calendar;
  const result = parsePricingConfiguration({
    ...room,
    offers: room.offers.map((offer) =>
      offer.id === main.id
        ? {
            ...offer,
            price: {
              ...main.price,
              calendar: {
                ...calendar,
                base: calendar.base && next(calendar.base),
                months: calendar.months.map((entry) => ({ ...entry, price: next(entry.price) })),
                seasons: calendar.seasons.map((entry) => ({ ...entry, price: next(entry.price) })),
              },
            },
          }
        : offer,
    ),
  });
  if (!result) throw new PricingError("pricing.setup.errorConfiguration");
  return result;
}
/** "Price by number of guests": one price for the room becomes the same price for each adult count, so no price
 * changes until the hotel types the counts' own prices. */
export function pricePerAdultCount(room: Room): Room {
  return repriceMain(room, (price) => {
    if (price.mode !== "flat") throw new PricingError("pricing.setup.errorMode");
    return {
      mode: "occupancy",
      amountsMinor: Array.from({ length: room.capacity.adults }, () => price.amountMinor),
    };
  });
}
/** Back to one price for the room, only when every adult count costs the same everywhere (nothing changes); null
 * otherwise. */
export function onePriceAgain(room: Room): Room | null {
  const main = mainOffer(room);
  if (main.price.kind !== "independent") return null;
  const { base, months, seasons } = main.price.calendar;
  const prices = [
    ...(base ? [base] : []),
    ...months.map((entry) => entry.price),
    ...seasons.map((entry) => entry.price),
  ];
  const equal = (price: Price) =>
    price.mode === "occupancy" && new Set(price.amountsMinor).size === 1;
  if (!prices.length || !prices.every(equal)) return null;
  return repriceMain(room, (price) =>
    price.mode === "occupancy" ? { mode: "flat", amountMinor: price.amountsMinor[0] } : price,
  );
}

/** Whether the room has settings the card's top doesn't show (other options, prices by guests, own cancellation or
 * weekday rules, month prices, season stay rules): the card then says they are kept. Single-date prices and date
 * stay rules show in "Prices by date" and its night panel (VAY-2280), so they don't count. */
export function hasKeptSettings(room: Room, simple: SimpleRoom): boolean {
  const { main } = simple;
  const calendar = main.price.kind === "independent" ? main.price.calendar : null;
  const restrictions = main.restrictions.kind === "own" ? main.restrictions : null;
  return (
    simple.others.length > 0 ||
    simple.cancellation.kind === "own" ||
    (calendar?.base != null && calendar.base.mode !== "flat") ||
    (calendar?.months.length ?? 0) > 0 ||
    otherWeekdays(main).length > 0 ||
    weekendChoice(main) === "other" ||
    !restrictions ||
    restrictions.seasons.length > 0
  );
}
