import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { parsePricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { GuestPreview } from "./GuestPreview";
import { simpleRoom } from "./simplePricing";
import type { OptionTerms } from "./stepPricing";
import { StepExtras } from "./StepExtras";

const rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
/** €100 a night and a breakfast option at €15 for the room, with what guests read about it (or nothing). */
const room = (description?: string) =>
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
        id: "breakfast",
        termsRevision: "breakfast-terms",
        meal: {
          kind: "breakfast",
          charge: { kind: "room", amountMinor: "1500" },
          ...(description ? { description } : {}),
        },
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
const flexible: OptionTerms = {
  cancellation: {
    kind: "flexible",
    terms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    },
  },
  payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
} as OptionTerms;
const terms = { flexible, breakfast: flexible };
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

it("lets the hotel write what guests read about breakfast, holding Save while it can't be stored (VAY-2281)", () => {
  const value = room(),
    onChange = vi.fn(),
    onPending = vi.fn();
  let view!: ReactTestRenderer;
  act(() => {
    view = create(
      <StepExtras
        room={value}
        simple={simpleRoom(value, terms)!}
        prices={{}}
        only="breakfast"
        disabled={false}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onChange={onChange}
        onPending={onPending}
      />,
    );
  });
  const field = () => view.root.findByProps({ placeholder: "e.g. Breakfast buffet every morning" });
  expect(field().props.value).toBe("");
  act(() => field().props.onChange({ target: { value: "Buffet every morning " } }));
  expect(onChange.mock.lastCall![0].offers[1].meal.description).toBe("Buffet every morning");
  // A line separator can't be stored: the text stays typed, says why and holds Save.
  act(() => field().props.onChange({ target: { value: "Buffet every morning" } }));
  expect(textOf(view.root)).toContain("Use one line of plain text, up to 200 characters.");
  expect(onPending).toHaveBeenLastCalledWith(true);
  act(() => field().props.onChange({ target: { value: "" } }));
  expect(onChange.mock.lastCall![0].offers[1].meal).not.toHaveProperty("description");
  expect(onPending).toHaveBeenLastCalledWith(false);
});

it("shows what guests read under the meal's option in the guest card (VAY-2281)", () => {
  let view!: ReactTestRenderer;
  act(() => {
    view = create(
      <GuestPreview
        room={room("Buffet breakfast in the Stube, 7:00–10:30")}
        facts={{ name: "Alpine Suite", size: null, photo: null }}
        names={{ flexible: "Free cancellation", breakfast: "With breakfast" }}
        terms={terms}
        stay={{ checkIn: "2099-07-17", checkOut: "2099-07-19" }}
        today="2099-01-01"
        selected="flexible"
        onSelect={vi.fn()}
      />,
    );
  });
  const radios = view.root.findAll((node) => node.type === "button" && node.props.role === "radio");
  expect(textOf(radios[1])).toContain("Buffet breakfast in the Stube, 7:00–10:30");
  expect(textOf(radios[0])).not.toContain("Buffet");
});
