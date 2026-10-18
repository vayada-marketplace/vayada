import {
  calculateReplacementRoomStay,
  parsePricingConfiguration,
  pricingAmountStep,
  pricingCurrencyScale,
  projectReplacementRoomNights,
  type PricingConfiguration,
  type RoomNightProjectionResult,
  type RoomStayPricingResult,
} from "@vayada/domain-pms/replacement-pricing";
import {
  parseBookingPricingOfferTerms,
  pricingOfferNameKeys,
  publicOfferCancellation,
  type ReplacementOfferTerms,
} from "@vayada/domain-booking/replacement-pricing";
import { formatCurrency } from "@/lib/formatCurrency";
import type { PricingTermsInput } from "@/services/api/replacementPricingClient";
import { decimalAmount, parseMinorInput, PricingError, type Translate } from "./pricingAmounts";
import { paidInAdvance } from "@vayada/product-onboarding/AcceptedPaymentMethods";
import type { PaymentMethod } from "./AcceptedPaymentMethods";

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

/** Option names, since the engine stores none: from the meal plan and the cancellation terms ("Free cancellation",
 * "Breakfast included, non-refundable"), with the booking page's rule (VAY-2188). Without terms (still loading, or
 * failed) the meal plan and position name it. Later options with the same name are numbered. */
export function optionNames(
  room: Room,
  terms: Readonly<Record<string, OptionTerms | undefined>>,
  t: Translate,
) {
  const keys = pricingOfferNameKeys(
    room.offers.map((offer) => {
      const known = terms[offer.id];
      return {
        mealPlan: offer.meal.kind,
        cancellation: known ? publicOfferCancellation(known.cancellation) : null,
      };
    }),
  );
  return Object.fromEntries(
    room.offers.map((offer, index) => {
      const key = keys[index];
      if (!key.cancellation)
        return [
          offer.id,
          t("pricing.steps.name.fallback", {
            number: index + 1,
            meal: t(`pricing.meal.${offer.meal.kind}`),
          }),
        ];
      const kind = key.cancellation === "free" ? "flexible" : key.cancellation;
      const name = t(`pricing.steps.name.${kind}.${key.meal}`);
      return [
        offer.id,
        key.number ? t("pricing.steps.name.numbered", { name, number: key.number }) : name,
      ];
    }),
  );
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
  // What only the option's Edit window shows (the main option's live in steps 2-3 and More options).
  if (offer.id !== mainOffer(room).id) {
    const count = (key: string, value: number) => {
      if (value) parts.push(t(`${key}.${value === 1 ? "one" : "other"}`, { count: value }));
    };
    if (offer.price.kind === "independent") {
      const { seasons, months, weekdays, dates } = offer.price.calendar;
      count("pricing.steps.summary.seasons", seasons.length);
      count("pricing.steps.summary.months", months.length);
      count("pricing.steps.summary.weekdays", weekdays.length);
      count("pricing.steps.summary.dates", dates.length);
    } else {
      count("pricing.steps.summary.dates", offer.price.dateOverrides.length);
      if (offer.restrictions.kind === "own") parts.push(t("pricing.steps.summary.ownRules"));
    }
  }
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

/** The symbol shown inside the price field ("€"), or null when it would only repeat the currency code. */
export function currencySymbol(currency: string) {
  const symbol = formatCurrency(0, currency)
    .replace(/[\d\s.,]+$/, "")
    .trim();
  return symbol && symbol !== currency ? symbol : null;
}
/** A weekday or linked adjustment as a short text: "+15%", "−5%", "+€10". */
export function adjustmentText(
  adjustment: Calendar["weekdays"][number]["adjustment"],
  currency: string,
) {
  const value =
    adjustment.kind === "percentage" ? String(adjustment.basisPoints) : adjustment.deltaMinor;
  const sign = value.startsWith("-") ? "−" : "+";
  return adjustment.kind === "percentage"
    ? `${sign}${Math.abs(adjustment.basisPoints) / 100}%`
    : `${sign}${money(value.replace(/^-/, ""), currency)}`;
}
/** Whether two recurring seasons (MM-DD, possibly over the new year) share a day. */
export function seasonsOverlap(
  a: { from: string; through: string },
  b: { from: string; through: string },
) {
  for (let day = 0; day < 366; day++) {
    const date = new Date(Date.UTC(2000, 0, 1 + day)).toISOString().slice(5, 10);
    if (inSeason(date, a.from, a.through) && inSeason(date, b.from, b.through)) return true;
  }
  return false;
}

/** Guests for the tab's sample figures: 2 adults, or 1 when the room takes only one. */
export const sampleAdults = (room: Room) => Math.min(2, room.capacity.adults);
const termsRevisions = (room: Room) =>
  Object.fromEntries(room.offers.map((offer) => [offer.id, offer.termsRevision]));
/** An option's normal night for the sample guests, meal included (the cards' "€90", "€115"). It is the engine's
 * night evaluator on a copy of the room with only the normal prices (no seasons, months, weekdays or single dates),
 * so linked adjustments and rounding are the engine's. Null without a normal price. */
export function normalNight(room: Room, offerId: string): string | null {
  const plain = {
    ...room,
    offers: room.offers.map((offer) =>
      offer.price.kind === "independent"
        ? {
            ...offer,
            price: {
              ...offer.price,
              calendar: {
                ...offer.price.calendar,
                months: [],
                seasons: [],
                weekdays: [],
                dates: [],
              },
            },
          }
        : { ...offer, price: { ...offer.price, dateOverrides: [] } },
    ),
  };
  const [night] = projectReplacementRoomNights(
    plain,
    {
      propertyId: room.propertyId,
      roomTypeId: room.roomTypeId,
      offerId,
      expectedRevision: room.revision,
      expectedTermsRevisions: termsRevisions(room),
      guests: { adults: sampleAdults(room), childAgesAtCheckIn: [] },
    },
    ["2001-01-01"],
  );
  return night?.kind === "projected" ? night.night.totalMinor : null;
}

/** Quick-add presets: a meal plan and whether the option is non-refundable. */
export const presetKeys = [
  "non_refundable",
  "breakfast",
  "half_board",
  "non_refundable_breakfast",
] as const;
export type PresetKey = (typeof presetKeys)[number];
export const presets: Record<PresetKey, { meal: Offer["meal"]["kind"]; nonRefundable: boolean }> = {
  non_refundable: { meal: "room_only", nonRefundable: true },
  breakfast: { meal: "breakfast", nonRefundable: false },
  half_board: { meal: "half_board", nonRefundable: false },
  non_refundable_breakfast: { meal: "breakfast", nonRefundable: true },
};
/** Presets whose meal plan and cancellation no option of the room has yet. Options whose terms are unknown (still
 * loading, or failed) don't count, so a preset can show until their terms arrive. */
export function missingPresets(
  room: Room,
  terms: Readonly<Record<string, OptionTerms | undefined>>,
) {
  const taken = new Set(
    room.offers.flatMap((offer) => {
      const cancellation = terms[offer.id]?.cancellation.kind;
      return cancellation ? [`${offer.meal.kind}:${cancellation === "non_refundable"}`] : [];
    }),
  );
  // A meal preset copies the main option's cancellation, so with a non-refundable main option it would only add
  // another non-refundable option: then only the non-refundable presets are offered.
  const mainNonRefundable = terms[mainOffer(room).id]?.cancellation.kind === "non_refundable";
  return presetKeys.filter(
    (key) =>
      !taken.has(`${presets[key].meal}:${presets[key].nonRefundable}`) &&
      (presets[key].nonRefundable || !mainNonRefundable),
  );
}
export type PresetValues = {
  discount: string;
  mealAmount: string;
  mealBasis: "room" | "person";
  methods: readonly PaymentMethod[];
};
/** A new option from a preset: linked to the main option (`discount` percent cheaper when non-refundable, otherwise the
 * same price), inheriting its stay rules, with the preset's meal at `mealAmount` per room or per adult (children 0).
 * Its terms take the main option's payment with `methods`, and the main option's cancellation unless non-refundable. */
export function presetOption(
  room: Room,
  offerId: string,
  key: PresetKey,
  values: PresetValues,
  mainTerms: OptionTerms,
) {
  const preset = presets[key],
    main = mainOffer(room);
  const discount = values.discount.trim();
  if (
    preset.nonRefundable &&
    (!/^\d+(?:\.\d{1,2})?$/.test(discount) || Number(discount) <= 0 || Number(discount) >= 100)
  )
    throw new PricingError("pricing.steps.preset.errorDiscount");
  const adjustment = preset.nonRefundable
    ? { kind: "percentage" as const, basisPoints: -Math.round(Number(discount) * 100) }
    : { kind: "fixed" as const, deltaMinor: "0" };
  const amount =
    preset.meal === "room_only"
      ? "0"
      : parseMinorInput(
          values.mealAmount.trim(),
          pricingCurrencyScale(room.currency)!,
          true,
          pricingAmountStep(room.currency),
        );
  const meal =
    preset.meal === "room_only" || values.mealBasis === "room"
      ? { kind: preset.meal, charge: { kind: "room", amountMinor: amount } }
      : {
          kind: preset.meal,
          charge: {
            kind: "person",
            adultMinor: amount,
            childBandAmountsMinor: room.children.bands.map(() => "0"),
          },
        };
  if (!values.methods.length) throw new PricingError("pricing.error.paymentMethodRequired");
  const cancellation = preset.nonRefundable
    ? ({ kind: "non_refundable" } as const)
    : mainTerms.cancellation;
  // A non-refundable stay is paid in advance: pay at property is never sent with it (VAY-2280).
  const methods =
    cancellation.kind === "non_refundable" ? paidInAdvance(values.methods) : [...values.methods];
  if (!methods.length) throw new PricingError("pricing.error.nonRefundableNeedsAdvance");
  const payment = { ...mainTerms.payment, acceptedMethods: methods };
  if (
    !parseBookingPricingOfferTerms({
      roomTypeId: room.roomTypeId,
      offerId,
      revision: offerId,
      cancellation,
      payment,
    })
  )
    throw new PricingError("pricing.steps.preset.errorTerms");
  const configuration = parsePricingConfiguration({
    ...room,
    offers: [
      ...room.offers,
      {
        id: offerId,
        termsRevision: offerId,
        meal,
        price: { kind: "linked", parentId: main.id, adjustment, dateOverrides: [] },
        restrictions: { kind: "inherit" },
      },
    ],
  });
  if (!configuration) throw new PricingError("pricing.linkedOffer.errorConfiguration");
  const terms: PricingTermsInput = {
    roomTypeId: room.roomTypeId,
    offerId,
    expectedRevision: null,
    cancellation,
    payment,
  };
  return { configuration, terms };
}

/** Why an option can't be deleted: it is the room's only option, or other options are based on it. */
export function deleteBlocker(
  room: Room,
  offerId: string,
): { kind: "only" } | { kind: "dependents"; ids: string[] } | null {
  if (room.offers.length === 1) return { kind: "only" };
  const ids = room.offers
    .filter((offer) => offer.price.kind === "linked" && offer.price.parentId === offerId)
    .map((offer) => offer.id);
  return ids.length ? { kind: "dependents", ids } : null;
}
/** The room without the option. When it was the main option, the next option with its own prices becomes main. */
export function deleteOption(room: Room, offerId: string): Room {
  if (deleteBlocker(room, offerId)) throw new PricingError("pricing.steps.delete.errorBlocked");
  const result = parsePricingConfiguration({
    ...room,
    offers: room.offers.filter((offer) => offer.id !== offerId),
  });
  if (!result) throw new PricingError("pricing.steps.delete.errorBlocked");
  return result;
}

/** More options' summary line: what it holds for the main option ("2 monthly prices · 1 single date"), or null when
 * nothing is set there, so a setup the steps don't show is never hidden behind the closed row. */
export function moreOptionsSummary(room: Room, t: Translate) {
  const main = mainOffer(room);
  const calendar = main.price.kind === "independent" ? main.price.calendar : null;
  const restrictions = main.restrictions.kind === "own" ? main.restrictions : null;
  const count = (key: string, value: number) =>
    value ? [t(`${key}.${value === 1 ? "one" : "other"}`, { count: value })] : [];
  const rules = restrictions?.rules;
  const parts = [
    ...count("pricing.steps.more.months", calendar?.months.length ?? 0),
    ...count("pricing.steps.more.dates", calendar?.dates.length ?? 0),
    ...count(
      "pricing.steps.more.exceptions",
      (restrictions?.dates.length ?? 0) + (restrictions?.seasons.length ?? 0),
    ),
    ...(rules &&
    (rules.maxStayNights !== null ||
      rules.closedToArrival ||
      rules.closedToDeparture ||
      rules.stopSell)
      ? [t("pricing.steps.more.advanced")]
      : []),
  ];
  return parts.length ? parts.join(" · ") : null;
}

/** `date` (YYYY-MM-DD) moved by `days`, in UTC like the engine's calendar. */
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
/** The guest preview's sample stay: the main option's minimum nights (at least 2), from the next Friday after
 * `today`, so weekend prices show. */
export function sampleStay(room: Room, today: string) {
  const main = mainOffer(room);
  const nights = Math.max(
    2,
    main.restrictions.kind === "own" ? main.restrictions.rules.minArrivalNights : 1,
  );
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const checkIn = addDays(today, (5 - weekday + 7) % 7 || 7);
  return { checkIn, checkOut: addDays(checkIn, nights) };
}
/** Each option's total for a stay of the sample guests: the engine's stay calculation, as in the stay check. */
export function stayTotals(
  room: Room,
  checkIn: string,
  checkOut: string,
): Record<string, RoomStayPricingResult> {
  return Object.fromEntries(
    room.offers.map((offer) => [
      offer.id,
      calculateReplacementRoomStay(room, {
        propertyId: room.propertyId,
        roomTypeId: room.roomTypeId,
        offerId: offer.id,
        expectedRevision: room.revision,
        expectedTermsRevisions: termsRevisions(room),
        checkIn,
        checkOut,
        guests: { adults: sampleAdults(room), childAgesAtCheckIn: [] },
      }),
    ]),
  );
}
/** Every night of a month (`month` is "YYYY-MM") for one option and `adults` (the sample guests unless given): the
 * engine's night evaluator, the one Channex nightly prices use. Each night also carries its own stay rules. */
export function monthNights(
  room: Room,
  offerId: string,
  month: string,
  adults: number = sampleAdults(room),
): { date: string; night: RoomNightProjectionResult }[] {
  const days = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  ).getUTCDate();
  const dates = Array.from(
    { length: days },
    (_, day) => `${month}-${String(day + 1).padStart(2, "0")}`,
  );
  const nights = projectReplacementRoomNights(
    room,
    {
      propertyId: room.propertyId,
      roomTypeId: room.roomTypeId,
      offerId,
      expectedRevision: room.revision,
      expectedTermsRevisions: termsRevisions(room),
      guests: { adults, childAgesAtCheckIn: [] },
    },
    dates,
  );
  return dates.map((date, index) => ({ date, night: nights[index] }));
}
