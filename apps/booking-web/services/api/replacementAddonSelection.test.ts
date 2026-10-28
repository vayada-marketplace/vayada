import { expect, it } from "vitest";
import type { PublicBookingQuoteRequest } from "@vayada/domain-booking/replacement-pricing";
import {
  buildReplacementAddonSelection as build,
  carryReplacementExtras,
  replacementExtrasScope,
  type ReplacementExtrasValue,
} from "./replacementAddonSelection";
import type { PricingAddon } from "./replacementAddons";
const catalogue: PricingAddon[] = [
  {
    id: "breakfast",
    name: "Breakfast",
    currency: "EUR",
    // VAY-2391: a one-off extra the guest picks a day for.
    pricingModel: "per_guest",
    maxQuantity: 2,
    maxGuests: null,
    leadTimeHours: null,
    bookableFrom: null,
    scheduleMode: "guest_pick",
    bookableWeekdays: [1, 2, 3, 4, 5, 6, 7],
  },
];
const selection: PublicBookingQuoteRequest["selection"] = {
  version: "public-pricing-selection.v1",
  checkIn: "2027-01-01",
  checkOut: "2027-01-03",
  currency: "EUR",
  promoCode: null,
  addons: [],
  rooms: [
    {
      selectionId: "one",
      publicOfferKey: "offer",
      guests: { adults: 2, childAgesAtCheckIn: [0, 7] },
    },
    { selectionId: "two", publicOfferKey: "offer", guests: { adults: 1, childAgesAtCheckIn: [] } },
  ],
};
const value = (catalog = catalogue): ReplacementExtrasValue => ({
  scope: replacementExtrasScope(catalog, selection, 0),
  items: [
    {
      id: "breakfast",
      quantity: "1",
      people: [
        { selectionId: "one", kind: "child", index: 0 },
        { selectionId: "two", kind: "adult", index: 0 },
      ],
      dates: ["2027-01-02"],
    },
  ],
});
it("preserves selected infant/adult physical-room references and the chosen day in V2", () => {
  expect(build(catalogue, selection, 0, value())).toEqual([
    {
      version: "addon-selection.v2",
      id: "breakfast",
      quantity: 1,
      people: value().items[0].people,
      dates: ["2027-01-02"],
    },
  ]);
  expect(build(catalogue, selection, 0, null)).toEqual([]);
  expect(build(catalogue, null, 0, value())).toBeNull();
});
it("rejects absent, duplicate, foreign or shifted participants without substituting the full party", () => {
  for (const people of [
    [],
    [{ selectionId: "foreign", kind: "adult" as const, index: 0 }],
    [{ selectionId: "one", kind: "child" as const, index: 2 }],
    [{ selectionId: "one", kind: "adult" as const, index: -1 }],
    [...value().items[0].people, value().items[0].people[0]],
  ]) {
    const input = value();
    input.items[0].people = people;
    expect(build(catalogue, selection, 0, input)).toBeNull();
  }
  expect(build(catalogue, selection, 1, value())).toBeNull();
  const changed = {
    ...selection,
    rooms: [
      { ...selection.rooms[0], guests: { adults: 2, childAgesAtCheckIn: [7, 0] } },
      selection.rooms[1],
    ],
  };
  expect(build(catalogue, changed, 0, value())).toBeNull();
});
it("requires one valid picked day, never the check-out day, a quantity and a current catalogue", () => {
  for (const dates of [[], ["2027-01-03"], ["2026-12-31"], ["2027-01-01", "2027-01-01"]]) {
    const input = value();
    input.items[0].dates = dates;
    expect(build(catalogue, selection, 0, input)).toBeNull();
  }
  for (const quantity of ["", "0", "2", "1.5", "100"]) {
    const input = value();
    input.items[0].quantity = quantity;
    expect(build(catalogue, selection, 0, input)).toBeNull();
  }
  expect(build([], selection, 0, value())).toBeNull();
  expect(build(catalogue, { ...selection, checkOut: "2027-01-04" }, 0, value())).toBeNull();
});
it("preserves quantities for non-person models; only a picked day is sent (VAY-2391)", () => {
  for (const [pricingModel, scheduleMode] of [
    ["per_stay", "guest_pick"],
    ["per_night", "daily"],
    ["per_guest", "guest_pick"],
    ["per_stay", "departure"],
  ] as const) {
    const catalog = [{ ...catalogue[0], pricingModel, scheduleMode }];
    const input = value(catalog);
    input.items[0].quantity = pricingModel === "per_guest" ? "1" : "2";
    if (pricingModel !== "per_guest") input.items[0].people = [];
    input.items[0].dates = scheduleMode === "guest_pick" ? ["2027-01-02"] : [];
    expect(build(catalog, selection, 0, input)?.[0]).toMatchObject({
      quantity: Number(input.items[0].quantity),
      dates: scheduleMode === "guest_pick" ? ["2027-01-02"] : null,
    });
  }
  // A day the hotel schedules itself isn't the guest's to send.
  const departure = [{ ...catalogue[0], scheduleMode: "departure" as const }];
  expect(build(departure, selection, 0, value(departure))).toBeNull();
});
it("applies selected-count, quantity, currency and guest limits without a catalogue ceiling", () => {
  const catalog = Array.from({ length: 100 }, (_, i) => ({ ...catalogue[0], id: String(i) }));
  const input = {
    scope: replacementExtrasScope(catalog, selection, 0),
    items: catalog.map((addon) => ({ ...value().items[0], id: addon.id })),
  };
  expect(build(catalog, selection, 0, input)).toBeNull();
  input.items.pop();
  expect(build(catalog, selection, 0, input)).toHaveLength(99);
  for (const change of [{ maxGuests: 1 }, { currency: "USD" }, { maxQuantity: 0 }]) {
    const changed = [{ ...catalogue[0], ...change }];
    expect(build(changed, selection, 0, value(changed))).toBeNull();
  }
});

// VAY-2393: a room changed or removed keeps the guest's extras for the same stay.
it("carries extras over to other rooms, with as many adults and children as before", () => {
  const before: ReplacementExtrasValue = {
    scope: "old",
    items: [
      {
        id: "breakfast",
        quantity: "1",
        people: [
          { selectionId: "one", kind: "adult", index: 1 },
          { selectionId: "two", kind: "adult", index: 0 },
          { selectionId: "one", kind: "child", index: 0 },
        ],
        dates: ["2027-01-02"],
      },
    ],
  };
  // Room two was removed: room one now has all 3 adults and both children.
  const after: PublicBookingQuoteRequest["selection"] = {
    ...selection,
    rooms: [
      {
        selectionId: "one",
        publicOfferKey: "offer",
        guests: { adults: 3, childAgesAtCheckIn: [0, 7] },
      },
    ],
  };
  const carried = carryReplacementExtras(before, catalogue, after, 4)!;
  expect(carried.scope).toBe(replacementExtrasScope(catalogue, after, 4));
  expect(carried.items[0]!.people).toEqual([
    { selectionId: "one", kind: "adult", index: 0 },
    { selectionId: "one", kind: "adult", index: 1 },
    { selectionId: "one", kind: "child", index: 0 },
  ]);
  expect(carried.items[0]!.dates).toEqual(["2027-01-02"]);
  expect(build(catalogue, after, 4, carried)).not.toBeNull();
  // Fewer guests than the extra had: it is left out, and nothing is left to carry.
  const small = {
    ...after,
    rooms: [{ ...after.rooms[0]!, guests: { adults: 1, childAgesAtCheckIn: [] } }],
  };
  expect(carryReplacementExtras(before, catalogue, small, 4)).toBeNull();
});

it("leaves out a carried extra these rooms can't take", () => {
  const item = (id: string) => ({
    id,
    quantity: "1",
    people: [{ selectionId: "one", kind: "adult" as const, index: 0 }],
    dates: ["2027-01-02"],
  });
  const before: ReplacementExtrasValue = {
    scope: "old",
    // Gone from the catalogue, then twice the same extra.
    items: [item("spa"), item("breakfast"), item("breakfast")],
  };
  const carried = carryReplacementExtras(before, catalogue, selection, 1)!;
  expect(carried.items.map((current) => current.id)).toEqual(["breakfast"]);
  expect(build(catalogue, selection, 1, carried)).not.toBeNull();
  // Another currency: nothing is left to carry.
  expect(carryReplacementExtras(before, catalogue, { ...selection, currency: "USD" }, 1)).toBe(
    null,
  );
});
