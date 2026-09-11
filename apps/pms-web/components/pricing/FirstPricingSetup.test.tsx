import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { FirstPricingSetup, firstPricingInput } from "./FirstPricingSetup";
const id = "61000000-0000-4000-8000-000000000001";
const room = { roomTypeId: id, name: "Double", capacity: { total: 2, adults: 2, children: 1 } };
const values = { room: id, currency: "EUR", base: "123.45", adultAge: "12", childPrice: "0", countChildren: "yes", minimum: "1", maximum: "", cancellation: "flexible", freeDays: "7", payment: "full" };
afterEach(() => vi.unstubAllGlobals());
it("builds exact explicit configuration without borrowing old prices or policies", () => {
  const { configuration, terms } = firstPricingInput(id, room, id, values);
  expect(configuration.capacity).toEqual(room.capacity); expect(configuration.children.bands[0]).toMatchObject({ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true });
  expect(configuration.offers[0].price).toMatchObject({ calendar: { base: { mode: "flat", amountMinor: "12345" }, dates: [] } });
  expect(terms).toMatchObject({ expectedRevision: null, payment: { kind: "full" }, cancellation: { terms: { freeCancellationDeadlineDays: 7 } } });
  for (const invalid of [{ base: "0" }, { base: "1.001" }, { adultAge: "19" }, { countChildren: "" }, { payment: "" }, { freeDays: "366" }, { minimum: "" }, { currency: "BAD" }])
    expect(() => firstPricingInput(id, room, id, { ...values, ...invalid })).toThrow();
});
it("starts without policy defaults, requires input, and disables every control while pending", async () => {
  vi.stubGlobal("React", React); const onCreate = vi.fn(), onDirty = vi.fn(); let view!: ReactTestRenderer;
  const props = { propertyId: id, rooms: [room], disabled: false, onCreate, onDirty };
  await act(async () => { view = create(<FirstPricingSetup {...props} />); });
  expect(view.root.findAllByType("select").every((node) => node.props.value === "")).toBe(true);
  await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} })); expect(onCreate).not.toHaveBeenCalled();
  await act(async () => view.root.findByProps({ "aria-label": "Room type" }).props.onChange({ target: { value: id } })); expect(onDirty).toHaveBeenCalledOnce();
  await act(async () => view.update(<FirstPricingSetup {...props} disabled />));
  expect(view.root.findAll((node) => ["input", "select", "button"].includes(String(node.type))).every((node) => node.props.disabled)).toBe(true);
  await act(async () => view.update(<FirstPricingSetup {...props} rooms={[]} />)); expect(JSON.stringify(view.toJSON())).toContain("complete capacity");
  act(() => view.unmount());
});
