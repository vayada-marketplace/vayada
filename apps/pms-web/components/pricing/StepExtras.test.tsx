import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { parsePricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import * as ui from "./pricingStyles";
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

it("shows the saved text of what guests read about breakfast (VAY-2281)", () => {
  const value = room("Buffet breakfast in the Stube, 7:00–10:30");
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
        onChange={vi.fn()}
        onPending={vi.fn()}
      />,
    );
  });
  expect(
    view.root.findByProps({ placeholder: "e.g. Breakfast buffet every morning" }).props.value,
  ).toBe("Buffet breakfast in the Stube, 7:00–10:30");
});

it("shows step Meal plans on its own, and nothing when the room has no breakfast switch (VAY-2468)", () => {
  const value = room();
  const render = (optionTerms: typeof terms) => {
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <StepExtras
          room={value}
          simple={simpleRoom(value, optionTerms)!}
          prices={{}}
          only="breakfast"
          disabled={false}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onChange={vi.fn()}
          onPending={vi.fn()}
        />,
      );
    });
    return view;
  };
  const step = render(terms);
  expect(textOf(step.root)).toContain("Meal plans");
  // No column beside the step's card any more: the card itself sits next to the step's intro and takes the rest.
  const section = step.root.findByType("section");
  expect(section.children).toHaveLength(2);
  expect((section.children[1] as ReactTestInstance).props.className).toBe(ui.setupStepCard);
  // A partial refund puts breakfast in the option's window, so step Meals has no switch and shows nothing.
  const partial = {
    ...flexible,
    cancellation: {
      kind: "flexible",
      terms: {
        type: "free_until_days_before_arrival",
        freeCancellationDeadlineDays: 7,
        afterDeadlinePenalty: "full_booking_amount",
        noShowPenalty: "full_booking_amount",
        partialRefundCancelWindowDays: 3,
      },
    },
  } as OptionTerms;
  const own = render({ flexible: partial, breakfast: partial });
  expect(own.toJSON()).toBeNull();
});

it("charges breakfast per guest or for the room and says what it adds a night (VAY-2305)", () => {
  const onChange = vi.fn(),
    onAdd = vi.fn();
  const render = (value: ReturnType<typeof room>, optionTerms: Record<string, OptionTerms>) => {
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <StepExtras
          room={value}
          simple={simpleRoom(value, optionTerms)!}
          prices={{}}
          only="breakfast"
          disabled={false}
          onAdd={onAdd}
          onRemove={vi.fn()}
          onChange={onChange}
          onPending={vi.fn()}
        />,
      );
    });
    return view;
  };
  const choice = (view: ReactTestRenderer, label: string) =>
    view.root.find((node) => node.type === "button" && textOf(node) === label);
  const view = render(room(), terms);
  expect(choice(view, "Per room").props["aria-pressed"]).toBe(true);
  expect(textOf(view.root)).toContain(
    "Adds €15 a night for the room, whatever the number of guests.",
  );
  act(() => choice(view, "Per guest").props.onClick());
  const next = onChange.mock.lastCall![0];
  expect(next.offers[1].meal.charge).toEqual({
    kind: "person",
    adultMinor: "1500",
    childBandAmountsMinor: ["0"],
  });
  expect(choice(view, "Per guest").props["aria-pressed"]).toBe(true);
  expect(textOf(view.root)).toContain("2 guests add €30 a night (€15 per guest).");
  // A charge that can't change keeps its basis on show, so price edits go to the charge the room has.
  const refusing = render(room(), terms);
  onChange.mockImplementationOnce(() => {
    throw new Error("refused");
  });
  act(() => choice(refusing, "Per guest").props.onClick());
  expect(choice(refusing, "Per room").props["aria-pressed"]).toBe(true);
  // Off, the choice is what turning breakfast on uses.
  const roomOnly = parsePricingConfiguration({ ...room(), offers: [room().offers[0]] })!;
  const plain = render(roomOnly, { flexible });
  expect(textOf(plain.root)).toContain("Turn breakfast on to offer it with your rates.");
  act(() => choice(plain, "Per room").props.onClick());
  act(() =>
    plain.root
      .findByProps({ "aria-label": "Breakfast price" })
      .props.onChange({ target: { value: "12" } }),
  );
  act(() => plain.root.findByProps({ role: "switch" }).props.onClick());
  expect(onAdd.mock.lastCall![0].configuration.offers[1].meal.charge).toEqual({
    kind: "room",
    amountMinor: "1200",
  });
});
