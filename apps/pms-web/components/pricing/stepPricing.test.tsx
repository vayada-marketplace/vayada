import { describe, expect, it } from "vitest";
import {
  parsePricingConfiguration,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { english } from "./pricingAmounts";
import {
  addDays,
  childrenSummary,
  deleteBlocker,
  deleteOption,
  mainOffer,
  missingPresets,
  money,
  monthNights,
  normalNight,
  presetOption,
  sampleStay,
  stayTotals,
  optionNames,
  optionSummary,
  otherWeekdays,
  ownRuleOptions,
  setMinimumNights,
  setWeekend,
  weekendChoice,
  yearPieces,
  type OptionTerms,
} from "./stepPricing";

const rules = (minArrivalNights = 1, maxStayNights: number | null = null) => ({
  minArrivalNights,
  maxStayNights,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
});
const roomOnly = { kind: "room_only", charge: { kind: "room", amountMinor: "0" } };
const flat = (amountMinor: string) => ({ mode: "flat", amountMinor });
const calendar = (extra: Record<string, unknown> = {}) => ({
  base: flat("10000"),
  months: [],
  seasons: [],
  weekdays: [],
  dates: [],
  ...extra,
});
const linked = (
  id: string,
  parentId: string,
  adjustment: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id,
  termsRevision: `${id}-terms`,
  meal: roomOnly,
  price: { kind: "linked", parentId, adjustment, dateOverrides: [] },
  restrictions: { kind: "inherit" },
  ...extra,
});
const room = (offers: unknown[], currency = "EUR"): PricingConfiguration => {
  const parsed = parsePricingConfiguration({
    version: "pricing.v2",
    propertyId: "property",
    roomTypeId: "room",
    revision: 1,
    currency,
    capacity: { total: 3, adults: 2, children: 1 },
    children: {
      adultFromAge: 18,
      bands: [
        { fromAge: 0, throughAge: 5, nightlyMinor: "0", countsTowardCapacity: true },
        { fromAge: 6, throughAge: 17, nightlyMinor: "2000", countsTowardCapacity: true },
      ],
    },
    offers,
  });
  if (!parsed) throw new Error("invalid fixture");
  return parsed;
};
const main = (
  extra: Record<string, unknown> = {},
  restrictions: Record<string, unknown> = { kind: "own", rules: rules(2), seasons: [], dates: [] },
) => ({
  id: "flexible",
  termsRevision: "flexible-terms",
  meal: roomOnly,
  price: { kind: "independent", calendar: calendar(extra) },
  restrictions,
});
/** The Paper design's room: €100, Low and High seasons, weekends +15%, Flexible / Non-refundable / With breakfast. */
const design = room([
  main({
    seasons: [
      { name: "Low", tier: "Low", from: "01-01", through: "03-31", price: flat("8000") },
      { name: "High", tier: "High", from: "07-01", through: "08-31", price: flat("14000") },
    ],
    weekdays: [
      { day: 4, adjustment: { kind: "percentage", basisPoints: 1500 } },
      { day: 5, adjustment: { kind: "percentage", basisPoints: 1500 } },
    ],
  }),
  linked("nonrefundable", "flexible", { kind: "percentage", basisPoints: -1000 }),
  linked(
    "breakfast",
    "flexible",
    { kind: "fixed", deltaMinor: "0" },
    { meal: { kind: "breakfast", charge: { kind: "room", amountMinor: "1500" } } },
  ),
]);
const flexibleTerms = (days = 7): OptionTerms =>
  ({
    cancellation: {
      kind: "flexible",
      terms: {
        type: "free_until_days_before_arrival",
        freeCancellationDeadlineDays: days,
        afterDeadlinePenalty: "full_booking_amount",
        noShowPenalty: "full_booking_amount",
      },
    },
    payment: { kind: "full", acceptedMethods: ["card"] },
  }) as OptionTerms;
const nonRefundable: OptionTerms = {
  cancellation: { kind: "non_refundable" },
  payment: { kind: "full", acceptedMethods: ["card"] },
};
const designTerms = {
  flexible: flexibleTerms(),
  nonrefundable: nonRefundable,
  breakfast: flexibleTerms(),
};

describe("option names and summaries", () => {
  it("names options from meal and cancellation, falls back to the meal plan, and numbers repeats", () => {
    expect(optionNames(design, designTerms, english)).toEqual({
      flexible: "Free cancellation",
      nonrefundable: "Non-refundable",
      breakfast: "Breakfast included",
    });
    expect(optionNames(design, { flexible: flexibleTerms() }, english)).toEqual({
      flexible: "Free cancellation",
      nonrefundable: "Option 2 · room only",
      breakfast: "Option 3 · breakfast",
    });
    expect(
      optionNames(
        design,
        { flexible: flexibleTerms(), nonrefundable: flexibleTerms(3), breakfast: nonRefundable },
        english,
      ),
    ).toEqual({
      flexible: "Free cancellation",
      nonrefundable: "Free cancellation 2",
      breakfast: "Breakfast included, non-refundable",
    });
    // The booking page's words (VAY-2188): a partial refund isn't called free cancellation.
    const partial = {
      ...flexibleTerms(14),
      cancellation: {
        kind: "flexible",
        terms: {
          ...(flexibleTerms(14).cancellation as { terms: object }).terms,
          flexibleCancellationType: "partial_refund",
          partialRefundAmountPercent: 50,
        },
      },
    } as OptionTerms;
    expect(optionNames(design, { ...designTerms, flexible: partial }, english).flexible).toBe(
      "Partial refund",
    );
  });
  it("summarises meal, price relation and cancellation like the design's cards", () => {
    const names = optionNames(design, designTerms, english);
    const summary = (id: string, terms?: OptionTerms) =>
      optionSummary(design, design.offers.find((offer) => offer.id === id)!, names, terms, english);
    expect(summary("flexible", flexibleTerms())).toBe(
      "Room only · Free cancellation up to 7 days before",
    );
    expect(summary("nonrefundable", nonRefundable)).toBe(
      "Room only · 10% cheaper · No refund if cancelled",
    );
    expect(summary("breakfast", flexibleTerms(1))).toBe(
      "Breakfast +€15 · Free cancellation up to 1 day before",
    );
    expect(summary("breakfast", flexibleTerms(0))).toBe(
      "Breakfast +€15 · Free cancellation until arrival",
    );
    expect(summary("breakfast")).toBe("Breakfast +€15");
  });
  it("shows chains, own prices, per-adult meals and fixed adjustments", () => {
    const chain = room([
      main(),
      {
        ...main(),
        id: "package",
        price: {
          kind: "independent",
          calendar: calendar({ base: { mode: "flat", amountMinor: "7000" } }),
        },
        meal: {
          kind: "half_board",
          charge: { kind: "person", adultMinor: "2500", childBandAmountsMinor: ["0", "1200"] },
        },
      },
      linked("early", "package", { kind: "fixed", deltaMinor: "-500" }),
      linked("late", "flexible", { kind: "percentage", basisPoints: 250 }),
    ]);
    const names = optionNames(
      chain,
      { flexible: flexibleTerms(), package: flexibleTerms(), early: nonRefundable },
      english,
    );
    const summary = (id: string) =>
      optionSummary(
        chain,
        chain.offers.find((offer) => offer.id === id)!,
        names,
        undefined,
        english,
      );
    expect(summary("package")).toBe("Half board €25 per adult · Own prices");
    expect(summary("early")).toBe("Room only · Based on Half board · €5 cheaper");
    expect(summary("late")).toBe("Room only · 2.5% more");
    expect(mainOffer(chain).id).toBe("flexible");
  });
  it("finds the main option even when a linked offer comes first", () => {
    const reordered = room([
      linked("nonrefundable", "flexible", { kind: "percentage", basisPoints: -1000 }),
      main(),
    ]);
    expect(mainOffer(reordered).id).toBe("flexible");
  });
  it("prints money as guests read it", () => {
    expect(money("10000", "EUR")).toBe("€100");
    expect(money("10050", "EUR")).toBe("€100.50");
    expect(money("-500", "EUR")).toBe("−€5");
    expect(money("150000000", "IDR")).toBe(`IDR ${(1500000).toLocaleString()}`);
  });
});

describe("weekend step", () => {
  const offer = (weekdays: unknown[]) => room([main({ weekdays })]).offers[0];
  it("reads No, a chip, or Other days from the Friday and Saturday rules", () => {
    expect(weekendChoice(offer([]))).toBe("none");
    expect(weekendChoice(mainOffer(design))).toBe(1500);
    expect(
      weekendChoice(offer([{ day: 4, adjustment: { kind: "percentage", basisPoints: 1500 } }])),
    ).toBe("other");
    expect(
      weekendChoice(
        offer([
          { day: 4, adjustment: { kind: "percentage", basisPoints: 1000 } },
          { day: 5, adjustment: { kind: "percentage", basisPoints: 2000 } },
        ]),
      ),
    ).toBe("other");
    expect(
      weekendChoice(
        offer([
          { day: 4, adjustment: { kind: "fixed", deltaMinor: "1000" } },
          { day: 5, adjustment: { kind: "fixed", deltaMinor: "1000" } },
        ]),
      ),
    ).toBe("other");
    expect(
      weekendChoice(offer([{ day: 6, adjustment: { kind: "percentage", basisPoints: -500 } }])),
    ).toBe("none");
  });
  it("sets and clears only Friday and Saturday, keeping other days", () => {
    const sunday = { day: 6, adjustment: { kind: "percentage", basisPoints: -500 } };
    const start = room([
      main({ weekdays: [{ day: 4, adjustment: { kind: "fixed", deltaMinor: "700" } }, sunday] }),
    ]);
    const set = setWeekend(start, "flexible", 2000);
    expect(mainOffer(set).price).toMatchObject({
      calendar: {
        weekdays: [
          { day: 4, adjustment: { kind: "percentage", basisPoints: 2000 } },
          { day: 5, adjustment: { kind: "percentage", basisPoints: 2000 } },
          sunday,
        ],
      },
    });
    const cleared = setWeekend(set, "flexible", null);
    expect(otherWeekdays(mainOffer(cleared))).toEqual([sunday]);
    expect(weekendChoice(mainOffer(cleared))).toBe("none");
    expect(() => setWeekend(design, "nonrefundable", 1000)).toThrow();
  });
});

describe("year bar", () => {
  it("splits the year into seasons and normal stretches, toned against the normal price", () => {
    const pieces = yearPieces(mainOffer(design));
    expect(pieces.map((piece) => [piece.source.kind, piece.start, piece.days, piece.tone])).toEqual(
      [
        ["season", 0, 91, "low"],
        ["base", 91, 91, "normal"],
        ["season", 182, 62, "high"],
        ["base", 244, 122, "normal"],
      ],
    );
  });
  it("draws a season over the new year as two pieces and month prices in the gaps", () => {
    const offer = room([
      main({
        base: flat("10000"),
        months: [{ month: 6, price: flat("12000") }],
        seasons: [
          { name: "Winter", tier: "", from: "12-20", through: "01-05", price: flat("9000") },
        ],
      }),
    ]).offers[0];
    const pieces = yearPieces(offer);
    expect(pieces[0]).toMatchObject({
      source: { kind: "season", index: 0 },
      start: 0,
      days: 5,
      tone: "low",
    });
    expect(pieces.find((piece) => piece.source.kind === "month")).toMatchObject({
      source: { kind: "month", month: 6 },
      days: 30,
      tone: "high",
    });
    expect(pieces.at(-1)).toMatchObject({ source: { kind: "season", index: 0 }, days: 12 });
    expect(pieces.reduce((sum, piece) => sum + piece.days, 0)).toBe(366);
  });
  it("marks days without any price when there is no normal price", () => {
    const offer = room([main({ base: null, months: [{ month: 1, price: flat("9000") }] })])
      .offers[0];
    expect(yearPieces(offer).map((piece) => piece.source.kind)).toEqual(["month", "none"]);
  });
});

describe("stay rules and children", () => {
  it("changes the main option's minimum nights and names options with their own rules", () => {
    const mixed = room([
      main({}, { kind: "own", rules: rules(2, 14), seasons: [], dates: [] }),
      linked("nonrefundable", "flexible", { kind: "percentage", basisPoints: -1000 }),
      linked(
        "early",
        "flexible",
        { kind: "percentage", basisPoints: -500 },
        { restrictions: { kind: "own", rules: rules(4), seasons: [], dates: [] } },
      ),
      linked("early-nonref", "early", { kind: "fixed", deltaMinor: "-500" }),
    ]);
    expect(ownRuleOptions(mixed).map((offer) => offer.id)).toEqual(["early", "early-nonref"]);
    const changed = setMinimumNights(mixed, 3);
    expect(mainOffer(changed).restrictions).toEqual({
      kind: "own",
      rules: rules(3, 14),
      seasons: [],
      dates: [],
    });
    expect(changed.offers.slice(1)).toEqual(mixed.offers.slice(1));
    expect(() => setMinimumNights(mixed, 15)).toThrow();
    expect(() => setMinimumNights(mixed, 0)).toThrow();
  });
  it("summarises the child age groups", () => {
    expect(childrenSummary(design, english)).toBe("0–5 free · 6–17 €20 per night");
  });
});

describe("option prices, presets and deleting", () => {
  const roomTypeId = "61000000-0000-4000-8000-000000000009",
    offerId = "61000000-0000-4000-8000-00000000000a";
  const priced = { ...design, roomTypeId };
  it("prices each option's normal night with the engine, meals included, ignoring seasons and weekends", () => {
    expect(design.offers.map((offer) => normalNight(design, offer.id))).toEqual([
      "10000",
      "9000",
      "11500",
    ]);
    const noBase = room([main({ base: null, months: [{ month: 1, price: flat("9000") }] })]);
    expect(normalNight(noBase, "flexible")).toBeNull();
    const perAdult = room([main({ base: { mode: "per_person", unitMinor: "7000" } })]);
    expect(normalNight(perAdult, "flexible")).toBe("14000");
    // A room for one adult prices one adult.
    const single = parsePricingConfiguration({
      ...perAdult,
      capacity: { total: 1, adults: 1, children: 0 },
    })!;
    expect(normalNight(single, "flexible")).toBe("7000");
    // IDR prices in whole rupiah: 10% off 100,001 rounds half-up to 90,001.
    const rupiah = room(
      [
        main({ base: flat("10000100") }),
        linked("nonrefundable", "flexible", { kind: "percentage", basisPoints: -1000 }),
      ],
      "IDR",
    );
    expect(normalNight(rupiah, "nonrefundable")).toBe("9000100");
  });
  it("offers the presets the room lacks, counting only options whose terms are known", () => {
    expect(missingPresets(design, designTerms)).toEqual(["half_board", "non_refundable_breakfast"]);
    expect(missingPresets(design, { flexible: flexibleTerms() })).toEqual([
      "non_refundable",
      "breakfast",
      "half_board",
      "non_refundable_breakfast",
    ]);
    // A meal preset would copy a non-refundable main option's cancellation, so only non-refundable presets show.
    expect(missingPresets(design, { flexible: nonRefundable })).toEqual([
      "non_refundable_breakfast",
    ]);
  });
  it("builds a preset option linked to the main option, with its terms", () => {
    const methods = ["card"] as const;
    const added = presetOption(
      priced,
      offerId,
      "non_refundable",
      { discount: "12.5", mealAmount: "", mealBasis: "room", methods },
      flexibleTerms(),
    );
    expect(added.configuration.offers.at(-1)).toEqual({
      id: offerId,
      termsRevision: offerId,
      meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: {
        kind: "linked",
        parentId: "flexible",
        adjustment: { kind: "percentage", basisPoints: -1250 },
        dateOverrides: [],
      },
      restrictions: { kind: "inherit" },
    });
    expect(added.terms).toEqual({
      roomTypeId,
      offerId,
      expectedRevision: null,
      cancellation: { kind: "non_refundable" },
      payment: { kind: "full", acceptedMethods: ["card"] },
    });
    const half = presetOption(
      priced,
      offerId,
      "half_board",
      { discount: "", mealAmount: "25", mealBasis: "person", methods },
      flexibleTerms(3),
    );
    expect(half.configuration.offers.at(-1)).toMatchObject({
      meal: {
        kind: "half_board",
        charge: { kind: "person", adultMinor: "2500", childBandAmountsMinor: ["0", "0"] },
      },
      price: { adjustment: { kind: "fixed", deltaMinor: "0" } },
    });
    expect(half.terms.cancellation).toEqual(flexibleTerms(3).cancellation);
    // A non-refundable option is paid in advance: pay at property is left out, and alone it can't be (VAY-2280).
    expect(
      presetOption(
        priced,
        offerId,
        "non_refundable_breakfast",
        {
          discount: "10",
          mealAmount: "15",
          mealBasis: "room",
          methods: ["pay_at_property", "card"],
        },
        flexibleTerms(),
      ).terms.payment.acceptedMethods,
    ).toEqual(["card"]);
    expect(() =>
      presetOption(
        priced,
        offerId,
        "non_refundable",
        { discount: "10", mealAmount: "", mealBasis: "room", methods: ["pay_at_property"] },
        flexibleTerms(),
      ),
    ).toThrow("Non-refundable stays are paid in advance.");
    expect(half.terms.payment.acceptedMethods).toEqual(["card"]);
    for (const values of [
      { discount: "0", mealAmount: "", mealBasis: "room" as const, methods },
      { discount: "100", mealAmount: "", mealBasis: "room" as const, methods },
      { discount: "10", mealAmount: "", mealBasis: "room" as const, methods: [] },
    ])
      expect(() =>
        presetOption(priced, offerId, "non_refundable", values, flexibleTerms()),
      ).toThrow();
    expect(() =>
      presetOption(
        priced,
        offerId,
        "breakfast",
        { discount: "", mealAmount: "", mealBasis: "room", methods },
        flexibleTerms(),
      ),
    ).toThrow();
  });
  it("deletes an option unless it is the only one or others are based on it", () => {
    expect(deleteBlocker(design, "flexible")).toEqual({
      kind: "dependents",
      ids: ["nonrefundable", "breakfast"],
    });
    expect(deleteBlocker(room([main()]), "flexible")).toEqual({ kind: "only" });
    expect(deleteBlocker(design, "breakfast")).toBeNull();
    expect(deleteOption(design, "breakfast").offers.map((offer) => offer.id)).toEqual([
      "flexible",
      "nonrefundable",
    ]);
    expect(() => deleteOption(design, "flexible")).toThrow();
    const two = room([main(), { ...main(), id: "package" }]);
    expect(mainOffer(deleteOption(two, "flexible")).id).toBe("package");
  });
});

describe("option card counts", () => {
  it("counts what only an option's Edit window shows", () => {
    const busy = room([
      main(),
      {
        ...main({
          seasons: [
            { name: "Summer", tier: "", from: "06-01", through: "08-31", price: flat("12000") },
          ],
          months: [{ month: 12, price: flat("13000") }],
          dates: [
            { date: "2026-12-31", price: flat("20000") },
            { date: "2027-01-01", price: flat("20000") },
          ],
        }),
        id: "package",
      },
      linked(
        "early",
        "package",
        { kind: "fixed", deltaMinor: "-500" },
        {
          price: {
            kind: "linked",
            parentId: "package",
            adjustment: { kind: "fixed", deltaMinor: "-500" },
            dateOverrides: [{ date: "2026-08-15", price: flat("9000") }],
          },
          restrictions: { kind: "own", rules: rules(4), seasons: [], dates: [] },
        },
      ),
    ]);
    const names = optionNames(busy, {}, english);
    const summary = (id: string) =>
      optionSummary(busy, busy.offers.find((offer) => offer.id === id)!, names, undefined, english);
    expect(summary("flexible")).toBe("Room only");
    expect(summary("package")).toBe(
      "Room only · Own prices · 1 season · 1 monthly price · 2 single dates",
    );
    expect(summary("early")).toBe(
      "Room only · Based on Option 2 · room only · €5 cheaper · 1 single date · Own stay rules",
    );
  });
});

describe("guest preview and price calendar", () => {
  it("starts the sample stay on the next Friday for at least two nights", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(sampleStay(design, "2026-10-11")).toEqual({
      checkIn: "2026-10-16",
      checkOut: "2026-10-18",
    });
    expect(sampleStay(design, "2026-10-16")).toEqual({
      checkIn: "2026-10-23",
      checkOut: "2026-10-25",
    });
    const three = setMinimumNights(design, 3);
    expect(sampleStay(three, "2026-10-14")).toEqual({
      checkIn: "2026-10-16",
      checkOut: "2026-10-19",
    });
  });
  it("totals each option for the sample stay with the engine (the design's July weekend)", () => {
    const totals = stayTotals(design, "2026-07-18", "2026-07-20");
    expect(
      Object.fromEntries(
        Object.entries(totals).map(([id, result]) => [
          id,
          result.kind === "priced" ? result.totalMinor : result.reason,
        ]),
      ),
    ).toEqual({
      flexible: "30100",
      nonrefundable: "27090",
      breakfast: "33100",
    });
    // Two nights against a three-night minimum: the engine refuses the stay.
    expect(stayTotals(setMinimumNights(design, 3), "2026-07-18", "2026-07-20").flexible).toEqual({
      kind: "unavailable",
      reason: "restriction",
    });
  });
  it("prices every night of a month with the night evaluator, weekends and seasons included", () => {
    const nights = monthNights(design, "flexible", "2026-07");
    expect(nights).toHaveLength(31);
    const price = (date: string) => {
      const night = nights.find((entry) => entry.date === date)!.night;
      return night.kind === "projected"
        ? [night.night.totalMinor, night.night.sources.map((source) => source.kind)]
        : night.reason;
    };
    expect(price("2026-07-01")).toEqual(["14000", ["season"]]);
    expect(price("2026-07-03")).toEqual(["16100", ["season", "weekday"]]);
    expect(
      monthNights(design, "nonrefundable", "2026-02").find((entry) => entry.date === "2026-02-07")!
        .night,
    ).toMatchObject({
      night: { totalMinor: "8280" },
    });
  });
});
