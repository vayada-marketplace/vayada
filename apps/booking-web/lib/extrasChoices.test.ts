import { expect, it } from "vitest";
import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import type { PricingAddon } from "@/services/api/replacementAddons";
import {
  addonPickDates,
  buildReplacementAddonSelection,
  replacementExtrasScope,
} from "@/services/api/replacementAddonSelection";
import {
  extraAmountMinor,
  extraDates,
  extraFitsParty,
  extraGuests,
  extraLinesMinor,
  extraNeedsDay,
  formatExtraDay,
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
    scheduleMode: pricingModel.endsWith("night") ? "daily" : "guest_pick",
    bookableWeekdays: [1, 2, 3, 4, 5, 6, 7],
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
  // VAY-2391: every night, dated by the server; nothing for the guest to pick.
  expect(item.dates).toEqual([]);
  expect(extraNeedsDay(breakfast, item)).toBe(false);
  expect(extraDates(breakfast, item, selection)).toEqual(["2026-11-06", "2026-11-07"]);
  expect(withCount(item, breakfast, selection, 1).people).toEqual(
    extraGuests(selection).slice(0, 1),
  );
  expect(withCount(item, breakfast, selection, 9).people).toHaveLength(3);
});

it("waits for the guest to pick the day of a one-day extra", () => {
  const transfer = addon("per_stay");
  const item = newExtraItem(transfer, selection);
  expect(item).toEqual({ id: "per_stay", quantity: "1", people: [], dates: [] });
  expect(extraNeedsDay(transfer, item)).toBe(true);
  // The nights of the stay, never the check-out day (8 Nov); only the weekdays it's offered on.
  expect(addonPickDates(selection, transfer)).toEqual(["2026-11-06", "2026-11-07"]);
  expect(addonPickDates(selection, { ...transfer, bookableWeekdays: [6] })).toEqual(["2026-11-07"]);
  const picked = toggleExtraDate(item, "2026-11-06");
  expect(picked.dates).toEqual(["2026-11-06"]);
  expect(extraNeedsDay(transfer, picked)).toBe(false);
  expect(toggleExtraDate(picked, "2026-11-07").dates).toEqual(["2026-11-07"]);
  expect(toggleExtraDate(picked, "2026-11-06").dates).toEqual([]);
  expect(withCount(picked, transfer, selection, 5).quantity).toBe("3");
});

it("dates an extra the hotel schedules from the stay (VAY-2391)", () => {
  const item = newExtraItem(addon("per_stay"), selection);
  const dates = (scheduleMode: PricingAddon["scheduleMode"]) =>
    extraDates(addon("per_stay", { scheduleMode }), item, selection);
  expect(dates("arrival")).toEqual(["2026-11-06"]);
  expect(dates("departure")).toEqual(["2026-11-08"]);
  expect(dates("anytime")).toEqual([]);
  expect(extraNeedsDay(addon("per_stay", { scheduleMode: "arrival" }), item)).toBe(false);
});

it("builds a selection the quote accepts from the step's choices", () => {
  const catalogue = [addon("per_guest_night", { maxGuests: 3 }), addon("per_stay")];
  const scope = replacementExtrasScope(catalogue, selection, 0);
  const items = [
    newExtraItem(catalogue[0]!, selection),
    toggleExtraDate(newExtraItem(catalogue[1]!, selection), "2026-11-07"),
  ];
  expect(buildReplacementAddonSelection(catalogue, selection, 0, { scope, items })).toEqual([
    {
      version: "addon-selection.v2",
      id: "per_guest_night",
      quantity: 1,
      people: extraGuests(selection).slice(0, 3),
      // The server prices every night (VAY-2391).
      dates: null,
    },
    {
      version: "addon-selection.v2",
      id: "per_stay",
      quantity: 1,
      people: null,
      dates: ["2026-11-07"],
    },
  ]);
  // An extra the hotel schedules sends no day; a day off its weekdays or on check-out isn't sent.
  const arrival = addon("per_stay", { id: "arrival", scheduleMode: "arrival" });
  const list = [arrival, addon("per_stay", { bookableWeekdays: [5] })];
  const listScope = replacementExtrasScope(list, selection, 0);
  expect(
    buildReplacementAddonSelection(list, selection, 0, {
      scope: listScope,
      items: [newExtraItem(arrival, selection)],
    }),
  ).toEqual([
    { version: "addon-selection.v2", id: "arrival", quantity: 1, people: null, dates: null },
  ]);
  for (const day of ["2026-11-07", "2026-11-08"])
    expect(
      buildReplacementAddonSelection(list, selection, 0, {
        scope: listScope,
        items: [toggleExtraDate(newExtraItem(list[1]!, selection), day)],
      }),
    ).toBeNull();
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
  expect(extraAmountMinor(breakfast, item, 18, selection)).toBe(BigInt(7200));
  expect(extraAmountMinor(breakfast, item, null, selection)).toBeNull();
  expect(extraLinesMinor([BigInt(7200), BigInt(3000)], BigInt(10200))).toEqual([
    BigInt(7200),
    BigInt(3000),
  ]);
  expect(extraLinesMinor([BigInt(7200), BigInt(3000)], BigInt(10000))).toBeNull();
  expect(extraLinesMinor([BigInt(7200), null], BigInt(7200))).toBeNull();
  expect(extraLinesMinor([BigInt(7200)], null)).toBeNull();
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

it("formats a stay day in the page's language, English as '6 Nov' (VAY-2391)", () => {
  expect(formatExtraDay("2026-11-06", "en")).toEqual({ weekday: "Fri", day: "6 Nov" });
  // Other languages as the browser writes them (ICU versions differ in the details).
  expect(formatExtraDay("2026-11-06", "de").day).toMatch(/^6\. Nov/);
});
