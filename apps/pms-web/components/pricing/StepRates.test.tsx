import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import {
  parsePricingConfiguration,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import {
  PricingCardReadinessProvider,
  PricingManualMethodsProvider,
  PricingNotSellingProvider,
} from "./pricingManualMethods";
import { setOfferSale, simpleRoom } from "./simplePricing";
import type { OptionTerms } from "./stepPricing";
import { StepOptions } from "./StepOptions";
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
  readiness: React.ComponentProps<typeof PricingCardReadinessProvider>["value"] = null,
) =>
  act(() => {
    view = create(
      <PricingManualMethodsProvider value={manual}>
        <PricingCardReadinessProvider value={readiness}>
          <StepRates
            room={value}
            simple={simpleRoom(value, optionTerms)}
            terms={optionTerms}
            failed={false}
            prices={{ flexible: "10000", nonrefundable: "9000" }}
            disabled={false}
            {...handlers}
          />
        </PricingCardReadinessProvider>
      </PricingManualMethodsProvider>,
    );
  });
const text = () => JSON.stringify(view.toJSON());
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const card = (name: string) => view.root.findByProps({ "aria-label": name });
const checkbox = (rate: string, label: string) =>
  card(rate).findByProps({ type: "checkbox", "aria-label": label });
const choice = (rate: string, label: string) =>
  card(rate).find(
    (node) =>
      node.type === "button" && node.props["aria-pressed"] !== undefined && textOf(node) === label,
  );
const choices = (rate: string) =>
  card(rate)
    .findByProps({ role: "group", "aria-label": "Paid when booking" })
    .findAllByType("button")
    .map((node) => [textOf(node), node.props["aria-pressed"], node.props.disabled]);

it("shows the Flexible rate always on beside the Non-refundable rate, with cancellation and how guests pay (VAY-2282)", () => {
  mount(room(), terms(["pay_at_property"], ["bank_transfer"]), ["bank_transfer"]);
  expect(card("Flexible rate").findByProps({ role: "switch" }).props["aria-checked"]).toBe(true);
  expect(textOf(card("Flexible rate"))).toContain("Free cancellation until 7 days before");
  // "Paid when booking" is read from the rate's terms (VAY-2205).
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
  // Old terms that take pay at property and a prepaid method let the guest choose; the hotel can still untick it.
  mount(room(), terms(["pay_at_property"], ["card", "pay_at_property"]));
  expect(textOf(card("Non-refundable rate"))).toContain("Guest chooses");
  expect(textOf(card("Non-refundable rate"))).not.toContain("Nothing is charged");
  expect(checkbox("Non-refundable rate", "Pay at property").props.checked).toBe(true);
  expect(checkbox("Non-refundable rate", "Pay at property").props.disabled).toBe(false);
});

it("says what guests booking inside the free cancellation window get (VAY-2392)", () => {
  mount(room(), terms(["pay_at_property"], ["bank_transfer"]), ["bank_transfer"]);
  expect(textOf(card("Flexible rate"))).toContain(
    "Guests booking less than 7 days before arrival can't cancel for free. The booking engine shows this rate as Non-refundable for those dates.",
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
  // "Guest chooses" (VAY-2305) adds a way to pay before arrival to pay at property.
  expect(card("Flexible rate").findAllByProps({ "aria-label": "Bank transfer" })).toHaveLength(0);
  act(() => choice("Flexible rate", "Guest chooses").props.onClick());
  expect(
    handlers.onTerms.mock.lastCall![0].map((edit: { offerId: string; terms: OptionTerms }) => [
      edit.offerId,
      edit.terms.payment,
    ]),
  ).toEqual([
    ["flexible", { kind: "full", acceptedMethods: ["pay_at_property", "bank_transfer"] }],
  ]);
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

it("holds Save while edited old non-refundable terms still accept pay at property, and says why (VAY-2280)", () => {
  const value = room(),
    optionTerms = terms(["pay_at_property"], ["card", "pay_at_property"]);
  // Unchanged old terms aren't written, so Save stays free.
  mount(value, optionTerms);
  expect(handlers.onPending).toHaveBeenLastCalledWith(false);
  act(() => {
    view.update(
      <PricingManualMethodsProvider value={[]}>
        <StepRates
          room={value}
          simple={simpleRoom(value, optionTerms)}
          terms={optionTerms}
          failed={false}
          prices={{ flexible: "10000", nonrefundable: "9000" }}
          disabled={false}
          edited={["nonrefundable"]}
          {...handlers}
        />
      </PricingManualMethodsProvider>,
    );
  });
  expect(handlers.onPending).toHaveBeenLastCalledWith(true);
  expect(textOf(card("Non-refundable rate"))).toContain("Untick pay at property");
  // Nothing is unticked for the hotel.
  expect(handlers.onTerms).not.toHaveBeenCalled();
});

it("names terms from before payment methods were set, and offers Card online once the booking page takes card (VAY-2205)", () => {
  mount(room(false), { flexible: { cancellation: free(7), payment: { kind: "full" } } });
  expect(textOf(card("Flexible rate"))).toContain("As in Payment settings");
  const ready = (charge: "at_booking" | "on_accept") => ({
    card: { ready: true, reason: null, charge },
    deposits: { ready: false },
  });
  const both = terms(["pay_at_property"], ["bank_transfer"]);
  mount(room(), both, ["bank_transfer"], ready("at_booking"));
  // "Nothing" is pay at property only; card comes with a choice that takes it (VAY-2305).
  expect(card("Flexible rate").findAllByProps({ "aria-label": "Card online" })).toHaveLength(0);
  act(() => choice("Flexible rate", "Guest chooses").props.onClick());
  expect(handlers.onTerms.mock.lastCall![0][0].terms.payment.acceptedMethods).toEqual([
    "pay_at_property",
    "card",
  ]);
  expect(checkbox("Non-refundable rate", "Card online").props.checked).toBe(false);
  expect(textOf(card("Non-refundable rate"))).toContain("Charged at booking");
  mount(room(), both, ["bank_transfer"], ready("on_accept"));
  expect(textOf(card("Non-refundable rate"))).toContain("Held at booking, charged when you accept");
  // Not ready (here: switched off) hides it again.
  mount(room(), both, ["bank_transfer"], {
    card: { ready: false, reason: "switch_off", charge: "at_booking" },
    deposits: { ready: false },
  });
  expect(card("Flexible rate").findAllByProps({ "aria-label": "Card online" })).toHaveLength(0);
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

it("turns the Flexible rate off only while the Non-refundable rate is on, and keeps one rate on (VAY-2285)", () => {
  const value = room();
  mount(value, terms(["pay_at_property"], ["bank_transfer"]), ["bank_transfer"]);
  act(() => card("Flexible rate").findByProps({ role: "switch" }).props.onClick());
  const off = handlers.onChange.mock.lastCall![0] as PricingConfiguration;
  expect(off.offers[0]).toMatchObject({ id: "flexible", sale: "not_sold" });
  expect(off.offers[1]).not.toHaveProperty("sale");
  // Off: the rate says so, and Non-refundable can't be switched off until Flexible is on again.
  mount(off, terms(["pay_at_property"], ["bank_transfer"]), ["bank_transfer"]);
  expect(card("Flexible rate").findByProps({ role: "switch" }).props["aria-checked"]).toBe(false);
  expect(textOf(card("Flexible rate"))).toContain(
    "Off. Non-refundable is the only rate guests can book.",
  );
  expect(textOf(card("Non-refundable rate"))).toContain(
    "Keep at least one rate on. Turn on the Flexible rate before you turn this one off.",
  );
  expect(card("Non-refundable rate").findByProps({ role: "switch" }).props.disabled).toBe(true);
  handlers.onChange.mockReset();
  act(() => card("Flexible rate").findByProps({ role: "switch" }).props.onClick());
  expect(handlers.onChange.mock.lastCall![0].offers[0]).not.toHaveProperty("sale");
  // Without the Non-refundable rate, Flexible stays on and says why.
  handlers.onChange.mockReset();
  mount(room(false), terms(["pay_at_property"]));
  act(() => card("Flexible rate").findByProps({ role: "switch" }).props.onClick());
  expect(handlers.onChange).not.toHaveBeenCalled();
  expect(textOf(card("Flexible rate"))).toContain(
    "Keep at least one rate on. Turn on the Non-refundable rate before you turn this one off.",
  );
});

it("sells another option on channels only, but never the room's last booking-page option (VAY-2285)", () => {
  const value = room(),
    onSale = vi.fn();
  const names = { flexible: "Flexible", nonrefundable: "Non-refundable" };
  const options = (shown: PricingConfiguration) =>
    act(() => {
      view = create(
        <StepOptions
          room={shown}
          offers={shown.offers.slice(1)}
          names={names}
          terms={terms(["pay_at_property"], ["bank_transfer"])}
          prices={{}}
          disabled={false}
          onEdit={vi.fn()}
          onSale={onSale}
          add={null}
        />,
      );
    });
  options(value);
  const channels = () =>
    view.root.findByProps({ "aria-label": "Sell “Non-refundable” on channels only" });
  expect(channels().props["aria-checked"]).toBe(false);
  act(() => channels().props.onClick());
  expect(onSale).toHaveBeenLastCalledWith("nonrefundable", "channels_only");
  const sold = setOfferSale(value, "nonrefundable", "channels_only");
  options(sold);
  expect(channels().props["aria-checked"]).toBe(true);
  expect(text()).toContain("not on your booking page");
  act(() => channels().props.onClick());
  expect(onSale).toHaveBeenLastCalledWith("nonrefundable", null);
  expect(setOfferSale(sold, "nonrefundable", null).offers[1]).not.toHaveProperty("sale");
  // With Flexible not sold, Non-refundable is the last option guests can book on the page.
  options(setOfferSale(value, "flexible", "not_sold"));
  expect(channels().props.disabled).toBe(true);
  expect(() =>
    setOfferSale(setOfferSale(value, "flexible", "not_sold"), "nonrefundable", "channels_only"),
  ).toThrow();
});

it("makes Paid when booking a choice: nothing, guest chooses, a deposit while deposits are on, or the full stay (VAY-2305)", () => {
  const ready = (deposits: boolean) => ({
    card: { ready: true, reason: null, charge: "at_booking" as const },
    deposits: { ready: deposits },
  });
  mount(room(), terms(["pay_at_property"], ["card"]), [], ready(false));
  expect(choices("Flexible rate")).toEqual([
    ["Nothing", true, false],
    ["Guest chooses", false, false],
    ["Full stay", false, false],
  ]);
  expect(choices("Non-refundable rate")).toEqual([["Full stay", true, false]]);
  // Pay at property is a "Nothing" rate's only method, fixed by the choice.
  expect(checkbox("Flexible rate", "Pay at property").props.disabled).toBe(true);
  act(() => choice("Flexible rate", "Full stay").props.onClick());
  expect(handlers.onTerms.mock.lastCall![0][0].terms.payment).toEqual({
    kind: "full",
    acceptedMethods: ["card"],
  });
  // Deposits show while they can be taken: card when booking, the rest at the property.
  mount(room(), terms(["pay_at_property"], ["card"]), [], ready(true));
  expect(choices("Flexible rate").map(([name]) => name)).toEqual([
    "Nothing",
    "Guest chooses",
    "Deposit",
    "Full stay",
  ]);
  expect(choices("Non-refundable rate").map(([name]) => name)).toEqual(["Deposit", "Full stay"]);
  act(() => choice("Flexible rate", "Deposit").props.onClick());
  const deposit = handlers.onTerms.mock.lastCall![0][0].terms.payment;
  expect(deposit).toEqual({
    kind: "deposit",
    basisPoints: 3000,
    balanceDaysBeforeArrival: 0,
    acceptedMethods: ["card"],
  });
  mount(
    room(),
    {
      ...terms(["pay_at_property"], ["card"]),
      flexible: { cancellation: free(7), payment: deposit },
    },
    [],
    ready(true),
  );
  expect(textOf(card("Flexible rate"))).toContain(
    "Guests pay 30% by card when they book and the rest at the property.",
  );
  expect(checkbox("Flexible rate", "Card online").props.disabled).toBe(true);
  expect(checkbox("Flexible rate", "Pay at property").props.checked).toBe(true);
  act(() => card("Flexible rate").findByProps({ "aria-label": "Larger deposit" }).props.onClick());
  expect(handlers.onTerms.mock.lastCall![0][0].terms.payment.basisPoints).toBe(3500);
  // A stored deposit keeps its balance date and ways to pay when its percent steps.
  const dated = {
    ...deposit,
    balanceDaysBeforeArrival: 14,
    acceptedMethods: ["card", "pay_at_property"],
  };
  mount(
    room(),
    {
      ...terms(["pay_at_property"], ["card"]),
      flexible: { cancellation: free(7), payment: dated },
    },
    [],
    ready(true),
  );
  act(() => card("Flexible rate").findByProps({ "aria-label": "Smaller deposit" }).props.onClick());
  expect(handlers.onTerms.mock.lastCall![0][0].terms.payment).toEqual({
    ...dated,
    basisPoints: 2500,
  });
});

it("greys out the full stay without a way to pay before arrival, and keeps a guest's choice as hotels take it today (VAY-2305)", () => {
  // No card and no bank transfer: no deposit, no guest's choice, and the full stay says why it can't be picked.
  mount(room(false), terms(["pay_at_property"]));
  expect(choices("Flexible rate")).toEqual([
    ["Nothing", true, false],
    ["Full stay", false, true],
  ]);
  expect(textOf(card("Flexible rate"))).toContain(
    "Full stay needs a way to pay before arrival: card online or bank transfer.",
  );
  // Card and pay at property together: the guest picks at checkout; card can be removed, pay at property stays.
  mount(room(false), terms(["card", "pay_at_property"]), [], {
    card: { ready: true, reason: null, charge: "on_accept" },
    deposits: { ready: false },
  });
  expect(choices("Flexible rate")).toContainEqual(["Guest chooses", true, false]);
  expect(checkbox("Flexible rate", "Card online").props.checked).toBe(true);
  expect(checkbox("Flexible rate", "Card online").props.disabled).toBe(false);
  expect(checkbox("Flexible rate", "Pay at property").props.disabled).toBe(true);
  act(() =>
    checkbox("Flexible rate", "Card online").props.onChange({ target: { checked: false } }),
  );
  expect(handlers.onTerms.mock.lastCall![0][0].terms.payment.acceptedMethods).toEqual([
    "pay_at_property",
  ]);
});

it("shows on a rate's card that it isn't selling, why and how to fix it (VAY-2304)", () => {
  const value = room();
  const optionTerms = terms(["pay_at_property"], ["card"]);
  act(() => {
    view = create(
      <PricingNotSellingProvider
        value={[
          {
            roomTypeId: value.roomTypeId,
            offerId: "nonrefundable",
            reason: "card_off",
            fixes: ["turn_card_on"],
          },
        ]}
      >
        <StepRates
          room={value}
          simple={simpleRoom(value, optionTerms)}
          terms={optionTerms}
          failed={false}
          prices={{ flexible: "10000", nonrefundable: "9000" }}
          disabled={false}
          {...handlers}
        />
      </PricingNotSellingProvider>,
    );
  });
  const nonRefundable = textOf(card("Non-refundable rate"));
  expect(nonRefundable).toContain("Not selling on your booking page");
  expect(nonRefundable).toContain("Only card, and card payments are off for your hotel.");
  expect(nonRefundable).toContain("Ask Vayada to turn card payments back on.");
  expect(nonRefundable).toContain("Its prices stay. It sells again by itself once this is fixed.");
  expect(textOf(card("Flexible rate"))).not.toContain("Not selling");
});
