import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { AcceptedPaymentMethods } from "./AcceptedPaymentMethods";
import { firstPricingInput } from "./FirstPricingSetup";
import { StepFirstPrices } from "./StepFirstPrices";

const id = "61000000-0000-4000-8000-000000000001";
const room = { roomTypeId: id, name: "Double", capacity: { total: 3, adults: 2, children: 1 } };
let view: ReactTestRenderer;
afterEach(() => {
  act(() => view?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = async (props: Partial<React.ComponentProps<typeof StepFirstPrices>> = {}) => {
  vi.stubGlobal("React", React);
  const onCreate = vi.fn(),
    onDirty = vi.fn();
  await act(async () => {
    view = create(
      <StepFirstPrices
        propertyId={id}
        rooms={[room]}
        disabled={false}
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
const press = async (label: string) =>
  act(async () =>
    view.root
      .findAllByType("button")
      .find((node) => node.children.join("") === label)!
      .props.onClick(),
  );
const submit = async () =>
  act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));

it("asks the first price as steps and builds what the first-price form builds for the same answers (VAY-2125)", async () => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
  const { onCreate, onDirty } = await mount();
  // Nothing the guest agrees to is preselected.
  const chips = view.root
    .findAllByType("button")
    .filter((node) => node.props["aria-pressed"] !== undefined);
  expect(chips.every((node) => node.props["aria-pressed"] === false)).toBe(true);
  expect(
    view.root
      .findAllByType("input")
      .filter((node) => node.props.type === "checkbox")
      .every((node) => !node.props.checked),
  ).toBe(true);
  await submit();
  expect(onCreate).not.toHaveBeenCalled();
  expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(1);
  await fill("Room price per night", "120");
  await fill("Currency code (for example EUR)", "eur");
  await press("Yes, free cancellation");
  await fill("Free cancellation until days before arrival (0–365)", "7");
  await act(async () =>
    view.root.findByType(AcceptedPaymentMethods).props.onChange(["pay_at_property"]),
  );
  await fill("Adult pricing starts at age (1–18)", "12");
  await fill("Price per child per night (0 is allowed)", "0");
  await press("Yes");
  expect(onDirty).toHaveBeenCalled();
  await submit();
  expect(onCreate).toHaveBeenCalledOnce();
  const expected = firstPricingInput(id, room, id, {
    mode: "flat",
    occupancy: [],
    included: { adults: "", adjustments: [] },
    methods: ["pay_at_property"],
    room: id,
    currency: "EUR",
    base: "120",
    adultAge: "12",
    childPrice: "0",
    countChildren: "yes",
    minimum: "1",
    maximum: "",
    cancellation: "flexible",
    freeDays: "7",
    payment: "full",
  });
  expect(onCreate.mock.calls[0][0]).toEqual(expected);
});
it("keeps the property currency, offers the other price types and is disabled while saving", async () => {
  await mount({ fixedCurrency: "EUR" });
  expect(field("Currency code (for example EUR)").props).toMatchObject({
    value: "EUR",
    disabled: true,
  });
  await press("Price depends on the number of guests");
  await fill("How is the room priced?", "occupancy");
  expect(field("Room price for 1 adult per night").props.value).toBe("");
  expect(field("Room price for 2 adults per night").props.value).toBe("");
  expect(view.root.findAllByProps({ "aria-label": "Room price per night" })).toHaveLength(0);
  await act(async () =>
    view.update(
      <StepFirstPrices
        propertyId={id}
        rooms={[room]}
        fixedCurrency="EUR"
        disabled
        onCreate={vi.fn()}
        onDirty={vi.fn()}
      />,
    ),
  );
  expect(
    view.root
      .findAll((node) => ["input", "select", "button"].includes(String(node.type)))
      .every((node) => node.props.disabled),
  ).toBe(true);
});
it("marks and names the answers still missing after Continue, and drops each one as it is filled in (VAY-2157)", async () => {
  const { onCreate } = await mount({ fixedCurrency: "EUR" });
  // Marked inputs (the unanswered children group is checked by the next test).
  const marked = () =>
    view.root
      .findAllByProps({ "aria-invalid": true })
      .filter((node) => node.type === "input")
      .map((node) => node.props["aria-label"]);
  const named = () =>
    view.root
      .findByProps({ role: "alert" })
      .findAllByType("li")
      .map((node) => node.children.join(""));
  await fill("Room price per night", "120");
  await press("No, non-refundable");
  await act(async () => view.root.findByType(AcceptedPaymentMethods).props.onChange(["card"]));
  // Nothing is marked before Continue.
  expect(marked()).toEqual([]);
  await submit();
  expect(onCreate).not.toHaveBeenCalled();
  expect(named()).toEqual([
    "Adult pricing starts at age (1–18)",
    "Price per child per night (0 is allowed)",
    "Children count toward room capacity",
  ]);
  expect(marked()).toEqual([
    "Adult pricing starts at age (1–18)",
    "Price per child per night (0 is allowed)",
  ]);
  await fill("Adult pricing starts at age (1–18)", "12");
  expect(named()).toEqual([
    "Price per child per night (0 is allowed)",
    "Children count toward room capacity",
  ]);
  await fill("Price per child per night (0 is allowed)", "0");
  await press("Yes");
  expect(marked()).toEqual([]);
  expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  await submit();
  expect(onCreate).toHaveBeenCalledOnce();
});
it("names an included-guest price's missing answers and links every unanswered group to its entry (VAY-2157)", async () => {
  await mount({ fixedCurrency: "EUR" });
  const named = () =>
    view.root
      .findByProps({ role: "alert" })
      .findAllByType("li")
      .map((node) => node.children.join(""));
  const entry = (name: string) =>
    view.root.findAllByType("li").find((node) => node.children.join("") === name)!.props.id;
  const group = (name: string) =>
    view.root.find((node) => node.type === "div" && node.props["aria-label"] === name).props;
  await press("Price depends on the number of guests");
  await fill("How is the room priced?", "included_guests");
  await fill("Room price per night", "130");
  await submit();
  expect(named()).toEqual([
    "Adults included in the base price",
    "Can guests cancel for free?",
    "Accepted payment methods",
    "Adult pricing starts at age (1–18)",
    "Price per child per night (0 is allowed)",
    "Children count toward room capacity",
  ]);
  // Unanswered groups say so and point at their entry; the children question is a fieldset.
  expect(group("Can guests cancel for free?")).toMatchObject({
    role: "group",
    "aria-invalid": true,
    "aria-describedby": entry("Can guests cancel for free?"),
  });
  expect(group("Accepted payment methods")["aria-describedby"]).toBe(
    entry("Accepted payment methods"),
  );
  const children = view.root.find(
    (node) => node.type === "fieldset" && node.props["aria-invalid"] === true,
  );
  expect(children.props["aria-describedby"]).toBe(entry("Children count toward room capacity"));
  expect(field("Adult pricing starts at age (1–18)").props["aria-describedby"]).toBe(
    entry("Adult pricing starts at age (1–18)"),
  );
  // Choosing two included adults asks for the 1-adult adjustment, type and amount.
  await fill("Adults included in the base price", "2");
  expect(named().slice(0, 2)).toEqual(["Adjustment type for 1 adult", "Adjustment for 1 adult"]);
  expect(group("Base price with adult-count adjustments")["aria-describedby"].split(" ")).toEqual([
    entry("Adjustment type for 1 adult"),
    entry("Adjustment for 1 adult"),
  ]);
  await fill("Adjustment type for 1 adult", "fixed");
  await fill("Adjustment for 1 adult", "-30");
  expect(named()[0]).toBe("Can guests cancel for free?");
  expect(group("Base price with adult-count adjustments")["aria-describedby"]).toBeUndefined();
  await press("No, non-refundable");
  expect(group("Can guests cancel for free?")).toMatchObject({
    "aria-invalid": undefined,
    "aria-describedby": undefined,
  });
});
