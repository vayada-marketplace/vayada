import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { FirstPricingSetup, firstPricingInput } from "./FirstPricingSetup";
const id = "61000000-0000-4000-8000-000000000001";
const room = { roomTypeId: id, name: "Double", capacity: { total: 2, adults: 2, children: 1 } };
const values = { mode: "flat", occupancy: [], included: { adults: "", adjustments: [] }, room: id, currency: "EUR", base: "123.45", adultAge: "12", childPrice: "0", countChildren: "yes", minimum: "1", maximum: "", cancellation: "flexible", freeDays: "7", payment: "full" };
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
it("requires a complete positive occupancy table and keeps child charges separate", () => {
  const build = (occupancy: string[]) => firstPricingInput(id, room, id, { ...values, mode: "occupancy", base: "ignored", occupancy });
  expect(build(["100", "130.25"]).configuration.offers[0].price).toMatchObject({ calendar: { base: { mode: "occupancy", amountsMinor: ["10000", "13025"] } } });
  expect(build(["100", "100"]).configuration.children.bands[0].nightlyMinor).toBe("0");
  for (const invalid of [[], ["100"], ["100", ""], ["100", "0"], ["100", "20.001"], ["100", "130", "150"]]) expect(() => build(invalid)).toThrow();
  expect(() => firstPricingInput(id, room, id, { ...values, mode: "" })).toThrow("Choose how");
});
it("creates only the chosen per-person tariff using exact currency units", () => {
  for (const [currency, base, unitMinor] of [["JPY", "6000", "6000"], ["EUR", "60.25", "6025"], ["KWD", "60.123", "60123"]]) {
    const result = firstPricingInput(id, room, id, { ...values, currency, mode: "per_person", base, occupancy: ["ignored"] });
    expect(result.configuration.offers[0].price).toMatchObject({ calendar: { base: { mode: "per_person", unitMinor } } });
  }
  expect(() => firstPricingInput(id, room, id, { ...values, currency: "JPY", mode: "per_person", base: "1.5" })).toThrow();
});
it("clears prices on room and mode changes and cannot submit an incomplete table", async () => {
  vi.stubGlobal("React", React); const onCreate = vi.fn(); let view!: ReactTestRenderer;
  const other = { ...room, roomTypeId: "61000000-0000-4000-8000-000000000002", name: "Single", capacity: { total: 1, adults: 1, children: 0 } };
  const props = { propertyId: id, rooms: [room, other], disabled: false, onCreate, onDirty: vi.fn() };
  await act(async () => { view = create(<FirstPricingSetup {...props} />); });
  const change = async (label: string, value: string) => { await act(async () => view.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } })); };
  await change("Room type", id); await change("How is the room priced?", "flat"); await change("Room price per night", "100");
  await change("How is the room priced?", "per_person"); expect(view.root.findByProps({ "aria-label": "Price per adult per night" }).props.value).toBe("");
  await change("How is the room priced?", "occupancy"); await change("Room price for 1 adult per night", "100");
  await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} })); expect(onCreate).not.toHaveBeenCalled();
  await change("Room type", other.roomTypeId); expect(view.root.findByProps({ "aria-label": "Room price for 1 adult per night" }).props.value).toBe("");
  expect(view.root.findAllByProps({ "aria-label": "Room price for 2 adults per night" })).toHaveLength(0);
  await change("Room type", id); expect(view.root.findByProps({ "aria-label": "Room price for 2 adults per night" }).props.value).toBe("");
  await act(async () => view.update(<FirstPricingSetup {...props} disabled />));
  expect(view.root.findAllByType("input").every((node) => node.props.disabled)).toBe(true);
  act(() => view.unmount());
});
it("validates included-adult setup before returning a policy command", () => {
  const three = { ...room, capacity: { total: 3, adults: 3, children: 1 } };
  const included = { adults: "2", adjustments: [{ kind: "fixed", value: "-30" }, { kind: "", value: "" }, { kind: "percentage", value: "25" }] };
  const result = firstPricingInput(id, three, id, { ...values, mode: "included_guests", base: "130", included });
  expect(result.configuration.offers[0].price).toMatchObject({ calendar: { base: { mode: "included_guests", baseGuests: 2, adjustments: [{ deltaMinor: "-3000" }, { deltaMinor: "0" }, { basisPoints: 2500 }] } } });
  expect(() => firstPricingInput(id, three, id, { ...values, mode: "included_guests", included: { adults: "2", adjustments: [] } })).toThrow();
});
