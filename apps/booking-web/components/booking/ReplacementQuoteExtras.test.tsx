/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ReplacementQuoteExtras, { type ReplacementQuoteExtrasProps } from "./ReplacementQuoteExtras";
import {
  buildReplacementAddonSelection,
  type ReplacementExtrasValue,
} from "@/services/api/replacementAddonSelection";
const selection: NonNullable<ReplacementQuoteExtrasProps["selection"]> = {
  version: "public-pricing-selection.v1",
  checkIn: "2027-01-01",
  checkOut: "2027-01-03",
  currency: "EUR",
  promoCode: null,
  addons: [],
  rooms: [
    {
      selectionId: "one",
      publicOfferKey: "suite",
      guests: { adults: 1, childAgesAtCheckIn: [0, 7] },
    },
    { selectionId: "two", publicOfferKey: "suite", guests: { adults: 1, childAgesAtCheckIn: [] } },
  ],
};
const catalogue: ReplacementQuoteExtrasProps["catalogue"] = [
  {
    id: "breakfast",
    name: "Breakfast",
    currency: "EUR",
    pricingModel: "per_guest_night",
    maxQuantity: 1,
    maxGuests: 3,
  },
  {
    id: "transfer",
    name: "Transfer",
    currency: "EUR",
    pricingModel: "per_stay",
    maxQuantity: 2,
    maxGuests: null,
  },
];
let root: Root, value: ReplacementExtrasValue | null, props: Partial<ReplacementQuoteExtrasProps>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  value = null;
  props = {};
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
function render(next: Partial<ReplacementQuoteExtrasProps> = {}) {
  props = next;
  act(() =>
    root.render(
      createElement(ReplacementQuoteExtras, {
        catalogue,
        selection,
        allocationRevision: 0,
        value,
        onChange: (next) => {
          value = next;
          render(props);
        },
        ...props,
      }),
    ),
  );
}
function input(label: string) {
  return Array.from(document.querySelectorAll("label"))
    .find((node) => node.textContent?.trim() === label)!
    .querySelector<HTMLInputElement>("input")!;
}
const click = (label: string) => act(() => input(label).click());
it("requires actual participant and night choices without selecting anyone or any date by default", () => {
  render({ catalogue: [] });
  expect(document.body.textContent).toContain("No optional extras");
  render();
  click("Add Breakfast");
  expect(value?.items[0]).toMatchObject({ quantity: "1", people: [], dates: [] });
  expect(buildReplacementAddonSelection(catalogue, selection, 0, value)).toBeNull();
  expect(document.body.textContent).toContain("Room 1, child 1 (age 0 at check-in)");
  expect(document.body.textContent).not.toContain("2027-01-03");
  click("Room 1, child 1 (age 0 at check-in)");
  click("Room 2, adult 1");
  click("2027-01-02");
  expect(buildReplacementAddonSelection(catalogue, selection, 0, value)).toEqual([
    {
      version: "addon-selection.v2",
      id: "breakfast",
      quantity: 1,
      people: [
        { selectionId: "one", kind: "child", index: 0 },
        { selectionId: "two", kind: "adult", index: 0 },
      ],
      dates: ["2027-01-02"],
    },
  ]);
  click("2027-01-01");
  expect(value?.items[0].dates).toHaveLength(2);
  click("2027-01-02");
  expect(value?.items[0].dates).toEqual(["2027-01-01"]);
  click("Room 2, adult 1");
  expect(value?.items[0].people).toHaveLength(1);
  click("Add Breakfast");
  expect(value).toBeNull();
});
it("requires explicit non-person quantity and one service date, including checkout day", () => {
  render();
  click("Add Transfer");
  const quantity = document.querySelector<HTMLInputElement>('input[type="number"]')!;
  const date = document.querySelector("select")!;
  expect(quantity.value).toBe("");
  expect(date.value).toBe("");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(quantity, "2");
    quantity.dispatchEvent(new Event("input", { bubbles: true }));
    date.value = "2027-01-03";
    date.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(value?.items[0].quantity).toBe("2");
  expect(buildReplacementAddonSelection(catalogue, selection, 0, value)).toEqual([
    {
      version: "addon-selection.v2",
      id: "transfer",
      quantity: 2,
      people: null,
      dates: ["2027-01-03"],
    },
  ]);
  expect(document.body.textContent).not.toContain("Room 1, adult");
});
it("blocks stale allocations/catalogue/dates without silently dropping extras and offers explicit reset", () => {
  render();
  click("Add Breakfast");
  click("Room 1, child 2 (age 7 at check-in)");
  click("2027-01-01");
  const previous = value;
  for (const change of [
    { allocationRevision: 1 },
    { selection: { ...selection, checkOut: "2027-01-04" } },
    { catalogue: [] },
    { selection: null },
  ]) {
    render(change);
    expect(value).toBe(previous);
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(document.body.textContent).toContain("Clear extra selections");
  }
  act(() => document.querySelector<HTMLButtonElement>("button")!.click());
  expect(value).toBeNull();
  render({ allocationRevision: 1 });
  click("Add Breakfast");
  expect(value?.items[0].people).toEqual([]);
});
