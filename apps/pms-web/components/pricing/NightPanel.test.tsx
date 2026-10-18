import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { NightPanel } from "./NightPanel";
import {
  nightRules,
  ownPrice,
  pickNight,
  selectedDates,
  setNightRules,
  setOwnPrices,
} from "./nightActions";

const rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
const flat = (amountMinor: string) => ({ mode: "flat" as const, amountMinor });
/** €100 standard, Oktoberfest 19 Sep – 4 Oct €180 with a 3-night minimum (a stay-rule season), and a non-refundable
 * option 10% cheaper that inherits the stay rules. */
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
          base: flat("10000"),
          months: [],
          seasons: [
            {
              name: "Oktoberfest",
              tier: "",
              from: "09-19",
              through: "10-04",
              price: flat("18000"),
            },
          ],
          weekdays: [],
          dates: [],
        },
      },
      restrictions: {
        kind: "own",
        rules,
        seasons: [{ from: "09-19", through: "10-04", rules: { ...rules, minArrivalNights: 3 } }],
        dates: [],
      },
    },
    {
      id: "nonref",
      termsRevision: "terms-nr",
      meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: {
        kind: "linked",
        parentId: "flex",
        adjustment: { kind: "percentage", basisPoints: -1000 },
        dateOverrides: [],
      },
      restrictions: { kind: "inherit" },
    },
  ],
} as PricingConfiguration;
const flexDates = (value: PricingConfiguration) => {
  const offer = value.offers[0];
  return offer.restrictions.kind === "own" ? offer.restrictions.dates : [];
};

it("selects one night, then everything up to a second night, then starts again (VAY-2280)", () => {
  const one = pickNight(null, "2026-09-21");
  expect(one).toEqual({ from: "2026-09-21", to: "2026-09-21" });
  expect(pickNight(one, "2026-09-23")).toEqual({ from: "2026-09-21", to: "2026-09-23" });
  expect(pickNight(one, "2026-09-19")).toEqual({ from: "2026-09-19", to: "2026-09-21" });
  expect(pickNight({ from: "2026-09-21", to: "2026-09-23" }, "2026-09-25")).toEqual({
    from: "2026-09-25",
    to: "2026-09-25",
  });
  expect(selectedDates({ from: "2026-09-30", to: "2026-10-02" })).toEqual([
    "2026-09-30",
    "2026-10-01",
    "2026-10-02",
  ]);
});

it("closes, reopens and sets a minimum stay on nights, keeping their season's other rules (VAY-2280)", () => {
  const closed = setNightRules(room, ["2026-09-08", "2026-09-20"], { stopSell: true });
  expect(flexDates(closed)).toEqual([
    { date: "2026-09-08", rules: { ...rules, stopSell: true } },
    // Inside Oktoberfest the night keeps the season's 3-night minimum.
    { date: "2026-09-20", rules: { ...rules, minArrivalNights: 3, stopSell: true } },
  ]);
  expect(nightRules(closed, "2026-09-20").stopSell).toBe(true);
  // Opening them again leaves nothing of their own: they follow the season or the defaults.
  expect(
    flexDates(setNightRules(closed, ["2026-09-08", "2026-09-20"], { stopSell: false })),
  ).toEqual([]);
  const minimum = setNightRules(room, ["2026-09-08"], { minArrivalNights: 2 });
  expect(flexDates(minimum)).toEqual([
    { date: "2026-09-08", rules: { ...rules, minArrivalNights: 2 } },
  ]);
  expect(() => setNightRules(room, ["2026-09-08"], { minArrivalNights: Number.NaN })).toThrow();
});

it("gives nights an own price, changes it and removes it (VAY-2280)", () => {
  const priced = setOwnPrices(room, ["2026-09-12", "2026-09-13"], ["130"]);
  expect(ownPrice(priced, "2026-09-12")).toEqual(flat("13000"));
  expect(ownPrice(priced, "2026-09-13")).toEqual(flat("13000"));
  expect(ownPrice(setOwnPrices(priced, ["2026-09-12"], ["140"]), "2026-09-12")).toEqual(
    flat("14000"),
  );
  const removed = setOwnPrices(priced, ["2026-09-12", "2026-09-13"], null);
  expect(ownPrice(removed, "2026-09-12")).toBeNull();
  expect(() => setOwnPrices(room, ["2026-09-12"], ["abc"])).toThrow();
});

let view: ReactTestRenderer;
const handlers = { onClear: vi.fn(), onChange: vi.fn(), onPending: vi.fn() };
const mount = (selection: { from: string; to: string } | null) =>
  act(() => {
    view = create(
      <NightPanel
        room={room}
        shown={room}
        selection={selection}
        adults={2}
        names={{ flex: "Free cancellation", nonref: "Non-refundable" }}
        disabled={false}
        {...handlers}
      />,
    );
  });
const text = () => JSON.stringify(view.toJSON());
const button = (label: string) =>
  view.root.findAll(
    (node) => node.type === "button" && JSON.stringify(node.children).includes(label),
  )[0];

it("shows a picked night's prices and changes it from the panel (VAY-2280)", () => {
  mount(null);
  expect(text()).toContain("Pick a night to change it");
  mount({ from: "2026-09-25", to: "2026-09-25" });
  expect(text()).toContain("Friday, 25 September 2026");
  expect(text()).toContain("Oktoberfest · min. 3 nights");
  expect(text()).toContain("€180");
  expect(text()).toContain("€162");
  act(() => button("Close this night").props.onClick());
  expect(flexDates(handlers.onChange.mock.lastCall![0])).toEqual([
    { date: "2026-09-25", rules: { ...rules, minArrivalNights: 3, stopSell: true } },
  ]);
  act(() => button("Own price for this night").props.onClick());
  expect(handlers.onPending).toHaveBeenLastCalledWith(true);
  act(() =>
    view.root
      .findByProps({ "aria-label": "Own price: Per room" })
      .props.onChange({ target: { value: "200" } }),
  );
  act(() => button("Apply").props.onClick());
  expect(ownPrice(handlers.onChange.mock.lastCall![0], "2026-09-25")).toEqual(flat("20000"));
  expect(handlers.onPending).toHaveBeenLastCalledWith(false);
});

it("changes a range of nights at once (VAY-2280)", () => {
  mount({ from: "2026-09-21", to: "2026-09-23" });
  expect(text()).toContain("3 nights selected");
  act(() => button("Minimum stay").props.onClick());
  act(() =>
    view.root
      .findByProps({ "aria-label": "Minimum nights" })
      .props.onChange({ target: { value: "4" } }),
  );
  act(() => button("Apply").props.onClick());
  expect(
    flexDates(handlers.onChange.mock.lastCall![0]).map((entry) => [
      entry.date,
      entry.rules.minArrivalNights,
    ]),
  ).toEqual([
    ["2026-09-21", 4],
    ["2026-09-22", 4],
    ["2026-09-23", 4],
  ]);
  act(() => button("Clear").props.onClick());
  expect(handlers.onClear).toHaveBeenCalled();
});
