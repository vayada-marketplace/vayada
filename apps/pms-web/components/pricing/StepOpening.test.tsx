import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { StepOpening } from "./StepOpening";
import {
  addClosedPeriod,
  closedPeriods,
  moveRangeRule,
  rangeMinimum,
  removeClosedPeriods,
  setRangeMinimum,
} from "./stayRuleSeasons";

const rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
const flat = (amountMinor: string) => ({ mode: "flat" as const, amountMinor });
const room = (seasons: { from: string; through: string; rules: typeof rules }[] = []) =>
  ({
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
                name: "Christmas",
                tier: "",
                from: "12-20",
                through: "01-06",
                price: flat("15000"),
              },
            ],
            weekdays: [],
            dates: [],
          },
        },
        restrictions: { kind: "own", rules, seasons, dates: [] },
      },
    ],
  }) as PricingConfiguration;
const stay = (value: PricingConfiguration) => {
  const offer = value.offers[0];
  return offer.restrictions.kind === "own" ? offer.restrictions.seasons : [];
};
const christmas = { from: "12-20", through: "01-06" };

it("keeps closed periods and a season's minimum stay as stay-rule seasons (VAY-2280)", () => {
  const closed = addClosedPeriod(room(), { from: "11-02", through: "11-26" });
  expect(closedPeriods(closed)).toEqual([{ from: "11-02", through: "11-26" }]);
  expect(stay(closed)).toEqual([
    { from: "11-02", through: "11-26", rules: { ...rules, stopSell: true } },
  ]);
  expect(stay(removeClosedPeriods(closed, closedPeriods(closed)))).toEqual([]);
  // A season's minimum stay goes on its days; the default again removes it.
  const three = setRangeMinimum(room(), [christmas], 3);
  expect(rangeMinimum(three, christmas)).toBe(3);
  expect(stay(three)).toEqual([{ ...christmas, rules: { ...rules, minArrivalNights: 3 } }]);
  expect(stay(setRangeMinimum(three, [christmas], 1))).toEqual([]);
  // It follows the season's days, and goes with it.
  expect(stay(moveRangeRule(three, christmas, { from: "12-15", through: "01-06" }))).toEqual([
    { from: "12-15", through: "01-06", rules: { ...rules, minArrivalNights: 3 } },
  ]);
  expect(stay(moveRangeRule(three, christmas, null))).toEqual([]);
  // Stay rules may not overlap: a closed period inside a season with its own minimum stay is refused.
  expect(() => addClosedPeriod(three, { from: "12-24", through: "12-26" })).toThrow();
});

let view: ReactTestRenderer;
const handlers = { onChange: vi.fn(), onPending: vi.fn() };
const mount = (value: PricingConfiguration) =>
  act(() => {
    view = create(<StepOpening room={value} disabled={false} {...handlers} />);
  });
const text = () => JSON.stringify(view.toJSON());
const button = (label: string) =>
  view.root.findAll(
    (node) => node.type === "button" && JSON.stringify(node.children).includes(label),
  )[0];

it("closes a period every year and opens it again (VAY-2280)", () => {
  mount(room());
  expect(text()).toContain("Open all year");
  expect(text()).toContain("365 nights a year");
  act(() =>
    view.root.findByProps({ role: "switch", "aria-label": "Open all year" }).props.onClick(),
  );
  expect(handlers.onPending).toHaveBeenLastCalledWith(true);
  act(() =>
    view.root.findByProps({ "aria-label": "From: day" }).props.onChange({ target: { value: "2" } }),
  );
  act(() =>
    view.root
      .findByProps({ "aria-label": "From: month" })
      .props.onChange({ target: { value: "11" } }),
  );
  act(() =>
    view.root
      .findByProps({ "aria-label": "Until: day" })
      .props.onChange({ target: { value: "26" } }),
  );
  act(() =>
    view.root
      .findByProps({ "aria-label": "Until: month" })
      .props.onChange({ target: { value: "11" } }),
  );
  act(() => button("Close these days").props.onClick());
  expect(closedPeriods(handlers.onChange.mock.lastCall![0])).toEqual([
    { from: "11-02", through: "11-26" },
  ]);
  expect(handlers.onPending).toHaveBeenLastCalledWith(false);
  mount(addClosedPeriod(room(), { from: "11-02", through: "11-26" }));
  expect(text()).toContain("340 nights a year open, 25 closed");
  act(() => view.root.findByProps({ "aria-label": "Open 2 Nov – 26 Nov again" }).props.onClick());
  expect(closedPeriods(handlers.onChange.mock.lastCall![0])).toEqual([]);
});

it("says why a closed period can't overlap a season's minimum stay (VAY-2280)", () => {
  mount(setRangeMinimum(room(), [christmas], 3));
  act(() =>
    view.root.findByProps({ role: "switch", "aria-label": "Open all year" }).props.onClick(),
  );
  act(() =>
    view.root
      .findByProps({ "aria-label": "From: day" })
      .props.onChange({ target: { value: "24" } }),
  );
  act(() =>
    view.root
      .findByProps({ "aria-label": "From: month" })
      .props.onChange({ target: { value: "12" } }),
  );
  act(() =>
    view.root
      .findByProps({ "aria-label": "Until: day" })
      .props.onChange({ target: { value: "26" } }),
  );
  act(() =>
    view.root
      .findByProps({ "aria-label": "Until: month" })
      .props.onChange({ target: { value: "12" } }),
  );
  act(() => button("Close these days").props.onClick());
  expect(text()).toContain("These days overlap another stay rule");
});
