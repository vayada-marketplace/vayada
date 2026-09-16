import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PricingSnapshot } from "@/services/api/replacementPricingClient";
import { PricingStayPreview } from "./PricingStayPreview";

const snapshot: PricingSnapshot = { currency: "EUR", ownerReferences: { finance: "finance" }, rooms: [{
  version: "pricing.v2", propertyId: "property", roomTypeId: "room", revision: 1, currency: "EUR", capacity: { total: 3, adults: 3, children: 1 },
  children: { adultFromAge: 18, bands: [{ fromAge: 0, throughAge: 17, nightlyMinor: "2000", countsTowardCapacity: true }] },
  offers: [{ id: "flex", termsRevision: "terms", meal: { kind: "breakfast", charge: { kind: "person", adultMinor: "1500", childBandAmountsMinor: ["500"] } },
    price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "13000" }, months: [], seasons: [], weekdays: [], dates: [] } },
    restrictions: { kind: "own", rules: { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] } },
  { id: "nr", termsRevision: "terms-nr", price: { kind: "linked", parentId: "flex", adjustment: { kind: "percentage", basisPoints: -1000 }, dateOverrides: [] },
    meal: { kind: "breakfast", charge: { kind: "person", adultMinor: "1500", childBandAmountsMinor: ["500"] } }, restrictions: { kind: "inherit" } }],
}] };
let view: ReactTestRenderer;
let props: React.ComponentProps<typeof PricingStayPreview>;
const text = () => JSON.stringify(view.toJSON());
const change = async (label: string, value: string) => { await act(async () => view.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } })); };
const calculate = async () => { await act(async () => view.root.findByType("button").props.onClick()); };
const update = async (next: Partial<typeof props>) => { props = { ...props, ...next }; await act(async () => view.update(<PricingStayPreview {...props} />)); };
beforeEach(async () => {
  vi.stubGlobal("React", React); props = { snapshot: structuredClone(snapshot), inputs: {}, disabled: false, saved: false, roomNames: { room: "Triple" } };
  await act(async () => { view = create(<PricingStayPreview {...props} />); });
  await change("Preview check-in", "2027-01-04"); await change("Preview check-out", "2027-01-07");
});
afterEach(async () => { await act(async () => view.unmount()); vi.unstubAllGlobals(); });

it("uses shared linked-room/child/meal arithmetic and checkout-exclusive nightly evidence", async () => {
  await change("Preview child ages at check-in", "8"); await calculate();
  expect(text()).toContain("555.00 EUR");
  await change("Preview room and offer", "0:1"); expect(text()).not.toContain("555.00 EUR"); await calculate();
  expect(text()).toContain("510.00 EUR"); expect(text()).toContain("405.00 EUR"); expect(text()).toContain("105.00 EUR");
  expect(view.root.findByType("tbody").findAllByType("tr")).toHaveLength(3); expect(text()).toContain("linked");
});

it("invalidates totals for raw edits, blocks invalid prices, and cannot revive an old result", async () => {
  await calculate(); expect(text()).toContain("480.00 EUR");
  await update({ inputs: { "0:0:0": "150.25" } }); expect(text()).not.toContain("480.00 EUR"); await calculate(); expect(text()).toContain("540.75 EUR");
  await update({ inputs: { "0:0:0": "" } }); expect(text()).not.toContain("540.75 EUR"); await calculate(); expect(text()).toContain("Enter a valid price");
  await update({ inputs: { "0:0:0": "150.25" } }); expect(text()).not.toContain("540.75 EUR");
});

it("blocks pending edits and calculates the explicit saved-review snapshot", async () => {
  await calculate(); await update({ disabled: true }); await calculate();
  expect(view.root.findByType("button").props.disabled).toBe(true); expect(text()).not.toContain("480.00 EUR");
  await update({ disabled: false, saved: true }); expect(text()).not.toContain("480.00 EUR"); await calculate();
  expect(text()).toContain("exact saved prices under review"); expect(text()).toContain("480.00 EUR");
  const next: PricingSnapshot = { ...snapshot, rooms: snapshot.rooms.map((room) => ({ ...room, offers: room.offers.map((offer) => offer.price.kind === "independent" ? { ...offer, price: { ...offer.price, calendar: { ...offer.price.calendar, dates: [{ date: "2027-01-05", price: { mode: "flat", amountMinor: "20000" } }] } } } : offer) })) };
  await update({ snapshot: next }); expect(text()).not.toContain("480.00 EUR"); await calculate(); expect(text()).toContain("550.00 EUR"); expect(text()).toContain("date");
});

it("rejects malformed ages, capacity excess, invalid dates and oversized preview ranges", async () => {
  await change("Preview child ages at check-in", "8,"); await calculate(); expect(text()).toContain("separated by commas");
  await change("Preview child ages at check-in", "8, 9"); await calculate(); expect(text()).toContain("capacity rules");
  await change("Preview child ages at check-in", ""); await change("Preview check-out", "2027-01-04"); await calculate(); expect(text()).toContain("checkout after check-in");
  await change("Preview check-out", "9999-12-31"); await calculate(); expect(text()).toContain("366 nights");
});

it("reports inherited restrictions without displaying a price", async () => {
  const next: PricingSnapshot = { ...snapshot, rooms: snapshot.rooms.map((room) => ({ ...room, offers: room.offers.map((offer) => offer.restrictions.kind === "own" ? { ...offer, restrictions: { ...offer.restrictions, rules: { ...offer.restrictions.rules, minArrivalNights: 4 } } } : offer) })) };
  await update({ snapshot: next }); await change("Preview room and offer", "0:1"); await calculate();
  expect(text()).toContain("stay-length"); expect(text()).not.toContain("Room and meal estimate:");
});
