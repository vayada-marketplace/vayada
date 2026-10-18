import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import ConfirmDialog from "@/components/ConfirmDialog";
import { StepSeasons } from "./StepSeasons";
import { SeasonWindow } from "./SeasonWindow";

const rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
const flat = (amountMinor: string) => ({ mode: "flat" as const, amountMinor });
/** €100 standard; Oktoberfest stored as two seasons (19–30 Sep and 1–4 Oct) at €180; up to 2 adults. */
const room = {
  version: "pricing.v2",
  propertyId: "property",
  roomTypeId: "room",
  revision: 1,
  currency: "EUR",
  capacity: { total: 2, adults: 2, children: 1 },
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
              through: "09-30",
              price: flat("18000"),
            },
            {
              name: "Oktoberfest",
              tier: "",
              from: "10-01",
              through: "10-04",
              price: flat("18000"),
            },
          ],
          weekdays: [],
          dates: [],
        },
      },
      restrictions: { kind: "own", rules, seasons: [], dates: [] },
    },
  ],
} as PricingConfiguration;
const seasons = (value: PricingConfiguration) => {
  const offer = value.offers[0];
  return offer.price.kind === "independent" ? offer.price.calendar.seasons : [];
};
let view: ReactTestRenderer;
const handlers = {
  onInput: vi.fn(),
  onEditMeal: vi.fn(),
  onEditChildren: vi.fn(),
  onPriceMode: vi.fn(),
  onChange: vi.fn(),
  onPending: vi.fn(),
};
const mount = () =>
  act(() => {
    view = create(
      <StepSeasons
        room={room}
        offer={room.offers[0]}
        roomIndex={0}
        offerIndex={0}
        label="Alpine Suite Offer 1"
        inputs={{}}
        disabled={false}
        shown={room}
        {...handlers}
      />,
    );
  });
const field = (label: string) => view.root.findByProps({ "aria-label": label });
const text = () => JSON.stringify(view.toJSON());

it("shows the standard price and each season once, with all its date ranges (VAY-2280)", () => {
  mount();
  expect(field("Alpine Suite Offer 1 Per room").props.value).toBe("100.00");
  expect(text()).toContain("Standard price");
  expect(
    view.root
      .findAllByProps({ "aria-label": "Oktoberfest price Per room" })
      .filter((node) => node.type === "input"),
  ).toHaveLength(1);
  expect(text()).toContain("16 nights a year");
  for (const days of ["19 Sep – 30 Sep", "1 Oct – 4 Oct"])
    expect(
      view.root
        .findAllByProps({ "aria-label": `Edit season Oktoberfest · €180, ${days}` })
        .filter((node) => node.type === "button"),
    ).toHaveLength(1);
  expect(text()).toContain("Children count toward the room's limit of 2 guests.");
});

it("applies a season's price to every range when the field is left, and holds Save while it's typed (VAY-2280)", () => {
  mount();
  act(() => field("Oktoberfest price Per room").props.onChange({ target: { value: "190" } }));
  expect(handlers.onPending).toHaveBeenLastCalledWith(true);
  act(() => field("Oktoberfest price Per room").props.onBlur());
  expect(seasons(handlers.onChange.mock.lastCall![0]).map((season) => season.price)).toEqual([
    flat("19000"),
    flat("19000"),
  ]);
  expect(handlers.onPending).toHaveBeenLastCalledWith(false);
  act(() => field("Oktoberfest price Per room").props.onChange({ target: { value: "abc" } }));
  act(() => field("Oktoberfest price Per room").props.onBlur());
  expect(text()).toContain("Enter a valid price using a decimal point.");
});

it("removes one range, deletes a whole season after asking, and adds dates with the season's name and price (VAY-2280)", () => {
  mount();
  act(() => field("Remove 1 Oct – 4 Oct from Oktoberfest").props.onClick());
  expect(
    seasons(handlers.onChange.mock.lastCall![0]).map((season) => [season.from, season.through]),
  ).toEqual([["09-19", "09-30"]]);
  act(() => field("Delete season Oktoberfest").props.onClick());
  act(() => view.root.findByType(ConfirmDialog).props.onConfirm());
  expect(seasons(handlers.onChange.mock.lastCall![0])).toEqual([]);
  act(() => field("Add dates to Oktoberfest").props.onClick());
  expect(view.root.findByType(SeasonWindow).props.prefill).toEqual({
    name: "Oktoberfest",
    tier: "",
    values: ["180.00"],
  });
});

it("switches to a price per number of adults from the shown price (VAY-2280)", () => {
  mount();
  act(() =>
    view.root
      .findByProps({ role: "switch", "aria-label": "Price depends on number of guests" })
      .props.onClick(),
  );
  const next = handlers.onPriceMode.mock.lastCall![0] as PricingConfiguration;
  const offer = next.offers[0];
  expect(offer.price.kind === "independent" && offer.price.calendar.base).toEqual({
    mode: "occupancy",
    amountsMinor: ["10000", "10000"],
  });
});
