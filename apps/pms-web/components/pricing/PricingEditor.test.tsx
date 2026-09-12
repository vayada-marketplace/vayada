import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FirstPricingSetup, firstPricingInput } from "./FirstPricingSetup";
import { PricingEditor } from "./PricingEditor";
import { changeDatePrice } from "./PricingDates";
import { changeSeasonPrice } from "./PricingSeasons";
import { changeMonthPrice } from "./PricingMonths";
import { changeWeekdayPrice } from "./PricingWeekdays";
import { editedSnapshot } from "./pricingAmounts";
import { ApiErrorResponse } from "@/services/api/client";
import type { PricingSnapshot, PricingDraft, createReplacementPricingClient } from "@/services/api/replacementPricingClient";

const snapshot: PricingSnapshot = { currency: "EUR", ownerReferences: { finance: "finance" }, rooms: [{
  version: "pricing.v2", propertyId: "property", roomTypeId: "room", revision: 1, currency: "EUR", capacity: { total: 2, adults: 2, children: 1 },
  children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "2500", countsTowardCapacity: true }] },
  offers: [{ id: "flex", termsRevision: "terms", meal: { kind: "breakfast", charge: { kind: "person", adultMinor: "1200", childBandAmountsMinor: ["600"] } },
    price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "10000" }, months: [], seasons: [], weekdays: [], dates: [] } },
    restrictions: { kind: "own", rules: { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] } }],
}] };
const sources = { room: "room", terms: "terms", finance: "finance" };
let view: ReactTestRenderer;
let saved: PricingDraft;
const confirm = vi.fn(), publish = vi.fn();
const client = { termsAction: vi.fn(), readTerms: vi.fn(), read: vi.fn(), prepare: vi.fn(), saveDraft: vi.fn(), reviewCharges: vi.fn(), confirmationAction: vi.fn(() => confirm), publicationAction: vi.fn<(draft: PricingDraft) => typeof publish>(), readDraft: vi.fn() };
const button = (label: string) => view.root.findAllByType("button").find((node) => node.children.join("") === label)!;
const click = async (label: string) => { await act(async () => { button(label).props.onClick(); }); };
const input = () => view.root.findAllByType("input").find((node) => node.props.inputMode === "decimal")!;
const mount = async () => { await act(async () => { view = create(<PricingEditor client={client as ReturnType<typeof createReplacementPricingClient>} />); }); };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("React", React);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => false) });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  client.read.mockResolvedValue({ ...snapshot, revision: 1, sources, stale: false });
  client.prepare.mockImplementation(async (value) => ({ sources, snapshot: { ...snapshot, ...value } }));
  client.saveDraft.mockImplementation(async ({ draftId, expectedDraftRevision, baseRevision, snapshot: value }) => {
    saved = { draftId, revision: expectedDraftRevision + 1, baseRevision, snapshot: value, sources, stale: false }; return saved.revision;
  });
  client.reviewCharges.mockImplementation(async () => ({ ...saved, fingerprint: "fingerprint", declaration: "all_mandatory_charges_included" }));
  client.confirmationAction.mockReturnValue(confirm); client.publicationAction.mockReturnValue(publish);
  confirm.mockResolvedValue({ id: "declaration" }); publish.mockResolvedValue({ revision: 2, replayed: false });
});
afterEach(() => { if (view) act(() => view.unmount()); vi.unstubAllGlobals(); });
it("saves edited amounts, shows charges, requires acknowledgment and retries the exact publication", async () => {
  await mount(); await act(async () => input().props.onChange({ target: { value: "123.45" } }));
  expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); expect(confirm).not.toHaveBeenCalled();
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { base: { amountMinor: "12345" } } });
  expect(saved.snapshot.rooms[0].children).toEqual(snapshot.rooms[0].children);
  await click("Review saved charges"); expect(button("Approve rates").props.disabled).toBe(true);
  const rendered = JSON.stringify(view.toJSON()); expect(rendered).toContain("12.00"); expect(rendered).toContain("6.00"); expect(rendered).toContain("25.00");
  await act(async () => view.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }));
  publish.mockRejectedValueOnce(new Error("lost response"));
  await click("Approve rates"); expect(input().props.disabled).toBe(true); expect(button("Reload pricing").props.disabled).toBe(true);
  await click("Retry last action"); expect(confirm).toHaveBeenCalledTimes(1); expect(client.publicationAction).toHaveBeenCalledTimes(1); expect(publish).toHaveBeenCalledTimes(2);
  expect(client.publicationAction.mock.calls[0][0]).toMatchObject({ revision: 2, snapshot: { ownerReferences: { charges: "declaration" } } });
  expect(JSON.stringify(view.toJSON())).toContain("Channel distribution is not connected yet");
});
it("invalidates saved review on editing and rejects invalid decimals before making requests", async () => {
  await mount(); await click("Save draft"); await click("Review saved charges"); await click("Back to editing");
  await act(async () => input().props.onChange({ target: { value: "10.001" } })); await click("Save draft");
  expect(client.prepare).toHaveBeenCalledTimes(1); expect(button("Review saved charges").props.disabled).toBe(true);
  expect(JSON.stringify(view.toJSON())).toContain("Enter a valid price");
});
it("retains an uncertain draft save and serializes repeated clicks", async () => {
  await mount(); const failure = new Error("lost save"); client.saveDraft.mockRejectedValueOnce(failure);
  await click("Save draft"); const first = client.saveDraft.mock.calls[0][0]; await click("Retry last action");
  expect(client.prepare).toHaveBeenCalledTimes(1); expect(client.saveDraft.mock.calls[1][0]).toEqual(first);
  let finish!: (value: unknown) => void; client.reviewCharges.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => { button("Review saved charges").props.onClick(); button("Review saved charges").props.onClick(); });
  expect(client.reviewCharges).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ...saved, fingerprint: "fingerprint", declaration: "all_mandatory_charges_included" }));
});
it("distinguishes missing configuration from denial and requires reload after a conflict", async () => {
  client.read.mockResolvedValueOnce(null); await mount(); expect(JSON.stringify(view.toJSON())).toContain("not configured yet");
  client.read.mockRejectedValueOnce(new ApiErrorResponse(403, {})); await click("Reload pricing");
  expect(JSON.stringify(view.toJSON())).toContain("do not have access"); expect(JSON.stringify(view.toJSON())).not.toContain("not configured yet");
  await click("Reload pricing"); client.prepare.mockRejectedValueOnce(new ApiErrorResponse(409, {})); await click("Save draft");
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Reload pricing").props.disabled).toBe(false);
});
it("preserves all non-base settings and handles every supported mode without floating point rounding", () => {
  const bases = [{ mode: "flat", amountMinor: "100" }, { mode: "occupancy", amountsMinor: ["100", "200"] }, { mode: "per_person", unitMinor: "100" }, { mode: "included_guests", baseGuests: 1, baseMinor: "100", adjustments: [] }] as const;
  for (const base of bases) {
    const original: PricingSnapshot = { ...snapshot, rooms: [{ ...snapshot.rooms[0], offers: [{ ...snapshot.rooms[0].offers[0], price: { kind: "independent", calendar: { base, months: [], seasons: [], weekdays: [], dates: [] } } }] }] };
    const changed = editedSnapshot(original, { "0:0:0": "90071992547409.93" });
    expect(JSON.stringify(changed)).toContain("9007199254740993"); expect(original.rooms[0].offers[0].price).toMatchObject({ calendar: { base } });
    expect(changed.rooms[0].offers[0].meal).toEqual(original.rooms[0].offers[0].meal);
  }
  expect(() => editedSnapshot(snapshot, { "0:0:0": "1e2" })).toThrow();
  expect(() => editedSnapshot(snapshot, { "0:0:0": "0" })).toThrow("greater than zero");
});
it("shows retained adjustments, date prices and restrictions in the saved review", async () => {
  const room = snapshot.rooms[0], offer = room.offers[0];
  client.read.mockResolvedValueOnce({ ...snapshot, revision: 1, sources, stale: false, rooms: [{ ...room, offers: [
    { ...offer, price: { kind: "independent", calendar: { base: { mode: "included_guests", baseGuests: 2, baseMinor: "13000", adjustments: [{ kind: "fixed", deltaMinor: "-3000" }, { kind: "fixed", deltaMinor: "0" }] }, months: [], seasons: [], weekdays: [], dates: [{ date: "2026-12-25", price: { mode: "flat", amountMinor: "20000" } }] } } },
    { ...offer, id: "discount", price: { kind: "linked", parentId: offer.id, adjustment: { kind: "percentage", basisPoints: -1000 }, dateOverrides: [] }, restrictions: { kind: "inherit" } },
  ] }] });
  await mount(); await click("Save draft"); await click("Review saved charges");
  const text = JSON.stringify(view.toJSON()); for (const value of ["−30.00 EUR", "2026-12-25", "200.00 EUR", "-10%", "Minimum arrival stay 1", "Stay restrictions inherited", "Show cancellation and payment terms"]) expect(text).toContain(value);
});
it("warns before leaving pending work and cancels property changes before selection mutates", async () => {
  await mount(); await act(async () => input().props.onChange({ target: { value: "120" } }));
  const listener = (name: string) => vi.mocked(window.addEventListener).mock.calls.filter(([event]) => event === name).at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true }); listener("beforeunload")(unload); expect(unload.defaultPrevented).toBe(true);
  const change = new Event("pms:before-property-change", { cancelable: true }); listener("pms:before-property-change")(change); expect(change.defaultPrevented).toBe(true);
  vi.mocked(window.confirm).mockReturnValueOnce(true); const accepted = new Event("pms:before-property-change", { cancelable: true }); listener("pms:before-property-change")(accepted);
  expect(accepted.defaultPrevented).toBe(false); const leaving = new Event("beforeunload", { cancelable: true }); listener("beforeunload")(leaving); expect(leaving.defaultPrevented).toBe(false);
});

it.each([new Error("lost preparation response"), new ApiErrorResponse(403, {})])("retains a created policy after preparation failure %s and requires draft review", async (failure) => {
  const id = "61000000-0000-4000-8000-000000000001", room = { roomTypeId: id, name: "Double", capacity: { total: 2, adults: 2, children: 1 } };
  client.read.mockResolvedValueOnce(null);
  const policy = vi.fn().mockResolvedValue({ revision: id }); client.termsAction.mockReturnValue(policy);
  client.prepare.mockRejectedValueOnce(failure);
  await act(async () => { view = create(<PricingEditor client={client as ReturnType<typeof createReplacementPricingClient>} setup={{ propertyId: id, rooms: [room] }} />); });
  const input = firstPricingInput(id, room, id, { mode: "flat", occupancy: [], included: { adults: "", adjustments: [] }, room: id, currency: "EUR", base: "130", adultAge: "12", childPrice: "0", countChildren: "yes", minimum: "1", maximum: "", cancellation: "non_refundable", freeDays: "", payment: "full" });
  await act(async () => view.root.findByType(FirstPricingSetup).props.onCreate(input));
  expect(view.root.findByType(FirstPricingSetup).props.disabled).toBe(true); expect(button("Reload pricing").props.disabled).toBe(true);
  await click("Retry last action"); expect(policy).toHaveBeenCalledOnce(); expect(client.prepare).toHaveBeenCalledTimes(2);
  expect(client.saveDraft).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); expect(saved.baseRevision).toBe(0); expect(saved.snapshot.rooms[0].offers[0].termsRevision).toBe(id);
  await click("Review saved charges"); expect(button("Approve rates").props.disabled).toBe(true);
});
it.each(["occupancy", "per_person"])("preserves %s prices through editing and saved charge review", async (mode) => {
  const value = structuredClone(snapshot), offer = value.rooms[0].offers[0];
  if (offer.price.kind !== "independent") throw new Error("fixture");
  const price = { ...offer.price, calendar: { ...offer.price.calendar, base: mode === "occupancy" ? { mode, amountsMinor: ["10000", "13000"] } : { mode: "per_person", unitMinor: "6000" } } };
  client.read.mockResolvedValue({ ...value, rooms: [{ ...value.rooms[0], offers: [{ ...offer, price }] }], revision: 1, sources, stale: false }); await mount();
  const label = mode === "occupancy" ? "Room 1 Offer 1 2 adults" : "Room 1 Offer 1 Per adult";
  await act(async () => view.root.findByProps({ "aria-label": label }).props.onChange({ target: { value: "75.25" } }));
  await click("Save draft"); await click("Review saved charges");
  expect(view.root.findByProps({ "aria-label": label }).props.value).toBe("75.25");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { base: mode === "occupancy" ? { mode, amountsMinor: ["10000", "7525"] } : { mode: "per_person", unitMinor: "7525" } } });
  expect(saved.snapshot.rooms[0].children).toEqual(snapshot.rooms[0].children);
  expect(button("Approve rates").props.disabled).toBe(true);
});
it("keeps included-adult adjustments when editing and reviewing the saved base price", async () => {
  const value = structuredClone(snapshot), offer = value.rooms[0].offers[0]; if (offer.price.kind !== "independent") throw new Error("fixture");
  const adjustments = [{ kind: "fixed" as const, deltaMinor: "-3000" }, { kind: "fixed" as const, deltaMinor: "0" }];
  const price = { ...offer.price, calendar: { ...offer.price.calendar, base: { mode: "included_guests" as const, baseGuests: 2, baseMinor: "13000", adjustments } } };
  client.read.mockResolvedValue({ ...value, rooms: [{ ...value.rooms[0], offers: [{ ...offer, price }] }], revision: 1, sources, stale: false }); await mount();
  await act(async () => input().props.onChange({ target: { value: "150" } })); await click("Save draft"); await click("Review saved charges");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { base: { baseMinor: "15000", baseGuests: 2, adjustments } } });
  expect(JSON.stringify(view.toJSON())).toContain("1 adult −30.00 EUR; 2 adults 0.00 EUR");
  expect(button("Approve rates").props.disabled).toBe(true);
});
it("labels every saved weekday using Monday-zero without changing its adjustment", async () => {
  const room = snapshot.rooms[0], offer = room.offers[0]; if (offer.price.kind !== "independent") throw new Error("fixture");
  const weekdays = Array.from({ length: 7 }, (_, day) => ({ day, adjustment: { kind: "percentage" as const, basisPoints: (day + 1) * 100 } }));
  client.read.mockResolvedValueOnce({ ...snapshot, revision: 1, sources, stale: false, rooms: [{ ...room, offers: [{ ...offer, price: { ...offer.price, calendar: { ...offer.price.calendar, weekdays } } }] }] });
  await mount(); await click("Save draft"); await click("Review saved charges");
  const paragraphs = view.root.findAllByType("p").map((node) => node.children.join(""));
  expect(paragraphs).toEqual(expect.arrayContaining(["Monday: 1%", "Tuesday: 2%", "Wednesday: 3%", "Thursday: 4%", "Friday: 5%", "Saturday: 6%", "Sunday: 7%"]));
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { weekdays } });
});
it("adds and clears an independent date price without changing fallback or other rules", () => {
  const room = snapshot.rooms[0], before = structuredClone(room), added = changeDatePrice(room, "flex", "2028-02-29", "150.25");
  expect(added.offers[0].price).toMatchObject({ calendar: { base: { amountMinor: "10000" }, dates: [{ date: "2028-02-29", price: { mode: "flat", amountMinor: "15025" } }] } });
  expect(changeDatePrice(added, "flex", "2028-02-29", null)).toEqual(room); expect(room).toEqual(before);
  for (const [date, amount] of [["2026-02-29", "100"], ["", "100"], ["2026-12-25", "0"], ["2026-12-25", "1.001"]]) expect(() => changeDatePrice(room, "flex", date, amount)).toThrow();
  expect(() => changeDatePrice(added, "flex", "2028-02-29", "200")).toThrow("Clear the existing");
});
it("preserves linked adjustments, other dates and parents when clearing an override", () => {
  const room = snapshot.rooms[0], child = { ...room.offers[0], id: "nr", price: { kind: "linked" as const, parentId: "flex", adjustment: { kind: "percentage" as const, basisPoints: -1000 }, dateOverrides: [{ date: "2026-12-24", price: { mode: "flat" as const, amountMinor: "11000" } }] }, restrictions: { kind: "inherit" as const } };
  const linked = { ...room, offers: [...room.offers, child] };
  const added = changeDatePrice(linked, "nr", "2026-12-25", "200");
  expect(added.offers[0]).toEqual(room.offers[0]); expect(added.offers[1]).toMatchObject({ meal: child.meal, restrictions: child.restrictions, price: { parentId: "flex", adjustment: child.price.adjustment } });
  expect(changeDatePrice(added, "nr", "2026-12-25", null)).toEqual(linked);
});
it("blocks saving unfinished date entry, protects leaving and requires review for applied dates", async () => {
  await mount(); await click("Save draft");
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  expect(field("Override date for Room 1 Offer 1").props.type).toBe("text");
  await act(async () => field("Override date for Room 1 Offer 1").props.onChange({ target: { value: "2026-12-" } }));
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Cancel date entry");
  await act(async () => field("Date room price for Room 1 Offer 1").props.onChange({ target: { value: "150.25" } }));
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true);
  const listener = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true }); listener(unload); expect(unload.defaultPrevented).toBe(true);
  await click("Cancel date entry"); expect(button("Save draft").props.disabled).toBe(false);
  await act(async () => field("Override date for Room 1 Offer 1").props.onChange({ target: { value: "2026-12-25" } }));
  await act(async () => field("Date room price for Room 1 Offer 1").props.onChange({ target: { value: "150.25" } }));
  await click("Add date price"); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); await click("Review saved charges");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { dates: [{ date: "2026-12-25", price: { amountMinor: "15025" } }] } });
  expect(button("Clear date price").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
  await click("Back to editing"); await click("Clear date price"); await click("Save draft");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { base: { amountMinor: "10000" }, dates: [] } });
});

it("adds exact weekday adjustments and clears only the selected rule", () => {
  const room = changeDatePrice(snapshot.rooms[0], "flex", "2026-12-25", "150.25");
  const monday = changeWeekdayPrice(room, "flex", "0", { kind: "percentage", value: "-10.25" });
  const friday = changeWeekdayPrice(monday, "flex", "4", { kind: "fixed", value: "+20.05" });
  expect(friday.offers[0].price).toMatchObject({ calendar: { weekdays: [
    { day: 0, adjustment: { kind: "percentage", basisPoints: -1025 } }, { day: 4, adjustment: { kind: "fixed", deltaMinor: "2005" } },
  ], dates: [{ date: "2026-12-25", price: { amountMinor: "15025" } }] } });
  expect(changeWeekdayPrice(friday, "flex", "4", null)).toEqual(monday);
  expect(changeWeekdayPrice(monday, "flex", "0", null)).toEqual(room);
  for (const day of ["", "7", "-1", "00", "0.0"]) expect(() => changeWeekdayPrice(room, "flex", day, { kind: "fixed", value: "1" })).toThrow();
  for (const value of ["", "NaN", "1e2", "1.001", "9999999999999999999"]) expect(() => changeWeekdayPrice(room, "flex", "0", { kind: "fixed", value })).toThrow();
  for (const value of ["-100.01", "90071992547409.92", "1.001"]) expect(() => changeWeekdayPrice(room, "flex", "0", { kind: "percentage", value })).toThrow();
  expect(() => changeWeekdayPrice(monday, "flex", "0", { kind: "fixed", value: "1" })).toThrow(/Clear/);
  expect(() => changeWeekdayPrice(room, "flex", "0", null)).toThrow();
  expect(changeWeekdayPrice({ ...room, currency: "KWD" }, "flex", "6", { kind: "fixed", value: "-1.123" }).offers[0].price).toMatchObject({ calendar: { weekdays: [{ day: 6, adjustment: { deltaMinor: "-1123" } }] } });
  expect(() => changeWeekdayPrice({ ...room, currency: "JPY" }, "flex", "0", { kind: "fixed", value: "1.1" })).toThrow();
  const linked = { ...room.offers[0], id: "linked", price: { kind: "linked" as const, parentId: "flex", adjustment: { kind: "fixed" as const, deltaMinor: "0" }, dateOverrides: [] }, restrictions: { kind: "inherit" as const } };
  expect(() => changeWeekdayPrice({ ...room, offers: [...room.offers, linked] }, "linked", "0", { kind: "fixed", value: "1" })).toThrow(/independent/);
});

it("keeps date and weekday pending entries separate and reviews saved weekday changes", async () => {
  await mount(); await click("Save draft");
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) => act(async () => field(name).props.onChange({ target: { value } }));
  expect(field("Weekday for Room 1 Offer 1").props.value).toBe("");
  expect(field("Weekday adjustment type for Room 1 Offer 1").props.value).toBe("");
  await fill("Weekday for Room 1 Offer 1", "0");
  await fill("Override date for Room 1 Offer 1", "2026-");
  await click("Cancel date entry");
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true);
  const listener = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true }); listener(unload); expect(unload.defaultPrevented).toBe(true);
  await fill("Override date for Room 1 Offer 1", "2026-");
  await click("Cancel weekday entry"); expect(button("Save draft").props.disabled).toBe(true);
  await click("Cancel date entry"); expect(button("Save draft").props.disabled).toBe(false);
  await fill("Weekday for Room 1 Offer 1", "4"); await fill("Weekday adjustment type for Room 1 Offer 1", "fixed");
  await fill("Weekday adjustment for Room 1 Offer 1", "+20.05"); await click("Add weekday adjustment");
  expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); await click("Review saved charges");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { weekdays: [{ day: 4, adjustment: { deltaMinor: "2005" } }] } });
  expect(JSON.stringify(view.toJSON())).toContain("Friday");
  expect(button("Clear weekday adjustment").props.disabled).toBe(true); expect(button("Add weekday adjustment").props.disabled).toBe(true);
  expect(button("Approve rates").props.disabled).toBe(true);
  await click("Back to editing"); await click("Clear weekday adjustment"); await click("Save draft");
  expect(saved.snapshot.rooms[0]).toEqual({ ...snapshot.rooms[0], revision: 2 });
});

it("adds monthly prices in all recurring modes and preserves other rules on clear", () => {
  const modes = [
    { mode: "flat" as const, amountMinor: "10000" },
    { mode: "per_person" as const, unitMinor: "5000" },
    { mode: "occupancy" as const, amountsMinor: ["10000", "15000"] },
    { mode: "included_guests" as const, baseMinor: "13000", baseGuests: 2, adjustments: [{ kind: "fixed" as const, deltaMinor: "-3000" }, { kind: "fixed" as const, deltaMinor: "0" }] },
  ];
  for (const base of modes) {
    const original = snapshot.rooms[0], offer = original.offers[0]; if (offer.price.kind !== "independent") throw new Error();
    const room = { ...original, offers: [{ ...offer, price: { ...offer.price, calendar: { ...offer.price.calendar, base } } }] };
    const dates = changeDatePrice(room, "flex", "2026-08-25", "220");
    const weekday = changeWeekdayPrice(dates, "flex", "4", { kind: "fixed", value: "20" });
    const added = changeMonthPrice(weekday, "flex", "8", base.mode === "occupancy" ? ["170", "180"] : ["180"]);
    expect(changeMonthPrice(added, "flex", "8", null)).toEqual(weekday);
    expect(added.offers[0].price).toMatchObject({ calendar: { base, months: [{ month: 8, price: { mode: base.mode } }] } });
    expect(() => changeMonthPrice(added, "flex", "8", ["190"])).toThrow(/Clear/);
    if (base.mode === "included_guests") {
      expect(added.offers[0].price).toMatchObject({ calendar: { months: [{ price: { baseMinor: "18000", baseGuests: 2, adjustments: base.adjustments } }] } });
      expect(() => changeMonthPrice(weekday, "flex", "8", ["20"])).toThrow();
    }
    if (base.mode === "occupancy") expect(() => changeMonthPrice(weekday, "flex", "8", ["180"])).toThrow();
  }
  const room = snapshot.rooms[0];
  for (const month of ["", "0", "13", "01", "1.5"]) expect(() => changeMonthPrice(room, "flex", month, ["180"])).toThrow();
  for (const amount of ["", "0", "-1", "1.001", "NaN"]) expect(() => changeMonthPrice(room, "flex", "8", [amount])).toThrow();
  expect(changeMonthPrice({ ...room, currency: "KWD" }, "flex", "1", ["1.123"]).offers[0].price).toMatchObject({ calendar: { months: [{ price: { amountMinor: "1123" } }] } });
  expect(() => changeMonthPrice({ ...room, currency: "JPY" }, "flex", "1", ["1.1"])).toThrow();
  const added = changeMonthPrice(room, "flex", "8", ["180"]);
  const offer = added.offers[0]; if (offer.price.kind !== "independent") throw new Error();
  const calendarOnly = { ...added, offers: [{ ...offer, price: { ...offer.price, calendar: { ...offer.price.calendar, base: null } } }] };
  expect(changeMonthPrice(calendarOnly, "flex", "9", ["190"]).offers[0].price).toMatchObject({ calendar: { base: null, months: [{ month: 8 }, { month: 9 }] } });
  const cleared = changeMonthPrice(calendarOnly, "flex", "8", null);
  expect(() => changeMonthPrice(cleared, "flex", "9", ["190"])).toThrow(/recurring/);
});

it("protects unfinished monthly prices independently and reviews only saved changes", async () => {
  await mount(); await click("Save draft");
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) => act(async () => field(name).props.onChange({ target: { value } }));
  expect(field("Month for Room 1 Offer 1").props.value).toBe("");
  await fill("Month for Room 1 Offer 1", "8"); await fill("Weekday for Room 1 Offer 1", "0"); await click("Cancel weekday entry");
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true);
  const listener = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true }); listener(unload); expect(unload.defaultPrevented).toBe(true);
  await fill("Override date for Room 1 Offer 1", "2026-"); await click("Cancel month entry"); expect(button("Save draft").props.disabled).toBe(true);
  await click("Cancel date entry"); expect(button("Save draft").props.disabled).toBe(false);
  await fill("Month for Room 1 Offer 1", "8"); await fill("Monthly Per room for Room 1 Offer 1", "180.25");
  await click("Add monthly price"); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); await click("Review saved charges");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { months: [{ month: 8, price: { amountMinor: "18025" } }] } });
  expect(button("Clear monthly price").props.disabled).toBe(true); expect(button("Add monthly price").props.disabled).toBe(true);
  expect(button("Approve rates").props.disabled).toBe(true); expect(JSON.stringify(view.toJSON())).toContain("August");
  await click("Back to editing"); await click("Clear monthly price"); await click("Save draft");
  expect(saved.snapshot.rooms[0]).toEqual({ ...snapshot.rooms[0], revision: 2 });
});

it("validates recurring season dates and preserves the exact other pricing rules", () => {
  const winter = { name: "Winter holidays", tier: "High", from: "12-15", through: "01-10" };
  const leap = { name: "Leap day", tier: "", from: "02-29", through: "02-29" };
  const original = changeMonthPrice(changeWeekdayPrice(changeDatePrice(snapshot.rooms[0], "flex", "2026-12-25", "250"), "flex", "4", { kind: "fixed", value: "20" }), "flex", "8", ["180"]);
  const added = changeSeasonPrice(original, "flex", winter, ["200.25"]);
  expect(added.offers[0].price).toMatchObject({ calendar: { seasons: [{ ...winter, price: { mode: "flat", amountMinor: "20025" } }] } });
  const both = changeSeasonPrice(added, "flex", leap, ["190"]);
  expect(changeSeasonPrice(both, "flex", leap, null)).toEqual(added);
  expect(changeSeasonPrice(added, "flex", winter, null)).toEqual(original);
  for (const season of [winter, { ...winter, from: "01-10", through: "02-01" }, { ...winter, from: "12-01", through: "12-15" }, { ...winter, from: "02-30" }, { ...winter, from: "2-01" }, { ...winter, name: " " }]) expect(() => changeSeasonPrice(added, "flex", season, ["200"])).toThrow();
  expect(() => changeSeasonPrice(both, "flex", { ...leap, from: "02-28", through: "03-01" }, ["200"])).toThrow();
  expect(() => changeSeasonPrice(original, "flex", winter, ["0"])).toThrow();
  expect(() => changeSeasonPrice(original, "flex", winter, ["1.001"])).toThrow();
  expect(() => changeSeasonPrice(original, "flex", winter, null)).toThrow();
  const bases = [
    { mode: "per_person" as const, unitMinor: "5000" },
    { mode: "occupancy" as const, amountsMinor: ["10000", "13000"] },
    { mode: "included_guests" as const, baseMinor: "13000", baseGuests: 2, adjustments: [{ kind: "fixed" as const, deltaMinor: "-3000" }, { kind: "fixed" as const, deltaMinor: "0" }] },
  ];
  for (const base of bases) {
    const room = snapshot.rooms[0], offer = room.offers[0]; if (offer.price.kind !== "independent") throw new Error();
    const configured = { ...room, offers: [{ ...offer, price: { ...offer.price, calendar: { ...offer.price.calendar, base } } }] };
    const result = changeSeasonPrice(configured, "flex", winter, base.mode === "occupancy" ? ["160", "190"] : ["190"]);
    expect(result.offers[0].price).toMatchObject({ calendar: { base, seasons: [{ ...winter, price: { mode: base.mode } }] } });
    expect(changeSeasonPrice(result, "flex", winter, null)).toEqual(configured);
    if (base.mode === "included_guests") {
      expect(result.offers[0].price).toMatchObject({ calendar: { seasons: [{ price: { baseMinor: "19000", baseGuests: 2, adjustments: base.adjustments } }] } });
      expect(() => changeSeasonPrice(configured, "flex", winter, ["20"])).toThrow();
    }
    if (base.mode === "occupancy") expect(() => changeSeasonPrice(configured, "flex", winter, ["100"])).toThrow();
  }
});

it("protects season text independently and requires review after adding or clearing", async () => {
  await mount(); await click("Save draft");
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) => act(async () => field(name).props.onChange({ target: { value } }));
  await fill("Tier label (optional) for Room 1 Offer 1", "High");
  await fill("Month for Room 1 Offer 1", "8"); await click("Cancel month entry");
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true);
  const listener = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true }); listener(unload); expect(unload.defaultPrevented).toBe(true);
  await fill("Month for Room 1 Offer 1", "8"); await click("Cancel season entry"); expect(button("Save draft").props.disabled).toBe(true);
  await click("Cancel month entry"); expect(button("Save draft").props.disabled).toBe(false);
  for (const [name, value] of [["Season name", "Summer"], ["Tier label (optional)", "High"], ["Start (MM-DD)", "06-15"], ["End (MM-DD)", "09-10"], ["Seasonal Per room", "180.25"]]) await fill(`${name} for Room 1 Offer 1`, value);
  await click("Add seasonal price"); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); await click("Review saved charges");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { seasons: [{ name: "Summer", tier: "High", from: "06-15", through: "09-10", price: { amountMinor: "18025" } }] } });
  expect(button("Clear seasonal price").props.disabled).toBe(true); expect(button("Add seasonal price").props.disabled).toBe(true);
  expect(button("Approve rates").props.disabled).toBe(true); expect(JSON.stringify(view.toJSON())).toContain("Summer");
  await click("Back to editing"); await click("Clear seasonal price"); await click("Save draft");
  expect(saved.snapshot.rooms[0]).toEqual({ ...snapshot.rooms[0], revision: 2 });
});
