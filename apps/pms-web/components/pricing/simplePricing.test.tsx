import { describe, expect, it } from "vitest";
import {
  parsePricingConfiguration,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import {
  cancellationEdits,
  cancellationTerms,
  hasKeptSettings,
  onePriceAgain,
  rateMethodEdits,
  pricePerAdultCount,
  setBreakfastAmount,
  setDiscount,
  simpleCancellation,
  simpleRoom,
  switchOption,
} from "./simplePricing";
import type { OptionTerms } from "./stepPricing";

const roomTypeId = "aaaaaaaa-0000-4000-8000-00000000000a";
const rules = (minArrivalNights = 1, extra: Record<string, unknown> = {}) => ({
  minArrivalNights,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
  ...extra,
});
const roomOnly = { kind: "room_only", charge: { kind: "room", amountMinor: "0" } };
const flat = (amountMinor: string) => ({ mode: "flat", amountMinor });
const calendar = (base: unknown, extra: Record<string, unknown> = {}) => ({
  base,
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
const room = (offers: unknown[], capacity = { total: 3, adults: 2, children: 1 }) => {
  const parsed = parsePricingConfiguration({
    version: "pricing.v2",
    propertyId: "property",
    roomTypeId,
    revision: 1,
    currency: "EUR",
    capacity,
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
const independent = (id: string, base: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  termsRevision: `${id}-terms`,
  meal: roomOnly,
  price: { kind: "independent", calendar: calendar(base, extra) },
  restrictions: { kind: "own", rules: rules(2), seasons: [], dates: [] },
});
/** The Paper design's room: €100, two seasons, weekends +15%, Flexible / Non-refundable / With breakfast. */
const design = room([
  independent("flexible", flat("10000"), {
    seasons: [
      { name: "Low", tier: "Low", from: "01-01", through: "03-31", price: flat("8000") },
      { name: "High", tier: "High", from: "07-01", through: "08-31", price: flat("14000") },
    ],
    months: [{ month: 12, price: flat("12000") }],
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
const free = (days = 7, extra: Record<string, unknown> = {}): OptionTerms["cancellation"] =>
  ({
    kind: "flexible",
    terms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: days,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
      ...extra,
    },
  }) as OptionTerms["cancellation"];
const payment = { kind: "full", acceptedMethods: ["card", "pay_at_property"] } as const;
const flexibleTerms = (days = 7): OptionTerms => ({ cancellation: free(days), payment });
const nonRefundableTerms: OptionTerms = { cancellation: { kind: "non_refundable" }, payment };
const designTerms = {
  flexible: flexibleTerms(),
  nonrefundable: nonRefundableTerms,
  breakfast: flexibleTerms(),
};
/** What the simple card can't show: an occupancy price, a linked chain, single dates, own stay rules. */
const complex = room([
  independent(
    "standard",
    { mode: "occupancy", amountsMinor: ["9000", "11000"] },
    {
      dates: [
        { date: "2026-12-31", price: { mode: "occupancy", amountsMinor: ["20000", "22000"] } },
      ],
      weekdays: [{ day: 5, adjustment: { kind: "fixed", deltaMinor: "1000" } }],
    },
  ),
  {
    ...independent("package", { mode: "per_person", unitMinor: "7000" }),
    meal: {
      kind: "half_board",
      charge: { kind: "person", adultMinor: "2500", childBandAmountsMinor: ["0", "1200"] },
    },
  },
  linked(
    "package-early",
    "package",
    { kind: "percentage", basisPoints: -800 },
    {
      meal: {
        kind: "half_board",
        charge: { kind: "person", adultMinor: "2500", childBandAmountsMinor: ["0", "1200"] },
      },
      restrictions: { kind: "own", rules: rules(4), seasons: [], dates: [] },
    },
  ),
]);
const complexTerms = {
  standard: flexibleTerms(),
  package: flexibleTerms(),
  "package-early": nonRefundableTerms,
};
/** Deep-frozen, so a helper that changed its input would throw. */
const frozen = <T,>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};
const ids = (offers: readonly { id: string }[]) => offers.map((offer) => offer.id);
const offer = (value: PricingConfiguration, id: string) =>
  value.offers.find((entry) => entry.id === id)!;

describe("the simple card's view of a room", () => {
  it("finds the main option, its cancellation and the two switches, and lists nothing else", () => {
    const simple = simpleRoom(frozen(design), frozen(designTerms))!;
    expect(simple.main.id).toBe("flexible");
    expect(simple.cancellation).toEqual({ kind: "free", days: 7 });
    expect(simple.nonRefundable?.id).toBe("nonrefundable");
    expect(simple.breakfast?.id).toBe("breakfast");
    expect(simple.others).toEqual([]);
    // Monthly prices are a More options setting, so the card says what it keeps.
    expect(hasKeptSettings(design, simple)).toBe(true);
    const plain = room([independent("flexible", flat("10000"))]);
    expect(hasKeptSettings(plain, simpleRoom(plain, { flexible: flexibleTerms() })!)).toBe(false);
    // A single-date price and a date's stay rules show in "Prices by date" (VAY-2280), so nothing is hidden.
    const dated = room([
      {
        ...independent("flexible", flat("10000"), {
          dates: [{ date: "2026-09-12", price: flat("13000") }],
        }),
        restrictions: {
          kind: "own",
          rules: rules(2),
          seasons: [],
          dates: [{ date: "2026-09-08", rules: { ...rules(2), stopSell: true } }],
        },
      },
    ]);
    expect(hasKeptSettings(dated, simpleRoom(dated, { flexible: flexibleTerms() })!)).toBe(false);
    // A date's own "no departures" or maximum stay shows nowhere on the calendar, so the card says it is kept.
    const hidden = (
      dateRules: Record<string, unknown>,
      seasonRules: Record<string, unknown> = {},
    ) => {
      const value = room([
        {
          ...independent("flexible", flat("10000"), {
            seasons: [
              {
                name: "Autumn",
                tier: "High",
                from: "09-01",
                through: "09-30",
                price: flat("12000"),
              },
            ],
          }),
          restrictions: {
            kind: "own",
            rules: rules(2),
            seasons: [{ from: "09-01", through: "09-30", rules: rules(2, seasonRules) }],
            dates: [{ date: "2026-09-08", rules: rules(2, dateRules) }],
          },
        },
      ]);
      return hasKeptSettings(value, simpleRoom(value, { flexible: flexibleTerms() })!);
    };
    expect(hidden({})).toBe(false);
    expect(hidden({ closedToDeparture: true })).toBe(true);
    expect(hidden({ maxStayNights: 7 })).toBe(true);
    // A date that keeps its season's rules (as the night panel writes them) adds nothing hidden of its own.
    const season = { closedToDeparture: true, maxStayNights: 7 };
    expect(hidden(season, season)).toBe(false);
    expect(hidden({ stopSell: true, ...season }, season)).toBe(false);
  });

  it("waits for every option's terms before it decides", () => {
    expect(
      simpleRoom(design, { flexible: flexibleTerms(), nonrefundable: nonRefundableTerms }),
    ).toBe(null);
  });

  it("lists a complex room's options under More options and says its settings are kept", () => {
    const simple = simpleRoom(frozen(complex), frozen(complexTerms))!;
    expect(simple.main.id).toBe("standard");
    expect(simple.nonRefundable).toBe(null);
    expect(simple.breakfast).toBe(null);
    expect(ids(simple.others)).toEqual(["package", "package-early"]);
    expect(hasKeptSettings(complex, simple)).toBe(true);
  });

  it("treats an option as a switch only when nothing about it is its own", () => {
    const cases: [string, PricingConfiguration, Record<string, OptionTerms>][] = [
      [
        "own stay rules",
        room(
          design.offers.map((value) =>
            value.id === "nonrefundable"
              ? { ...value, restrictions: { kind: "own", rules: rules(3), seasons: [], dates: [] } }
              : value,
          ),
        ),
        designTerms,
      ],
      [
        "an option based on it",
        room([
          ...design.offers,
          linked("child", "nonrefundable", { kind: "percentage", basisPoints: -500 }),
        ]),
        { ...designTerms, child: nonRefundableTerms },
      ],
      [
        "a single-date price",
        room(
          design.offers.map((value) =>
            value.id === "nonrefundable" && value.price.kind === "linked"
              ? {
                  ...value,
                  price: {
                    ...value.price,
                    dateOverrides: [{ date: "2026-12-24", price: flat("5000") }],
                  },
                }
              : value,
          ),
        ),
        designTerms,
      ],
    ];
    for (const [name, value, terms] of cases) {
      const simple = simpleRoom(value, terms)!;
      expect(simple.nonRefundable, name).toBe(null);
      expect(ids(simple.others), name).toContain("nonrefundable");
      expect(simple.breakfast?.id, name).toBe("breakfast");
    }
    // The Non-refundable rate has payment methods of its own (VAY-2282).
    const ownMethods = {
      ...designTerms,
      nonrefundable: {
        ...nonRefundableTerms,
        payment: { kind: "full" as const, acceptedMethods: ["card" as const] },
      },
    };
    expect(simpleRoom(design, ownMethods)!.nonRefundable?.id).toBe("nonrefundable");
    // Breakfast with its own cancellation, or a price of its own, is another option too.
    expect(simpleRoom(design, { ...designTerms, breakfast: flexibleTerms(3) })!.breakfast).toBe(
      null,
    );
    const dearer = room(
      design.offers.map((value) =>
        value.id === "breakfast" && value.price.kind === "linked"
          ? {
              ...value,
              price: { ...value.price, adjustment: { kind: "fixed", deltaMinor: "500" } },
            }
          : value,
      ),
    );
    expect(simpleRoom(dearer, designTerms)!.breakfast).toBe(null);
  });

  it("leaves a non-refundable main price without the non-refundable switch, and own terms without either", () => {
    const strict = simpleRoom(design, {
      flexible: nonRefundableTerms,
      nonrefundable: nonRefundableTerms,
      breakfast: nonRefundableTerms,
    })!;
    expect(strict.cancellation).toEqual({ kind: "non_refundable" });
    expect(strict.nonRefundable).toBe(null);
    expect(strict.breakfast?.id).toBe("breakfast");
    expect(ids(strict.others)).toEqual(["nonrefundable"]);
    const partial = {
      cancellation: free(14, {
        flexibleCancellationType: "partial_refund",
        partialRefundAmountPercent: 50,
      }),
      payment,
    };
    const own = simpleRoom(design, { ...designTerms, flexible: partial, breakfast: partial })!;
    expect(own.cancellation).toEqual({ kind: "own" });
    expect([own.nonRefundable, own.breakfast]).toEqual([null, null]);
    expect(simpleCancellation(free(3, { text: "Our own words" }))).toEqual({ kind: "own" });
  });
});

describe("the simple card's edits", () => {
  it("returns every room unchanged when each edit is applied with its current value", () => {
    const fixtures: [PricingConfiguration, Record<string, OptionTerms>][] = [
      [design, designTerms],
      [complex, complexTerms],
    ];
    for (const [value, terms] of fixtures) {
      const simple = simpleRoom(frozen(value), frozen(terms))!;
      let next = value;
      if (simple.nonRefundable) next = setDiscount(next, simple.nonRefundable.id, "10");
      if (simple.breakfast) next = setBreakfastAmount(next, simple.breakfast.id, "15");
      expect(next).toEqual(value);
      if (simple.cancellation.kind !== "own")
        for (const edit of cancellationEdits(simple, terms, simple.cancellation))
          expect(edit.terms).toEqual(terms[edit.offerId]);
      for (const rate of ["flexible", "non_refundable"] as const)
        for (const edit of rateMethodEdits(simple, terms, rate, payment.acceptedMethods))
          expect(edit.terms).toEqual(terms[edit.offerId]);
    }
    // Per adult count and back is the same room.
    const plain = room([
      independent("flexible", flat("10000"), {
        seasons: [
          { name: "Low", tier: "Low", from: "01-01", through: "03-31", price: flat("8000") },
        ],
      }),
    ]);
    expect(onePriceAgain(pricePerAdultCount(frozen(plain)))).toEqual(plain);
  });

  it("changes only the option it is about", () => {
    const cheaper = setDiscount(frozen(design), "nonrefundable", "12.5");
    expect(offer(cheaper, "nonrefundable").price).toMatchObject({
      adjustment: { kind: "percentage", basisPoints: -1250 },
    });
    expect(cheaper.offers.filter((value) => value.id !== "nonrefundable")).toEqual(
      design.offers.filter((value) => value.id !== "nonrefundable"),
    );
    for (const bad of ["0", "100", "-5", "1.234", "ten"])
      expect(() => setDiscount(design, "nonrefundable", bad), bad).toThrow();
    const dearer = setBreakfastAmount(frozen(design), "breakfast", "18.50");
    expect(offer(dearer, "breakfast").meal).toEqual({
      kind: "breakfast",
      charge: { kind: "room", amountMinor: "1850" },
    });
    expect(dearer.offers.filter((value) => value.id !== "breakfast")).toEqual(
      design.offers.filter((value) => value.id !== "breakfast"),
    );
    // Per adult, children's breakfast stays as it is.
    const perAdult = room(
      design.offers.map((value) =>
        value.id === "breakfast"
          ? {
              ...value,
              meal: {
                kind: "breakfast",
                charge: { kind: "person", adultMinor: "1500", childBandAmountsMinor: ["0", "0"] },
              },
            }
          : value,
      ),
    );
    expect(offer(setBreakfastAmount(perAdult, "breakfast", "12"), "breakfast").meal.charge).toEqual(
      {
        kind: "person",
        adultMinor: "1200",
        childBandAmountsMinor: ["0", "0"],
      },
    );
  });

  it("moves the breakfast option's cancellation with the main price's, and each rate's payment with its own options", () => {
    const simple = simpleRoom(design, designTerms)!;
    expect(cancellationEdits(simple, designTerms, { kind: "free", days: 3 })).toEqual([
      { offerId: "flexible", terms: { ...designTerms.flexible, cancellation: free(3) } },
      { offerId: "breakfast", terms: { ...designTerms.breakfast, cancellation: free(3) } },
    ]);
    expect(cancellationTerms({ kind: "non_refundable" })).toEqual({ kind: "non_refundable" });
    // Each rate's methods are its own (VAY-2282): the Flexible rate's go to the breakfast switch too.
    expect(
      rateMethodEdits(simple, designTerms, "flexible", ["pay_at_property"]).map((edit) => [
        edit.offerId,
        edit.terms.payment.acceptedMethods,
      ]),
    ).toEqual([
      ["flexible", ["pay_at_property"]],
      ["breakfast", ["pay_at_property"]],
    ]);
    expect(
      rateMethodEdits(simple, designTerms, "non_refundable", ["bank_transfer"]).map((edit) => [
        edit.offerId,
        edit.terms.payment.acceptedMethods,
      ]),
    ).toEqual([["nonrefundable", ["bank_transfer"]]]);
    expect(() => rateMethodEdits(simple, designTerms, "non_refundable", [])).toThrow();
  });

  it("adds a switch's option that the card then recognises", () => {
    const plain = room([independent("flexible", flat("10000"))]);
    const id = "bbbbbbbb-0000-4000-8000-00000000000b";
    const added = switchOption(
      frozen(plain),
      id,
      "non_refundable",
      { percent: "15" },
      flexibleTerms(3),
    );
    // Paid in advance: the main option's pay at property is left out (VAY-2280).
    expect(added.terms).toMatchObject({
      offerId: id,
      cancellation: { kind: "non_refundable" },
      payment: { kind: "full", acceptedMethods: ["card"] },
    });
    const id2 = "cccccccc-0000-4000-8000-00000000000c";
    const both = switchOption(
      added.configuration,
      id2,
      "breakfast",
      { amount: "12", basis: "person" },
      flexibleTerms(3),
    );
    expect(both.terms.cancellation).toEqual(free(3));
    const simple = simpleRoom(both.configuration, {
      flexible: flexibleTerms(3),
      [id]: added.terms,
      [id2]: both.terms,
    })!;
    expect([simple.nonRefundable?.id, simple.breakfast?.id, simple.others]).toEqual([id, id2, []]);
    expect(offer(both.configuration, id2).meal).toEqual({
      kind: "breakfast",
      charge: { kind: "person", adultMinor: "1200", childBandAmountsMinor: ["0", "0"] },
    });
  });

  it("prices by adult count without changing a price, and goes back only when nothing would change", () => {
    const perCount = pricePerAdultCount(frozen(design));
    const main = offer(perCount, "flexible");
    expect(main.price.kind === "independent" && main.price.calendar).toMatchObject({
      base: { mode: "occupancy", amountsMinor: ["10000", "10000"] },
      months: [{ month: 12, price: { mode: "occupancy", amountsMinor: ["12000", "12000"] } }],
      seasons: [
        { name: "Low", price: { mode: "occupancy", amountsMinor: ["8000", "8000"] } },
        { name: "High", price: { mode: "occupancy", amountsMinor: ["14000", "14000"] } },
      ],
    });
    expect(perCount.offers.slice(1)).toEqual(design.offers.slice(1));
    expect(onePriceAgain(perCount)).toEqual(design);
    expect(onePriceAgain(complex)).toBe(null);
    expect(() => pricePerAdultCount(complex)).toThrow();
  });
});
