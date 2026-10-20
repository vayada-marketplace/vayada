import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import {
  parsePricingConfiguration,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { PricingMealText } from "./PricingMealText";

const rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
/** €100 a night and a second option with `meal`. */
const room = (meal: Record<string, unknown>) =>
  parsePricingConfiguration({
    version: "pricing.v2",
    propertyId: "property",
    roomTypeId: "aaaaaaaa-0000-4000-8000-00000000000a",
    revision: 1,
    currency: "EUR",
    capacity: { total: 2, adults: 2, children: 0 },
    children: {
      adultFromAge: 12,
      bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
    },
    offers: [
      {
        id: "flexible",
        termsRevision: "flexible-terms",
        meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
        price: {
          kind: "independent",
          calendar: {
            base: { mode: "flat", amountMinor: "10000" },
            months: [],
            seasons: [],
            weekdays: [],
            dates: [],
          },
        },
        restrictions: { kind: "own", rules, seasons: [], dates: [] },
      },
      {
        id: "meal",
        termsRevision: "meal-terms",
        meal,
        price: {
          kind: "linked",
          parentId: "flexible",
          adjustment: { kind: "fixed", deltaMinor: "0" },
          dateOverrides: [],
        },
        restrictions: { kind: "inherit" },
      },
    ],
  })!;
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
let view: ReactTestRenderer;
const mount = (value: PricingConfiguration, onChange = vi.fn(), onPending = vi.fn()) =>
  act(() => {
    view = create(
      <PricingMealText
        room={value}
        offer={value.offers[1]}
        disabled={false}
        onChange={onChange}
        onPending={onPending}
      />,
    );
  });

it.each(["half_board", "full_board", "all_inclusive"])(
  "writes what guests read about %s in the option's window, holding Save while it can't be stored (VAY-2281)",
  (kind) => {
    const value = room({ kind, charge: { kind: "room", amountMinor: "3500" } }),
      onChange = vi.fn(),
      onPending = vi.fn();
    mount(value, onChange, onPending);
    const field = () =>
      view.root.findByProps({ placeholder: "e.g. Breakfast buffet every morning" });
    act(() => field().props.onChange({ target: { value: " Dinner from 18:30 " } }));
    expect(onChange.mock.lastCall![0].offers[1].meal).toEqual({
      kind,
      charge: { kind: "room", amountMinor: "3500" },
      description: "Dinner from 18:30",
    });
    act(() => field().props.onChange({ target: { value: "Dinner from 18:30" } }));
    expect(textOf(view.root)).toContain("Use one line of plain text, up to 200 characters.");
    expect(onPending).toHaveBeenLastCalledWith(true);
    act(() => field().props.onChange({ target: { value: "" } }));
    expect(onChange.mock.lastCall![0].offers[1].meal).not.toHaveProperty("description");
    expect(onPending).toHaveBeenLastCalledWith(false);
  },
);

it("shows a stored text and leaves the field out for room only (VAY-2281)", () => {
  mount(
    room({
      kind: "half_board",
      charge: { kind: "room", amountMinor: "3500" },
      description: "Dinner from 18:30",
    }),
  );
  expect(
    view.root.findByProps({ placeholder: "e.g. Breakfast buffet every morning" }).props.value,
  ).toBe("Dinner from 18:30");
  mount(room({ kind: "room_only", charge: { kind: "room", amountMinor: "0" } }));
  expect(view.toJSON()).toBe(null);
});
