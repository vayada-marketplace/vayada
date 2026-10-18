import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import {
  parsePricingConfiguration,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { PricingManualMethodsProvider } from "./pricingManualMethods";
import { simpleRoom } from "./simplePricing";
import type { OptionTerms } from "./stepPricing";
import { StepRates } from "./StepRates";

const rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
const roomOnly = { kind: "room_only", charge: { kind: "room", amountMinor: "0" } };
/** €100 a night, a non-refundable option 10% cheaper (or none). */
const room = (withNonRefundable = true) =>
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
        meal: roomOnly,
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
      ...(withNonRefundable
        ? [
            {
              id: "nonrefundable",
              termsRevision: "nonrefundable-terms",
              meal: roomOnly,
              price: {
                kind: "linked",
                parentId: "flexible",
                adjustment: { kind: "percentage", basisPoints: -1000 },
                dateOverrides: [],
              },
              restrictions: { kind: "inherit" },
            },
          ]
        : []),
    ],
  })!;
const free = (days: number): OptionTerms["cancellation"] =>
  ({
    kind: "flexible",
    terms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: days,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    },
  }) as OptionTerms["cancellation"];
const terms = (
  flexible: OptionTerms["payment"]["acceptedMethods"],
  nonRefundable?: OptionTerms["payment"]["acceptedMethods"],
): Record<string, OptionTerms> => ({
  flexible: { cancellation: free(7), payment: { kind: "full", acceptedMethods: flexible } },
  ...(nonRefundable
    ? {
        nonrefundable: {
          cancellation: { kind: "non_refundable" },
          payment: { kind: "full", acceptedMethods: nonRefundable },
        },
      }
    : {}),
});
const handlers = {
  onTerms: vi.fn(),
  onRetry: vi.fn(),
  onEditOwn: vi.fn(),
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  onChange: vi.fn(),
  onPending: vi.fn(),
};
beforeEach(() => Object.values(handlers).forEach((handler) => handler.mockReset()));
let view: ReactTestRenderer;
const mount = (
  value: PricingConfiguration,
  optionTerms: Record<string, OptionTerms>,
  manual: ("bank_transfer" | "paypal")[] = [],
) =>
  act(() => {
    view = create(
      <PricingManualMethodsProvider value={manual}>
        <StepRates
          room={value}
          simple={simpleRoom(value, optionTerms)}
          terms={optionTerms}
          failed={false}
          prices={{ flexible: "10000", nonrefundable: "9000" }}
          disabled={false}
          {...handlers}
        />
      </PricingManualMethodsProvider>,
    );
  });
const text = () => JSON.stringify(view.toJSON());
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const card = (name: string) => view.root.findByProps({ "aria-label": name });
const checkbox = (rate: string, label: string) =>
  card(rate).findByProps({ type: "checkbox", "aria-label": label });

it("shows the Flexible rate always on beside the Non-refundable rate, with cancellation and how guests pay (VAY-2282)", () => {
  mount(room(), terms(["pay_at_property"], ["bank_transfer"]), ["bank_transfer"]);
  expect(textOf(card("Flexible rate"))).toContain("Always on");
  expect(textOf(card("Flexible rate"))).toContain("Free cancellation until 7 days before");
  // "Paid when booking" follows the methods until card payments come (VAY-2205).
  expect(textOf(card("Flexible rate"))).toContain("Nothing");
  expect(textOf(card("Non-refundable rate"))).toContain("Full stay");
  expect(textOf(card("Non-refundable rate"))).toContain("10% cheaper, no refund");
  expect(textOf(card("Non-refundable rate"))).toContain("€100");
  expect(textOf(card("Non-refundable rate"))).toContain("€90 a night");
  // Card online stays hidden until Payment settings say it is ready.
  expect(card("Flexible rate").findAllByProps({ "aria-label": "Card online" })).toHaveLength(0);
  // The Non-refundable rate is paid in advance: pay at property can't be ticked.
  expect(checkbox("Non-refundable rate", "Pay at property").props.disabled).toBe(true);
  expect(textOf(card("Non-refundable rate"))).toContain(
    "Not offered: non-refundable stays are paid in advance",
  );
});

it("changes the cancellation days, opens the refund steps, and sets each rate's methods on its own options (VAY-2282)", () => {
  mount(room(), terms(["pay_at_property"], ["bank_transfer"]), ["bank_transfer"]);
  act(() => card("Flexible rate").findByProps({ "aria-label": "14 days" }).props.onClick());
  expect(handlers.onTerms.mock.lastCall![0]).toEqual([
    {
      offerId: "flexible",
      terms: { ...terms(["pay_at_property"]).flexible, cancellation: free(14) },
    },
  ]);
  act(() =>
    card("Flexible rate")
      .findAll((node) => node.type === "button" && textOf(node) === "Partial refund")[0]
      .props.onClick(),
  );
  expect(handlers.onEditOwn).toHaveBeenCalled();
  act(() =>
    checkbox("Flexible rate", "Bank transfer").props.onChange({ target: { checked: true } }),
  );
  expect(
    handlers.onTerms.mock.lastCall![0].map((edit: { offerId: string; terms: OptionTerms }) => [
      edit.offerId,
      edit.terms.payment.acceptedMethods,
    ]),
  ).toEqual([["flexible", ["pay_at_property", "bank_transfer"]]]);
  // A rate keeps at least one method.
  act(() =>
    checkbox("Non-refundable rate", "Bank transfer").props.onChange({ target: { checked: false } }),
  );
  expect(text()).toContain("Choose at least one accepted payment method.");
});

it("turns the Non-refundable rate on without pay at property, and says when no advance method is ready (VAY-2282)", () => {
  // Only pay at property and nothing else ready: non-refundable stays can't be paid in advance.
  mount(room(false), terms(["pay_at_property"]));
  act(() => card("Non-refundable rate").findByProps({ role: "switch" }).props.onClick());
  expect(handlers.onAdd).not.toHaveBeenCalled();
  expect(text()).toContain("Non-refundable stays are paid in advance.");
  // With bank transfer ready, the rate takes it.
  mount(room(false), terms(["pay_at_property"]), ["bank_transfer"]);
  act(() => card("Non-refundable rate").findByProps({ role: "switch" }).props.onClick());
  expect(handlers.onAdd.mock.lastCall![0].terms.payment.acceptedMethods).toEqual(["bank_transfer"]);
  // The main option's other methods come first.
  mount(room(false), terms(["card", "pay_at_property"]));
  act(() => card("Non-refundable rate").findByProps({ role: "switch" }).props.onClick());
  expect(handlers.onAdd.mock.lastCall![0].terms.payment.acceptedMethods).toEqual(["card"]);
});

it("steps the discount and holds Save while it doesn't parse (VAY-2282)", () => {
  mount(room(), terms(["pay_at_property"], ["bank_transfer"]), ["bank_transfer"]);
  act(() => view.root.findByProps({ "aria-label": "1% more" }).props.onClick());
  const next = handlers.onChange.mock.lastCall![0] as PricingConfiguration;
  const offer = next.offers.find((value) => value.id === "nonrefundable")!;
  expect(offer.price.kind === "linked" && offer.price.adjustment).toEqual({
    kind: "percentage",
    basisPoints: -1100,
  });
  act(() =>
    view.root
      .findByProps({ "aria-label": "How much cheaper, in percent" })
      .props.onChange({ target: { value: "abc" } }),
  );
  expect(handlers.onPending).toHaveBeenLastCalledWith(true);
});

it("names a deposit a rate already has (VAY-2205 keeps new ones for later)", () => {
  const value = room(false);
  mount(value, {
    flexible: {
      cancellation: free(7),
      payment: {
        kind: "deposit",
        basisPoints: 3000,
        balanceDaysBeforeArrival: 14,
        acceptedMethods: ["card"],
      },
    },
  });
  expect(textOf(card("Flexible rate"))).toContain("Deposit");
  expect(textOf(card("Flexible rate"))).toContain(
    "Deposit: 30% of the final total. Balance due 14 days before arrival.",
  );
  // A rate that already takes card keeps showing it, so it can be removed.
  expect(checkbox("Flexible rate", "Card online").props.checked).toBe(true);
});
