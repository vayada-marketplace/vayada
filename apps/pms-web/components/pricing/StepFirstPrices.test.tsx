import React, { createRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { AcceptedPaymentMethods } from "./AcceptedPaymentMethods";
import { firstPricingInput } from "./FirstPricingSetup";
import { MoreOptions } from "./MoreOptions";
import { StepFirstPrices, type FirstPrices } from "./StepFirstPrices";

const id = "61000000-0000-4000-8000-000000000001",
  second = "61000000-0000-4000-8000-000000000002",
  third = "61000000-0000-4000-8000-000000000003";
const room = { roomTypeId: id, name: "Double", capacity: { total: 3, adults: 2, children: 1 } };
let view: ReactTestRenderer;
afterEach(() => {
  act(() => view?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = async (props: Partial<React.ComponentProps<typeof StepFirstPrices>> = {}) => {
  vi.stubGlobal("React", React);
  const ids = [id, second, third];
  vi.spyOn(crypto, "randomUUID").mockImplementation(
    () => ids.shift() as ReturnType<typeof crypto.randomUUID>,
  );
  const onCreate = vi.fn(),
    onDirty = vi.fn();
  await act(async () => {
    view = create(
      <StepFirstPrices
        propertyId={id}
        rooms={[room]}
        fixedCurrency="EUR"
        disabled={false}
        defaultMethods={["pay_at_property", "card"]}
        onCreate={onCreate}
        onDirty={onDirty}
        {...props}
      />,
    );
  });
  return { onCreate, onDirty };
};
const field = (label: string) => view.root.findByProps({ "aria-label": label });
const fill = async (label: string, value: string) =>
  act(async () => field(label).props.onChange({ target: { value } }));
const button = (label: string) =>
  view.root.findAllByType("button").find(
    (node) =>
      node.children
        .filter((child) => typeof child === "string")
        .join("")
        .trim() === label,
  );
const press = async (label: string) => act(async () => button(label)!.props.onClick());
const flip = async (name: string) =>
  act(async () =>
    view.root.findByProps({ role: "switch", "aria-label": `Offer “${name}”` }).props.onClick(),
  );
const submit = async () =>
  act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
const missing = () => view.root.findAllByType("li").map((node) => node.children.join(""));
/** What the first-price form builds with these answers: free cancellation 3 days, children under 12 free. */
const plain = (overrides: Partial<Parameters<typeof firstPricingInput>[3]> = {}) =>
  firstPricingInput(id, room, id, {
    mode: "flat",
    occupancy: [],
    included: { adults: "", adjustments: [] },
    methods: ["pay_at_property", "card"],
    room: id,
    currency: "EUR",
    base: "120",
    adultAge: "12",
    childPrice: "0",
    countChildren: "yes",
    minimum: "1",
    maximum: "",
    cancellation: "flexible",
    freeDays: "3",
    payment: "full",
    ...overrides,
  });

it("sets a working first price from one typed number, with the defaults filled in (VAY-2188)", async () => {
  const { onCreate, onDirty } = await mount();
  // Free cancellation until 3 days before arrival is already chosen.
  expect(button("Free cancellation")!.props["aria-pressed"]).toBe(true);
  expect(field("Days before arrival").props.value).toBe(3);
  expect(view.root.findByType(AcceptedPaymentMethods).props.methods).toEqual([
    "pay_at_property",
    "card",
  ]);
  // Without a price, Save names what is missing and creates nothing.
  await submit();
  expect(onCreate).not.toHaveBeenCalled();
  expect(missing()).toEqual(["Room price per night"]);
  await fill("Room price per night", "120");
  expect(onDirty).toHaveBeenCalled();
  expect(missing()).toEqual([]);
  await submit();
  expect(onCreate).toHaveBeenCalledOnce();
  const [input, then] = onCreate.mock.calls[0] as [FirstPrices, string];
  expect(then).toBe("save");
  const expected = plain();
  expect(input).toEqual({ configuration: expected.configuration, terms: [expected.terms] });
});

it("adds the switches' options and the weekend price to the first price", async () => {
  const { onCreate } = await mount();
  await fill("Room price per night", "100");
  await flip("Non-refundable");
  await fill("How much cheaper, in percent", "15");
  await flip("With breakfast");
  // Breakfast needs its price before it can be saved.
  await submit();
  expect(onCreate).not.toHaveBeenCalled();
  expect(missing()).toEqual(["Breakfast price"]);
  await fill("Breakfast price", "12");
  await press("+15%");
  await submit();
  const [input] = onCreate.mock.calls[0] as [FirstPrices];
  const [main, nonRefundable, breakfast] = input.configuration.offers;
  expect(main.price).toMatchObject({
    kind: "independent",
    calendar: {
      base: { mode: "flat", amountMinor: "10000" },
      weekdays: [
        { day: 4, adjustment: { kind: "percentage", basisPoints: 1500 } },
        { day: 5, adjustment: { kind: "percentage", basisPoints: 1500 } },
      ],
    },
  });
  expect(nonRefundable).toMatchObject({
    id: second,
    price: { kind: "linked", parentId: id, adjustment: { kind: "percentage", basisPoints: -1500 } },
    restrictions: { kind: "inherit" },
  });
  expect(breakfast).toMatchObject({
    id: third,
    meal: {
      kind: "breakfast",
      charge: { kind: "person", adultMinor: "1200", childBandAmountsMinor: ["0"] },
    },
    price: { kind: "linked", parentId: id, adjustment: { kind: "fixed", deltaMinor: "0" } },
  });
  const payment = { kind: "full", acceptedMethods: ["pay_at_property", "card"] };
  expect(
    input.terms.map((terms) => [terms.offerId, terms.cancellation.kind, terms.payment]),
  ).toEqual([
    [id, "flexible", payment],
    // Paid in advance: pay at property is left out (VAY-2280).
    [second, "non_refundable", { kind: "full", acceptedMethods: ["card"] }],
    [third, "flexible", payment],
  ]);
});

it("asks how guests pay when Payment settings can't be read, and opens More options for it", async () => {
  const { onCreate } = await mount({ defaultMethods: null });
  expect(JSON.stringify(view.toJSON())).toContain("Choose how guests pay");
  // Asked at once: More options opens on it before any Save.
  expect(view.root.findByType(MoreOptions).props.keepOpen).toBe(true);
  await fill("Room price per night", "120");
  await submit();
  expect(onCreate).not.toHaveBeenCalled();
  expect(missing()).toEqual(["How guests pay"]);
  expect(view.root.findByType(MoreOptions).props.keepOpen).toBe(true);
  await act(async () =>
    view.root.findByType(AcceptedPaymentMethods).props.onChange(["pay_at_property"]),
  );
  await submit();
  const [input] = onCreate.mock.calls[0] as [FirstPrices];
  expect(input.terms[0].payment).toEqual({ kind: "full", acceptedMethods: ["pay_at_property"] });
});

it("hides the non-refundable switch for a non-refundable price and opens a season after adding the prices", async () => {
  const { onCreate } = await mount();
  await press("Non-refundable");
  expect(
    view.root.findAllByProps({ role: "switch" }).map((node) => node.props["aria-label"]),
  ).toEqual(["Offer “With breakfast”"]);
  await fill("Room price per night", "120");
  await press("Add a season");
  const [input, then] = onCreate.mock.calls[0] as [FirstPrices, string];
  expect(then).toBe("season");
  expect(input.terms).toEqual([
    expect.objectContaining({ cancellation: { kind: "non_refundable" } }),
  ]);
});

it("on the New room page, hands the answers to the page and offers no Save of its own", async () => {
  const pending = createRef<(() => FirstPrices) | null>() as React.MutableRefObject<
    (() => FirstPrices) | null
  >;
  const { onCreate } = await mount({ pending });
  expect(button("Save prices")).toBeUndefined();
  expect(JSON.stringify(view.toJSON())).toContain("Prices are optional here.");
  await act(async () => {
    expect(() => pending.current!()).toThrow();
  });
  expect(missing()).toEqual(["Room price per night"]);
  await fill("Room price per night", "120");
  const expected = plain();
  expect(pending.current!()).toEqual({
    configuration: expected.configuration,
    terms: [expected.terms],
  });
  expect(onCreate).not.toHaveBeenCalled();
});

it("waits for Payment settings before saving, and names a discount it can't use", async () => {
  const { onCreate } = await mount({ defaultMethods: undefined });
  expect(button("Save prices")!.props.disabled).toBe(true);
  expect(button("Add a season")!.props.disabled).toBe(true);
  await fill("Room price per night", "120");
  await submit();
  expect(onCreate).not.toHaveBeenCalled();
  expect(missing()).toEqual([]);
  await act(async () =>
    view.update(
      <StepFirstPrices
        propertyId={id}
        rooms={[room]}
        fixedCurrency="EUR"
        disabled={false}
        defaultMethods={["pay_at_property", "card"]}
        onCreate={onCreate}
        onDirty={vi.fn()}
      />,
    ),
  );
  expect(button("Save prices")!.props.disabled).toBe(false);
  await flip("Non-refundable");
  await fill("How much cheaper, in percent", "100");
  await submit();
  expect(onCreate).not.toHaveBeenCalled();
  expect(missing()).toEqual(["How much cheaper, in percent"]);
  expect(field("How much cheaper, in percent").props["aria-invalid"]).toBe(true);
  await fill("How much cheaper, in percent", "12.5");
  await submit();
  const [input] = onCreate.mock.calls[0] as [FirstPrices];
  expect(input.configuration.offers[1].price).toMatchObject({
    adjustment: { kind: "percentage", basisPoints: -1250 },
  });
});

// A keystroke handled by the render from before Payment settings arrived (the price typed just as they load) used to
// write back that render's empty ways to pay, so Create Room Type then asked for How guests pay.
it("keeps the ways to pay that arrive while a price is being typed", async () => {
  const pending = createRef<(() => FirstPrices) | null>() as React.MutableRefObject<
    (() => FirstPrices) | null
  >;
  const { onCreate, onDirty } = await mount({ defaultMethods: undefined, pending });
  const typedBeforeTheyArrived = field("Room price per night").props.onChange;
  await act(async () =>
    view.update(
      <StepFirstPrices
        propertyId={id}
        rooms={[room]}
        fixedCurrency="EUR"
        disabled={false}
        defaultMethods={["pay_at_property", "card"]}
        onCreate={onCreate}
        onDirty={onDirty}
        pending={pending}
      />,
    ),
  );
  await act(async () => typedBeforeTheyArrived({ target: { value: "120" } }));
  expect(view.root.findByType(AcceptedPaymentMethods).props.methods).toEqual([
    "pay_at_property",
    "card",
  ]);
  const expected = plain();
  expect(pending.current!()).toEqual({
    configuration: expected.configuration,
    terms: [expected.terms],
  });
  expect(missing()).toEqual([]);
});

it("offers non-refundable only with a way to pay in advance (VAY-2280)", async () => {
  await mount({ defaultMethods: ["pay_at_property"] });
  expect(button("Non-refundable")!.props.disabled).toBe(true);
  expect(
    view.root.findByProps({ role: "switch", "aria-label": "Offer “Non-refundable”" }).props
      .disabled,
  ).toBe(true);
  expect(JSON.stringify(view.toJSON())).toContain("Non-refundable stays are paid in advance.");
});
