/** @vitest-environment jsdom */
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import { replacementExtrasScope } from "@/services/api/replacementAddonSelection";
import { newExtraItem } from "@/lib/extrasChoices";
import ExtrasStep from "./ExtrasStep";

vi.mock("next/image", () => ({ default: () => null }));

const selection = {
  version: "public-pricing-selection.v1" as const,
  checkIn: "2026-11-06",
  checkOut: "2026-11-08",
  currency: "EUR",
  promoCode: null,
  addons: [],
  rooms: [
    { selectionId: "one", publicOfferKey: "k", guests: { adults: 2, childAgesAtCheckIn: [] } },
  ],
};
const breakfast = {
  id: "breakfast",
  name: "Garden breakfast",
  currency: "EUR",
  pricingModel: "per_guest_night" as const,
  maxQuantity: 1,
  maxGuests: null,
  leadTimeHours: null,
  bookableFrom: null,
};
const transfer = {
  ...breakfast,
  id: "transfer",
  name: "Late check-out",
  pricingModel: "per_stay" as const,
};
const catalogue = [breakfast, transfer];
const display = {
  breakfast: {
    description: "Fresh bread.",
    image: null,
    photos: [],
    duration: null,
    location: "Garden terrace",
    category: "dining" as const,
    price: 18,
  },
  transfer: {
    description: "",
    image: null,
    photos: [],
    duration: null,
    location: null,
    category: "other" as const,
    price: 30,
  },
};
const quote = (extrasMinor: string) =>
  ({
    lines: [{ kind: "addon", selectionId: null, amountMinor: extrasMinor }],
  }) as unknown as PublicBookingQuote;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (props: Partial<ComponentProps<typeof ExtrasStep>> = {}) =>
  act(() =>
    root.render(
      createElement(ExtrasStep, {
        catalogue,
        display,
        selection,
        allocationRevision: 0,
        value: null,
        onChange: () => undefined,
        formatMoney: (minor: string) => `€${Number(minor) / 100}`,
        formatDay: (date: string) => ({ weekday: "Day", day: date.slice(8) }),
        formatNotice: (hours: number) => `Needs ${hours} hours’ notice`,
        ...props,
      }),
    ),
  );
const button = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

it("shows each extra with its price and adds it for every guest and night", () => {
  const onChange = vi.fn();
  render({ onChange });
  expect(host.textContent).toContain("€18 / person / night");
  expect(host.textContent).toContain("€30 / stay");
  // Two categories: the filter pills show.
  expect(host.textContent).toContain("All extras");
  act(() => button("Add Garden breakfast").click());
  expect(onChange).toHaveBeenCalledWith({
    scope: replacementExtrasScope(catalogue, selection, 0),
    items: [newExtraItem(breakfast, selection)],
  });
});

it("asks for the day of a one-day extra and lists the extras with the quote's total", () => {
  const scope = replacementExtrasScope(catalogue, selection, 0);
  const items = [newExtraItem(breakfast, selection), newExtraItem(transfer, selection)];
  render({ value: { scope, items }, quote: quote("7200") });
  expect(host.textContent).toContain("2/2");
  expect(host.textContent).toContain("Which nights?");
  expect(host.textContent).toContain("Choose a day for this extra");
  expect(host.textContent).toContain("Your extras (2)");
  expect(host.textContent).toContain("2 guests · 2 nights");
  expect(host.textContent).toContain("day not chosen");
  expect(host.textContent).toContain("Extras total€72");
  // The per-extra amounts don't add up to the quote here (the day is missing), so they stay hidden.
  expect(host.textContent).not.toContain("€72€");
});

it("shows per-extra amounts only when they add up to the quote", () => {
  const scope = replacementExtrasScope(catalogue, selection, 0);
  render({ value: { scope, items: [newExtraItem(breakfast, selection)] }, quote: quote("7200") });
  expect(host.querySelector("li")!.textContent).toContain("€72");
  render({ value: { scope, items: [newExtraItem(breakfast, selection)] }, quote: quote("7000") });
  expect(host.querySelector("li")!.textContent).not.toContain("€");
});

it("asks for a missing day instead of waiting for a total that can't come", () => {
  const scope = replacementExtrasScope(catalogue, selection, 0);
  const breakfastOnly = { scope, items: [newExtraItem(breakfast, selection)] };
  render({ value: { scope, items: [...breakfastOnly.items, newExtraItem(transfer, selection)] } });
  expect(host.textContent).toContain("Extras totalChoose a day");
  render({ value: breakfastOnly });
  expect(host.textContent).toContain("Extras totalUpdating…");
  render({ value: breakfastOnly, priceFailed: true });
  expect(host.textContent).toContain("Extras total—");
});

it("shows an extra that needs more notice than the stay gives, but doesn't let it be added", () => {
  const onChange = vi.fn();
  // VAY-2232: check-in is 2026-11-06; the transfer can be added from 2026-11-07 on.
  const late = { ...transfer, leadTimeHours: 24, bookableFrom: "2026-11-07" };
  render({ catalogue: [breakfast, late], onChange });
  expect(button("Add Late check-out").disabled).toBe(true);
  expect(host.textContent).toContain("Needs 24 hours’ notice");
  // The button names why it is disabled.
  const notice = button("Add Late check-out").getAttribute("aria-describedby")!;
  expect(host.querySelector(`#${notice}`)?.textContent).toBe("Needs 24 hours’ notice");
  expect(button("Add Garden breakfast").disabled).toBe(false);
  act(() => button("Add Late check-out").click());
  expect(onChange).not.toHaveBeenCalled();
  // From its first bookable date on it is an ordinary extra.
  render({ catalogue: [breakfast, { ...late, bookableFrom: "2026-11-06" }], onChange });
  expect(button("Add Late check-out").disabled).toBe(false);
  expect(host.textContent).not.toContain("notice");
  // Without a date (the hotel's time zone is unknown) it can't be added.
  render({ catalogue: [breakfast, { ...late, bookableFrom: null }], onChange });
  expect(button("Add Late check-out").disabled).toBe(true);
});

// VAY-2231: each card opens its details; Add there adds the extra and closes them.
const seeDetails = (name: string) =>
  act(() =>
    host
      .querySelector(`article[aria-label="${name}"]`)!
      .querySelector<HTMLButtonElement>("button:not([aria-label])")!
      .click(),
  );
const details = () => host.querySelector("dialog");
const dialogButton = (text: string) =>
  Array.from(details()!.querySelectorAll("button")).find((b) => b.textContent === text)!;

it("opens an extra's details with what the hotel filled in, and adds it from there", () => {
  const onChange = vi.fn();
  const groupBreakfast = { ...breakfast, maxGuests: 4 };
  render({ onChange, catalogue: [groupBreakfast, transfer] });
  expect(details()).toBeNull();
  seeDetails("Garden breakfast");
  expect(details()!.getAttribute("aria-labelledby")).toBeTruthy();
  const text = details()!.textContent;
  expect(text).toContain("Dining");
  expect(text).toContain("Garden breakfast");
  expect(text).toContain("Garden terrace");
  expect(text).toContain("Up to 4 guests");
  expect(text).toContain("Fresh bread.");
  expect(text).toContain("€18/ person / night");
  // Nothing the hotel left empty: no duration, notice or photos.
  expect(text).not.toContain("notice");
  expect(details()!.querySelector('[aria-label="Next photo"]')).toBeNull();
  act(() => dialogButton("Add").click());
  expect(onChange).toHaveBeenCalledWith({
    scope: replacementExtrasScope([groupBreakfast, transfer], selection, 0),
    items: [newExtraItem(groupBreakfast, selection)],
  });
  expect(details()).toBeNull();
});

it("shows an added extra as added in its details and removes it there", () => {
  const onChange = vi.fn();
  const scope = replacementExtrasScope(catalogue, selection, 0);
  render({ onChange, value: { scope, items: [newExtraItem(breakfast, selection)] } });
  seeDetails("Garden breakfast");
  expect(details()!.textContent).toContain("In your stay: 2 guests · 2 nights");
  expect(details()!.textContent).toContain("Added");
  act(() => dialogButton("Remove").click());
  expect(onChange).toHaveBeenCalledWith(null);
  act(() =>
    details()!.querySelector<HTMLButtonElement>('[aria-label="Close add-on details"]')!.click(),
  );
  expect(details()).toBeNull();
});

it("says in the details why an extra can't be added to this stay", () => {
  const late = { ...transfer, leadTimeHours: 24, bookableFrom: "2026-11-07" };
  render({ catalogue: [breakfast, late] });
  seeDetails("Late check-out");
  expect(details()!.textContent).toContain(
    "Needs 24 hours’ notice, so it can’t be added to this stay.",
  );
  expect(dialogButton("Add").disabled).toBe(true);
  act(() =>
    details()!.querySelector<HTMLButtonElement>('[aria-label="Close add-on details"]')!.click(),
  );
  // A per-stay extra takes parties up to its max guests; this stay has two.
  render({ catalogue: [breakfast, { ...transfer, maxGuests: 1 }] });
  seeDetails("Late check-out");
  expect(details()!.textContent).toContain("For groups of up to 1 guests.");
  expect(dialogButton("Add").disabled).toBe(true);
});
