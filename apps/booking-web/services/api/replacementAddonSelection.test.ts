import { expect, it } from "vitest";
import type { PublicBookingQuoteRequest } from "@vayada/domain-booking/replacement-pricing";
import {
  buildReplacementAddonSelection as build,
  replacementExtrasScope,
  type ReplacementExtrasValue,
} from "./replacementAddonSelection";
import type { PricingAddon } from "./replacementAddons";
const catalogue: PricingAddon[] = [
  {
    id: "breakfast",
    name: "Breakfast",
    currency: "EUR",
    pricingModel: "per_guest_night",
    maxQuantity: 2,
    maxGuests: null,
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
it("preserves selected infant/adult physical-room references and actual chosen nights in V2", () => {
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
it("requires explicit valid dates, no checkout night, no empty quantity or stale catalogue", () => {
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
it("preserves quantities for non-person models and permits a single checkout-day service", () => {
  for (const pricingModel of ["per_stay", "per_night", "per_guest"] as const) {
    const catalog = [{ ...catalogue[0], pricingModel }];
    const input = value(catalog);
    input.items[0].quantity = pricingModel === "per_guest" ? "1" : "2";
    if (pricingModel !== "per_guest") input.items[0].people = [];
    input.items[0].dates = [pricingModel === "per_night" ? "2027-01-02" : "2027-01-03"];
    expect(build(catalog, selection, 0, input)?.[0]).toMatchObject({
      quantity: Number(input.items[0].quantity),
      dates: input.items[0].dates,
    });
  }
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
