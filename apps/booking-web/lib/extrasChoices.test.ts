import { expect, it } from "vitest";
import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import type { PricingAddon } from "@/services/api/replacementAddons";
import {
  buildReplacementAddonSelection,
  replacementExtrasScope,
} from "@/services/api/replacementAddonSelection";
import {
  extraAmountMinor,
  extraFitsParty,
  extraGuests,
  newExtraItem,
  quoteExtrasMinor,
  toggleExtraDate,
  withCount,
} from "./extrasChoices";

const selection = {
  version: "public-pricing-selection.v1" as const,
  checkIn: "2026-11-06",
  checkOut: "2026-11-08",
  currency: "EUR",
  promoCode: null,
  addons: [],
  rooms: [
    { selectionId: "one", publicOfferKey: "k", guests: { adults: 2, childAgesAtCheckIn: [4] } },
    { selectionId: "two", publicOfferKey: "k", guests: { adults: 1, childAgesAtCheckIn: [] } },
  ],
};
const addon = (pricingModel: PricingAddon["pricingModel"], more: Partial<PricingAddon> = {}) =>
  ({
    id: pricingModel,
    name: pricingModel,
    currency: "EUR",
    pricingModel,
    maxQuantity: 3,
    maxGuests: null,
    leadTimeHours: null,
    bookableFrom: null,
    ...more,
  }) as PricingAddon;

it("counts guests room by room, adults first (one counter for the booking)", () => {
  expect(extraGuests(selection)).toEqual([
    { selectionId: "one", kind: "adult", index: 0 },
    { selectionId: "one", kind: "adult", index: 1 },
    { selectionId: "one", kind: "child", index: 0 },
    { selectionId: "two", kind: "adult", index: 0 },
  ]);
});

it("adds a nightly per-person extra for every guest it can take and every night", () => {
  const breakfast = addon("per_guest_night", { maxGuests: 3 });
  const item = newExtraItem(breakfast, selection);
  expect(item.people).toEqual(extraGuests(selection).slice(0, 3));
  expect(item.dates).toEqual(["2026-11-06", "2026-11-07"]);
  expect(withCount(item, breakfast, selection, 1).people).toEqual(
    extraGuests(selection).slice(0, 1),
  );
  expect(withCount(item, breakfast, selection, 9).people).toHaveLength(3);
  // A nightly extra keeps at least one night.
  const one = toggleExtraDate(breakfast, item, "2026-11-06");
  expect(one.dates).toEqual(["2026-11-07"]);
  expect(toggleExtraDate(breakfast, one, "2026-11-07").dates).toEqual(["2026-11-07"]);
});

it("waits for the guest to pick the day of a one-day extra", () => {
  const transfer = addon("per_stay");
  const item = newExtraItem(transfer, selection);
  expect(item).toEqual({ id: "per_stay", quantity: "1", people: [], dates: [] });
  const picked = toggleExtraDate(transfer, item, "2026-11-08");
  expect(picked.dates).toEqual(["2026-11-08"]);
  expect(toggleExtraDate(transfer, picked, "2026-11-07").dates).toEqual(["2026-11-07"]);
  expect(toggleExtraDate(transfer, picked, "2026-11-08").dates).toEqual([]);
  expect(withCount(picked, transfer, selection, 5).quantity).toBe("3");
});

it("builds a selection the quote accepts from the step's choices", () => {
  const catalogue = [addon("per_guest_night", { maxGuests: 3 }), addon("per_stay")];
  const scope = replacementExtrasScope(catalogue, selection, 0);
  const items = [
    newExtraItem(catalogue[0]!, selection),
    toggleExtraDate(catalogue[1]!, newExtraItem(catalogue[1]!, selection), "2026-11-08"),
  ];
  expect(buildReplacementAddonSelection(catalogue, selection, 0, { scope, items })).toEqual([
    {
      version: "addon-selection.v2",
      id: "per_guest_night",
      quantity: 1,
      people: extraGuests(selection).slice(0, 3),
      dates: ["2026-11-06", "2026-11-07"],
    },
    {
      version: "addon-selection.v2",
      id: "per_stay",
      quantity: 1,
      people: null,
      dates: ["2026-11-08"],
    },
  ]);
  // Until its day is picked, a one-day extra keeps the selection incomplete.
  expect(
    buildReplacementAddonSelection(catalogue, selection, 0, {
      scope,
      items: [newExtraItem(catalogue[1]!, selection)],
    }),
  ).toBeNull();
});

it("keeps a whole-party extra to parties it fits", () => {
  expect(extraFitsParty(addon("per_stay", { maxGuests: 4 }), selection)).toBe(true);
  expect(extraFitsParty(addon("per_stay", { maxGuests: 3 }), selection)).toBe(false);
  expect(extraFitsParty(addon("per_guest", { maxGuests: 2 }), selection)).toBe(true);
});

it("works out display amounts and the quote's extras total", () => {
  const breakfast = addon("per_guest_night");
  const item = withCount(newExtraItem(breakfast, selection), breakfast, selection, 2);
  expect(extraAmountMinor(breakfast, item, 18)).toBe(BigInt(7200));
  expect(extraAmountMinor(breakfast, item, null)).toBeNull();
  const quote = {
    lines: [
      { kind: "room", selectionId: "one", amountMinor: "26800" },
      { kind: "addon", selectionId: null, amountMinor: "7200" },
      { kind: "addon", selectionId: "one", amountMinor: "7000" },
    ],
  } as unknown as PublicBookingQuote;
  expect(quoteExtrasMinor(quote)).toBe(BigInt(14200));
  expect(quoteExtrasMinor({ lines: [] } as unknown as PublicBookingQuote)).toBeNull();
});
