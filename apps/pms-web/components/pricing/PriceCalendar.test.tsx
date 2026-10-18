import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { PriceCalendar } from "./PriceCalendar";
import {
  calendarNights,
  lowestNightMinor,
  nightsWithoutPrice,
  seasonGroups,
  seasonTones,
} from "./priceCalendarModel";

const rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
const flat = (amountMinor: string) => ({ mode: "flat" as const, amountMinor });
/** Alpine Suite: €100 standard, Oktoberfest (two ranges stored as two seasons) €180 with a 3-night minimum, Fri & Sat
 * +15%, an own price on 12 Sep, closed on 8 Sep, no arrivals on 20 Sep. "occupancy": a price per number of adults
 * (base, and seasons, since they must share the mode); "none": no standard price. */
function room(mode: "flat" | "occupancy" | "none" = "flat"): PricingConfiguration {
  const price = (flatMinor: string) =>
    mode === "occupancy"
      ? {
          mode: "occupancy" as const,
          amountsMinor: [0.85, 1, 1.15].map((factor) =>
            String(Math.round(Number(flatMinor) * factor)),
          ),
        }
      : flat(flatMinor);
  const base = mode === "none" ? null : price("10000");
  return {
    version: "pricing.v2",
    propertyId: "property",
    roomTypeId: "room",
    revision: 1,
    currency: "EUR",
    capacity: { total: 3, adults: 3, children: 0 },
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
            base,
            months: [],
            seasons: [
              {
                name: "Oktoberfest",
                tier: "",
                from: "09-19",
                through: "09-30",
                price: price("18000"),
              },
              {
                name: "Oktoberfest",
                tier: "",
                from: "10-01",
                through: "10-04",
                price: price("18000"),
              },
            ],
            weekdays: [4, 5].map((day) => ({
              day,
              adjustment: { kind: "percentage" as const, basisPoints: 1500 },
            })),
            dates: [{ date: "2026-09-12", price: flat("13000") }],
          },
        },
        restrictions: {
          kind: "own",
          rules,
          seasons: [{ from: "09-19", through: "10-04", rules: { ...rules, minArrivalNights: 3 } }],
          dates: [
            { date: "2026-09-08", rules: { ...rules, stopSell: true } },
            { date: "2026-09-20", rules: { ...rules, minArrivalNights: 3, closedToArrival: true } },
          ],
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
}
const options = [
  { id: "flex", name: "Flexible" },
  { id: "nonref", name: "Non-refundable" },
];
let view: ReactTestRenderer;
const props = { onOffer: vi.fn(), onAdults: vi.fn(), onMonth: vi.fn(), onPick: vi.fn() };
function mount(overrides: Partial<React.ComponentProps<typeof PriceCalendar>> = {}) {
  act(() => {
    view = create(
      <PriceCalendar
        room={room()}
        options={options}
        offerId="flex"
        adults={null}
        month="2026-09"
        today="2026-08-14"
        stay={{ checkIn: "2026-09-25", checkOut: "2026-09-28" }}
        {...props}
        {...overrides}
      />,
    );
  });
}
const night = (label: string) =>
  view.root.findAllByProps({ "aria-label": label }).filter((node) => node.type === "button");
const text = () => JSON.stringify(view.toJSON());

it("shows a month of nights with their season, weekend, own-price, closed and no-arrival states (VAY-2280)", () => {
  mount();
  expect(night("1 September 2026, €100")).toHaveLength(1);
  expect(night("4 September 2026, €115")).toHaveLength(1); // Friday +15%
  expect(night("12 September 2026, €130, own price")).toHaveLength(1); // a single date skips the weekend rule
  expect(night("8 September 2026, €100, closed")).toHaveLength(1);
  expect(night("20 September 2026, €180, no arrival")).toHaveLength(1);
  expect(night("25 September 2026, €207, in the sample stay")).toHaveLength(1);
  // The two Oktoberfest ranges are one season, with one legend entry: the year's lowest and highest open night
  // (Fri & Sat +15%), without own prices (VAY-2284).
  expect(text().match(/Oktoberfest €180 to €207/g)).toHaveLength(1);
  for (const legend of [
    "Standard €100 to €115",
    "Own price",
    "Closed on this date",
    "No arrivals",
    "3+ nts = minimum stay for arrivals that night",
  ])
    expect(text()).toContain(legend);
  expect(text()).toContain("3+ nts");
  // A one-night minimum gets no badge.
  expect(text()).not.toContain("1+ nts");
  expect(text()).not.toContain("Not open");
});

it("shows a period closed every year as not open, apart from a closed date (VAY-2284)", () => {
  const value = room();
  const offer = value.offers[0];
  if (offer.restrictions.kind !== "own") throw new Error("own rules expected");
  const closed = {
    ...value,
    offers: [
      {
        ...offer,
        restrictions: {
          ...offer.restrictions,
          seasons: [
            ...offer.restrictions.seasons,
            { from: "11-02", through: "11-26", rules: { ...rules, stopSell: true } },
          ],
        },
      },
      value.offers[1],
    ],
  } as PricingConfiguration;
  mount({ room: closed, month: "2026-11" });
  expect(night("2 November 2026, €100, not open")).toHaveLength(1);
  expect(night("27 November 2026, €115")).toHaveLength(1);
  expect(text()).toContain("Not open");
  expect(text()).not.toContain("Closed on this date");
});

it("switches the option, the adults and the month, and starts the sample stay on a picked night (VAY-2280)", () => {
  mount();
  const pressed = (label: string) =>
    view.root.findAll(
      (node) => node.type === "button" && node.props["aria-label"] === `Show prices for ${label}`,
    );
  expect(pressed("Flexible")[0].props["aria-pressed"]).toBe(true);
  act(() => pressed("Non-refundable")[0].props.onClick());
  expect(props.onOffer).toHaveBeenCalledWith("nonref");
  // A flat price doesn't depend on the guests, so there are no guest choices.
  expect(pressed("2 guests")).toHaveLength(0);
  act(() => view.root.findByProps({ "aria-label": "Next month" }).props.onClick());
  expect(props.onMonth).toHaveBeenLastCalledWith("2026-10");
  act(() =>
    view.root
      .findAll((node) => node.type === "button" && node.children.join("") === "Today")[0]
      .props.onClick(),
  );
  expect(props.onMonth).toHaveBeenLastCalledWith("2026-08");
  act(() => night("1 September 2026, €100")[0].props.onClick());
  expect(props.onPick).toHaveBeenCalledWith("2026-09-01");
  // The non-refundable option prices the same nights 10% cheaper.
  mount({ offerId: "nonref" });
  expect(night("1 September 2026, €90")).toHaveLength(1);
});

it("offers a price per number of adults and says which nights have no price at all (VAY-2280)", () => {
  mount({ room: room("occupancy"), adults: 3 });
  const choices = view.root.findAll(
    (node) =>
      node.type === "button" && /^Show prices for \d guests?$/.test(node.props["aria-label"] ?? ""),
  );
  expect(choices.map((node) => [node.props["aria-label"], node.props["aria-pressed"]])).toEqual([
    ["Show prices for 1 guest", false],
    ["Show prices for 2 guests", false],
    ["Show prices for 3 guests", true],
  ]);
  expect(night("1 September 2026, €115")).toHaveLength(1);
  act(() => choices[0].props.onClick());
  expect(props.onAdults).toHaveBeenCalledWith(1);
  mount({ room: room("none") });
  expect(night("1 September 2026, no price")).toHaveLength(1);
  expect(text()).toContain("No price yet");
  expect(text()).not.toContain("Standard");
});

it("keeps a season's colour on a night with its own price, and marks the own price (VAY-2284)", () => {
  const value = room();
  const offer = value.offers[0];
  if (offer.price.kind !== "independent") throw new Error("independent price expected");
  const owned = {
    ...value,
    offers: [
      {
        ...offer,
        price: {
          ...offer.price,
          calendar: {
            ...offer.price.calendar,
            dates: [...offer.price.calendar.dates, { date: "2026-09-24", price: flat("15000") }],
          },
        },
      },
      value.offers[1],
    ],
  } as PricingConfiguration;
  const night24 = calendarNights(owned, "flex", "2026-09", 2, "2026-08-14", {
    checkIn: "2026-09-25",
    checkOut: "2026-09-28",
  }).find((value) => value.date === "2026-09-24")!;
  expect([night24.season?.name, night24.ownPrice, night24.totalMinor]).toEqual([
    "Oktoberfest",
    true,
    "15000",
  ]);
  mount({ room: owned });
  const [cell] = night("24 September 2026, €150, own price");
  expect(cell.props.className).toContain(seasonTones[0].cell);
  // The legend's season range leaves the own price out.
  expect(text()).toContain("Oktoberfest €180 to €207");
});

it("groups seasons stored with the same name and tier (VAY-2280)", () => {
  const groups = seasonGroups(room().offers[0]);
  expect(groups.map((group) => [group.name, group.indexes, group.tone])).toEqual([
    ["Oktoberfest", [0, 1], 0],
  ]);
});

it("counts the nights no price covers and finds the lowest night guests pay (VAY-2280)", () => {
  expect(nightsWithoutPrice(room(), "flex", 2, "2026-09-01")).toBe(0);
  // From today through the same date next year (366 nights here). Without a standard price only Oktoberfest
  // (19 Sep – 4 Oct) and the own price on 12 Sep are priced.
  expect(nightsWithoutPrice(room("none"), "flex", 2, "2026-09-01")).toBe(366 - 17);
  // Past nights this month don't count: 1–14 Sep (and the own price on the 12th) are behind us.
  expect(nightsWithoutPrice(room("none"), "flex", 2, "2026-09-15")).toBe(366 - 16);
  // The window's end counts: 20 Sep 2026 – 20 Sep 2027 holds 15 Oktoberfest nights of 2026 and 19–20 Sep 2027.
  expect(nightsWithoutPrice(room("none"), "flex", 2, "2026-09-20")).toBe(366 - 17);
  // The non-refundable rate's weekday standard night, 10% under €100.
  expect(lowestNightMinor(room(), ["flex", "nonref"], 2, "2026")).toBe("9000");
  expect(lowestNightMinor(room(), ["flex"], 2, "2026")).toBe("10000");
});
