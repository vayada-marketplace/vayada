import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { PriceCalendar } from "./PriceCalendar";
import { calendarYear } from "./YearCalendar";

const rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
const flat = (amountMinor: string) => ({ mode: "flat" as const, amountMinor });
const season = (name: string, from: string, through: string, amountMinor: string) => ({
  name,
  tier: "",
  from,
  through,
  price: flat(amountMinor),
});
/** Timo's year (VAY-2284): no standard price, Low €85 (two ranges), High €130, Shoulder €100, Christmas €180, so
 * 26–31 October have no price. February is closed every year, 3–4 November are closed dates, 12 March has an own
 * price, 20 July takes no arrivals and Christmas arrivals stay at least 3 nights. */
const room = {
  version: "pricing.v2",
  propertyId: "property",
  roomTypeId: "room",
  revision: 1,
  currency: "EUR",
  capacity: { total: 2, adults: 2, children: 0 },
  children: {
    adultFromAge: 12,
    bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
  },
  offers: [
    {
      id: "flex",
      termsRevision: "terms",
      meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: {
        kind: "independent",
        calendar: {
          base: null,
          months: [],
          seasons: [
            season("Low", "01-01", "06-30", "8500"),
            season("High", "07-01", "09-30", "13000"),
            season("Shoulder", "10-01", "10-25", "10000"),
            season("Low", "11-01", "12-19", "8500"),
            season("Christmas", "12-20", "12-31", "18000"),
          ],
          weekdays: [],
          dates: [{ date: "2026-03-12", price: flat("15000") }],
        },
      },
      restrictions: {
        kind: "own",
        rules,
        seasons: [
          { from: "02-01", through: "02-28", rules: { ...rules, stopSell: true } },
          { from: "12-20", through: "12-31", rules: { ...rules, minArrivalNights: 3 } },
        ],
        dates: [
          { date: "2026-11-03", rules: { ...rules, stopSell: true } },
          { date: "2026-11-04", rules: { ...rules, stopSell: true } },
          { date: "2026-07-20", rules: { ...rules, closedToArrival: true } },
        ],
      },
    },
  ],
} as unknown as PricingConfiguration;
const stay = { checkIn: "2026-10-23", checkOut: "2026-10-25" };

afterEach(() => vi.unstubAllGlobals());

it("heads each month with its prices, or with the nights from today on that have no price (VAY-2284)", () => {
  const months = calendarYear(room, "flex", 2, "2026", "2026-10-18", stay);
  expect(months.map((month) => month.month)).toEqual(
    Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, "0")}`),
  );
  expect(months.map((month) => month.nights.length)).toEqual([
    31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ]);
  const range = (low: string, high = low) => ({ kind: "range", lowMinor: low, highMinor: high });
  expect(months.map((month) => month.summary)).toEqual([
    range("8500"),
    { kind: "notOpen" },
    range("8500", "15000"), // the own price counts: guests pay it
    range("8500"),
    range("8500"),
    range("8500"),
    range("13000"),
    range("13000"),
    range("13000"),
    { kind: "missing", count: 6 },
    range("8500"), // the closed dates don't count
    range("8500", "18000"),
  ]);
  // Unpriced nights in the past don't count; once they have all passed, the month shows its prices again.
  expect(calendarYear(room, "flex", 2, "2026", "2026-10-28", stay)[9].summary).toEqual({
    kind: "missing",
    count: 4,
  });
  expect(calendarYear(room, "flex", 2, "2026", "2026-11-15", stay)[9].summary).toEqual(
    range("10000"),
  );
});

let view: ReactTestRenderer;
const props = { onOffer: vi.fn(), onAdults: vi.fn(), onMonth: vi.fn(), onPick: vi.fn() };
/** The calendar on a screen at least 640px wide (`wide`), or on a phone. */
function mount(wide: boolean, overrides: Partial<React.ComponentProps<typeof PriceCalendar>> = {}) {
  vi.stubGlobal("matchMedia", () => ({
    matches: wide,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  act(() => {
    view = create(
      <PriceCalendar
        room={room}
        options={[{ id: "flex", name: "Flexible" }]}
        offerId="flex"
        adults={null}
        month="2026-10"
        today="2026-10-18"
        stay={stay}
        {...props}
        {...overrides}
      />,
    );
  });
}
const button = (name: string) =>
  view.root.findAll(
    (node) =>
      node.type === "button" &&
      (node.props["aria-label"] === name ||
        (!node.props["aria-label"] && node.children.join("") === name)),
  );
const text = () => JSON.stringify(view.toJSON());
const months = () =>
  view.root
    .findAll((node) => node.type === "div" && /\d{4}$/.test(node.props["aria-label"] ?? ""))
    .map((node) => node.props["aria-label"]);

it("switches to the Year view: twelve months with their prices, the shared states and legend (VAY-2284)", () => {
  mount(true, { selection: { from: "2026-10-30", to: "2026-11-02" } });
  expect(button("Year")[0].props["aria-pressed"]).toBe(false);
  act(() => button("Year")[0].props.onClick());
  expect(button("Year")[0].props["aria-pressed"]).toBe(true);
  expect(button("Month")[0].props["aria-pressed"]).toBe(false);
  expect(months()).toEqual([
    "January 2026",
    "February 2026",
    "March 2026",
    "April 2026",
    "May 2026",
    "June 2026",
    "July 2026",
    "August 2026",
    "September 2026",
    "October 2026",
    "November 2026",
    "December 2026",
  ]);
  for (const heading of ["€85", "Not open", "€85 to €150", "6 without price", "€85 to €180"])
    expect(text()).toContain(`"${heading}"`);
  // The same nights, named as in the month view.
  for (const name of [
    "10 February 2026, €85, not open",
    "12 March 2026, €150, own price",
    "20 July 2026, €130, no arrival",
    "25 October 2026, €100",
    "26 October 2026, no price",
    "3 November 2026, €85, closed",
  ])
    expect(button(name)).toHaveLength(1);
  // A range picked in the month view stays picked across the months.
  for (const name of [
    "30 October 2026, no price, selected",
    "31 October 2026, no price, selected",
    "1 November 2026, €85, selected",
    "2 November 2026, €85, selected",
  ])
    expect(button(name)[0].props["aria-pressed"]).toBe(true);
  expect(button("3 November 2026, €85, closed")[0].props["aria-pressed"]).toBe(false);
  // The legend: each season's prices for the year, and every state the year shows; no minimum-stay note.
  for (const legend of [
    "Low €85",
    "High €130",
    "Shoulder €100",
    "Christmas €180",
    "Own price",
    "Closed on this date",
    "Not open",
    "No arrivals",
    "No price yet",
  ])
    expect(text()).toContain(`"${legend}"`);
  expect(text()).not.toContain("Standard");
  expect(text()).not.toContain("minimum stay");
});

it("moves by a year, goes back to today and picks dates in the Year view (VAY-2284)", () => {
  mount(true);
  act(() => button("Year")[0].props.onClick());
  expect(text()).toContain('"2026"');
  act(() => button("Next year")[0].props.onClick());
  expect(props.onMonth).toHaveBeenLastCalledWith("2027-10");
  act(() => button("Previous year")[0].props.onClick());
  expect(props.onMonth).toHaveBeenLastCalledWith("2025-10");
  act(() => button("Today")[0].props.onClick());
  expect(props.onMonth).toHaveBeenLastCalledWith("2026-10");
  act(() => button("26 October 2026, no price")[0].props.onClick());
  expect(props.onPick).toHaveBeenLastCalledWith("2026-10-26");
  act(() => button("Month")[0].props.onClick());
  expect(months()).toEqual([]);
  expect(button("Next month")).toHaveLength(1);
  expect(text()).toContain('"October 2026"');
});

it("keeps phones on the month view, as the approved phone board has no Year view (VAY-2284)", () => {
  mount(false);
  act(() => button("Year")[0].props.onClick());
  expect(months()).toEqual([]);
  expect(text()).toContain('"October 2026"');
  expect(button("26 October 2026, no price")).toHaveLength(1);
  // The toggle itself only shows from 640px on.
  const toggle = view.root.find(
    (node) => node.type === "div" && node.props["aria-label"] === "Calendar view",
  );
  expect(toggle.props.className).toContain("hidden");
  expect(toggle.props.className).toContain("sm:flex");
  // The month view keeps its minimum-stay badges and their legend note.
  mount(false, { month: "2026-12" });
  expect(text()).toContain("3+ nts = minimum stay for arrivals that night");
});
