import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FirstPricingSetup, firstPricingInput } from "./FirstPricingSetup";
import { PricingEditor } from "./PricingEditor";
import { changeIncludedAdjustments } from "./PricingIncludedAdjustments";
import { changeDatePrice } from "./PricingDates";
import { NewLinkedOffer, linkedOfferInput } from "./NewLinkedOffer";
import { changeLinkedParent, linkedParentChoices } from "./PricingLinkedParent";
import { changeMealPlan } from "./PricingMealPlan";
import { changeMealCharges } from "./PricingMealCharges";
import { changeChildCharges } from "./PricingChildCharges";
import { changeLinkedAdjustment } from "./PricingLinkedAdjustment";
import { changeStayOwnership } from "./PricingStayOwnership";
import { changeStaySeason } from "./PricingStaySeasons";
import { changeStayDate } from "./PricingStayDates";
import { changeStayRules } from "./PricingStayRules";
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

it("updates only own default stay rules and preserves exceptions and linked ownership", () => {
  const room = snapshot.rooms[0], offer = room.offers[0]; if (offer.restrictions.kind !== "own") throw new Error();
  const exceptions = { ...offer.restrictions, seasons: [{ from: "12-15", through: "01-10", rules: { ...offer.restrictions.rules, minArrivalNights: 5 } }], dates: [{ date: "2026-12-25", rules: { ...offer.restrictions.rules, stopSell: true } }] };
  const own = { ...offer, restrictions: exceptions };
  const child = { ...own, id: "nr", price: { kind: "linked" as const, parentId: "flex", adjustment: { kind: "percentage" as const, basisPoints: -1000 }, dateOverrides: [] } };
  const original = { ...room, offers: [own, child] };
  const input = { minimum: "3", maximum: "10", closedToArrival: true, closedToDeparture: true, stopSell: true };
  const changed = changeStayRules(original, "nr", input);
  expect(changed).toEqual({ ...original, offers: [own, { ...child, restrictions: { ...exceptions, rules: { minArrivalNights: 3, maxStayNights: 10, closedToArrival: true, closedToDeparture: true, stopSell: true } } }] });
  expect(changeStayRules(original, "flex", { ...input, maximum: "" }).offers[0].restrictions).toMatchObject({ rules: { maxStayNights: null } });
  for (const minimum of ["", "0", "-1", "1.5", "1e2", "9007199254740992"]) expect(() => changeStayRules(original, "flex", { ...input, minimum })).toThrow();
  for (const maximum of ["0", "2", "1.5", " ", "9007199254740992"]) expect(() => changeStayRules(original, "flex", { ...input, maximum })).toThrow();
  expect(() => changeStayRules({ ...original, offers: [own, { ...child, restrictions: { kind: "inherit" } }] }, "nr", input)).toThrow(/inherits/);
  expect(original.offers[0].restrictions).toEqual(exceptions);
});

it("prefills and cancels stay-rule edits, preserves pending calendar entries and requires saved review", async () => {
  await mount(); await click("Save draft"); await click("Edit stay rules");
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) => act(async () => field(name).props.onChange({ target: { value } }));
  expect(field("Minimum nights for Room 1 Offer 1").props.value).toBe("1");
  expect(field("Maximum nights (blank means unlimited) for Room 1 Offer 1").props.value).toBe("");
  expect(field("Stop sales for Room 1 Offer 1").props.checked).toBe(false);
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true);
  const listener = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true }); listener(unload); expect(unload.defaultPrevented).toBe(true);
  await fill("Minimum nights for Room 1 Offer 1", "5"); await fill("Month for Room 1 Offer 1", "8");
  await click("Cancel stay-rule edit"); expect(button("Save draft").props.disabled).toBe(true);
  await click("Cancel month entry"); await click("Edit stay rules"); expect(field("Minimum nights for Room 1 Offer 1").props.value).toBe("1");
  await fill("Month for Room 1 Offer 1", "8"); await click("Cancel month entry"); expect(button("Save draft").props.disabled).toBe(true);
  await fill("Minimum nights for Room 1 Offer 1", "3"); await fill("Maximum nights (blank means unlimited) for Room 1 Offer 1", "2");
  await click("Apply stay rules"); expect(JSON.stringify(view.toJSON())).toContain("at least as large");
  await fill("Maximum nights (blank means unlimited) for Room 1 Offer 1", "10");
  await act(async () => field("Stop sales for Room 1 Offer 1").props.onChange({ target: { checked: true } }));
  await click("Apply stay rules"); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); await click("Review saved charges");
  expect(saved.snapshot.rooms[0].offers[0].restrictions).toMatchObject({ rules: { minArrivalNights: 3, maxStayNights: 10, stopSell: true } });
  expect(button("Edit stay rules").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
});

it("adds and selectively clears date stay rules without changing defaults or prices", () => {
  const room = snapshot.rooms[0], offer = room.offers[0]; if (offer.restrictions.kind !== "own") throw new Error();
  const input = { minimum: "5", maximum: "10", closedToArrival: true, closedToDeparture: false, stopSell: true };
  const original = { ...room, offers: [{ ...offer, restrictions: { ...offer.restrictions, seasons: [{ from: "12-01", through: "12-31", rules: { ...offer.restrictions.rules, minArrivalNights: 3 } }] } }] };
  const first = changeStayDate(original, "flex", "2028-02-29", input);
  const second = changeStayDate(first, "flex", "2026-12-25", { ...input, maximum: "" });
  expect(second.offers[0].restrictions).toMatchObject({ dates: [{ date: "2028-02-29", rules: { minArrivalNights: 5, maxStayNights: 10, closedToArrival: true, stopSell: true } }, { date: "2026-12-25", rules: { maxStayNights: null } }] });
  expect(changeStayDate(second, "flex", "2026-12-25", null)).toEqual(first);
  expect(changeStayDate(first, "flex", "2028-02-29", null)).toEqual(original);
  for (const date of ["", "2026-12-", "2026-02-29", "2026-13-01"]) expect(() => changeStayDate(original, "flex", date, input)).toThrow();
  expect(() => changeStayDate(first, "flex", "2028-02-29", input)).toThrow(/Clear/);
  expect(() => changeStayDate(original, "flex", "2026-12-25", null)).toThrow();
  expect(() => changeStayDate(original, "flex", "2026-12-25", { ...input, maximum: "4" })).toThrow();
  const linked = { ...offer, id: "nr", price: { kind: "linked" as const, parentId: "flex", adjustment: { kind: "fixed" as const, deltaMinor: "0" }, dateOverrides: [] } };
  expect(changeStayDate({ ...room, offers: [offer, linked] }, "nr", "2026-12-25", input).offers[1].restrictions).toMatchObject({ dates: [{ date: "2026-12-25" }] });
  expect(() => changeStayDate({ ...room, offers: [offer, { ...linked, restrictions: { kind: "inherit" } }] }, "nr", "2026-12-25", input)).toThrow(/owns/);
});

it("protects unfinished date stay rules, prefills defaults and reviews the saved exception", async () => {
  await mount(); await click("Save draft"); await click("Add date stay rules");
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) => act(async () => field(name).props.onChange({ target: { value } }));
  expect(field("Minimum nights for date rule Room 1 Offer 1").props.value).toBe("1");
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true);
  const listener = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true }); listener(unload); expect(unload.defaultPrevented).toBe(true);
  await fill("Month for Room 1 Offer 1", "8"); await click("Cancel date stay rules"); expect(button("Save draft").props.disabled).toBe(true);
  await click("Add date stay rules"); await click("Cancel month entry"); expect(button("Save draft").props.disabled).toBe(true);
  await fill("Stay-rule date for Room 1 Offer 1", "2026-02-29"); await click("Apply date stay rules");
  expect(JSON.stringify(view.toJSON())).toContain("valid YYYY-MM-DD");
  await fill("Stay-rule date for Room 1 Offer 1", "2026-12-25"); await fill("Minimum nights for date rule Room 1 Offer 1", "5");
  await act(async () => field("Close arrivals for date rule Room 1 Offer 1").props.onChange({ target: { checked: true } }));
  await click("Apply date stay rules"); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); await click("Review saved charges");
  expect(saved.snapshot.rooms[0].offers[0].restrictions).toMatchObject({ rules: { minArrivalNights: 1 }, dates: [{ date: "2026-12-25", rules: { minArrivalNights: 5, closedToArrival: true } }] });
  expect(button("Clear date stay rules").props.disabled).toBe(true); expect(button("Add date stay rules").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
  await click("Back to editing"); await click("Clear date stay rules"); await click("Save draft");
  expect(saved.snapshot.rooms[0]).toEqual({ ...snapshot.rooms[0], revision: 2 });
});

it("validates seasonal stay ranges and clears only the selected exception", () => {
  const input = { minimum: "5", maximum: "10", closedToArrival: false, closedToDeparture: true, stopSell: false };
  const original = changeStayDate(snapshot.rooms[0], "flex", "2026-12-25", { ...input, minimum: "7" });
  const winter = changeStaySeason(original, "flex", "12-15", "01-10", input);
  const leap = changeStaySeason(winter, "flex", "02-29", "02-29", { ...input, maximum: "" });
  expect(winter.offers[0].restrictions).toMatchObject({ rules: { minArrivalNights: 1 }, seasons: [{ from: "12-15", through: "01-10", rules: { minArrivalNights: 5, maxStayNights: 10, closedToDeparture: true } }], dates: [{ date: "2026-12-25", rules: { minArrivalNights: 7 } }] });
  expect(changeStaySeason(leap, "flex", "02-29", "02-29", null)).toEqual(winter);
  expect(changeStaySeason(winter, "flex", "12-15", "01-10", null)).toEqual(original);
  for (const [from, through] of [["12-15", "01-10"], ["01-10", "02-01"], ["12-01", "12-15"], ["02-28", "03-01"], ["02-30", "03-01"], ["", "01-01"], ["1-01", "01-02"]]) expect(() => changeStaySeason(leap, "flex", from, through, input)).toThrow();
  expect(() => changeStaySeason(original, "flex", "06-01", "06-30", { ...input, minimum: "0" })).toThrow();
  expect(() => changeStaySeason(original, "flex", "06-01", "06-30", { ...input, maximum: "4" })).toThrow();
  expect(() => changeStaySeason(original, "flex", "06-01", "06-30", null)).toThrow();
  const offer = original.offers[0], linked = { ...offer, id: "nr", price: { kind: "linked" as const, parentId: "flex", adjustment: { kind: "fixed" as const, deltaMinor: "0" }, dateOverrides: [] } };
  expect(changeStaySeason({ ...original, offers: [offer, linked] }, "nr", "06-01", "06-30", input).offers[1].restrictions).toMatchObject({ seasons: [{ from: "06-01" }] });
  expect(() => changeStaySeason({ ...original, offers: [offer, { ...linked, restrictions: { kind: "inherit" } }] }, "nr", "06-01", "06-30", input)).toThrow(/owns/);
});

it("protects seasonal stay entries separately and reviews then clears the saved rule", async () => {
  await mount(); await click("Save draft"); await click("Add seasonal stay rules");
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) => act(async () => field(name).props.onChange({ target: { value } }));
  expect(field("Minimum nights for season rule Room 1 Offer 1").props.value).toBe("1");
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true);
  const listener = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true }); listener(unload); expect(unload.defaultPrevented).toBe(true);
  await click("Add date stay rules"); await click("Cancel seasonal stay rules"); expect(button("Save draft").props.disabled).toBe(true);
  await click("Add seasonal stay rules"); await click("Cancel date stay rules"); expect(button("Save draft").props.disabled).toBe(true);
  await fill("Stay-rule Start (MM-DD) for Room 1 Offer 1", "12-"); await click("Apply seasonal stay rules"); expect(JSON.stringify(view.toJSON())).toContain("valid MM-DD");
  await fill("Stay-rule Start (MM-DD) for Room 1 Offer 1", "12-15"); await fill("Stay-rule End (MM-DD) for Room 1 Offer 1", "01-10");
  await fill("Minimum nights for season rule Room 1 Offer 1", "5"); await click("Apply seasonal stay rules"); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); await click("Review saved charges");
  expect(saved.snapshot.rooms[0].offers[0].restrictions).toMatchObject({ seasons: [{ from: "12-15", through: "01-10", rules: { minArrivalNights: 5 } }] });
  expect(button("Clear seasonal stay rules").props.disabled).toBe(true); expect(button("Add seasonal stay rules").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
  await click("Back to editing"); await click("Clear seasonal stay rules"); await click("Save draft"); expect(saved.snapshot.rooms[0]).toEqual({ ...snapshot.rooms[0], revision: 2 });
});

it("copies the nearest rule owner through linked chains without altering other settings", () => {
  const room = structuredClone(snapshot.rooms[0]), root = room.offers[0];
  if (root.restrictions.kind !== "own") throw new Error("fixture");
  const policy = { ...root.restrictions, dates: [{ date: "2026-12-25", rules: { ...root.restrictions.rules, minArrivalNights: 5 } }], seasons: [{ from: "12-01", through: "12-31", rules: root.restrictions.rules }] };
  const linked = { ...root, id: "child", price: { kind: "linked" as const, parentId: root.id, adjustment: { kind: "percentage" as const, basisPoints: -1000 }, dateOverrides: [] }, restrictions: policy };
  const leaf = { ...linked, id: "leaf", price: { ...linked.price, parentId: "middle" }, restrictions: { kind: "inherit" as const } };
  const chain = { ...room, offers: [root, linked, { ...linked, id: "middle", price: { ...linked.price, parentId: "child" }, restrictions: { kind: "inherit" as const } }, leaf] };
  const changed = changeStayOwnership(chain, "leaf");
  expect(changed.offers[3]).toEqual({ ...leaf, restrictions: policy });
  expect(changed.offers.slice(0, 3)).toEqual(chain.offers.slice(0, 3));
  expect(changed.children).toEqual(chain.children);
  expect(changed.offers[3].restrictions).not.toBe(policy);
  expect(chain.offers[3].restrictions).toEqual({ kind: "inherit" });
  expect(changeStayOwnership(changed, "leaf").offers[3]).toEqual(leaf);
  expect(() => changeStayOwnership(chain, root.id)).toThrow("Independent");
  expect(() => changeStayOwnership(chain, "missing")).toThrow("missing");
  expect(() => changeStayOwnership({ ...chain, offers: [...chain.offers.slice(0, 3), { ...leaf, price: { ...leaf.price, parentId: "leaf" } }] }, "leaf")).toThrow("invalid");
});
it("guards ownership confirmation, cancels without mutation, and saves the acknowledged copy for review", async () => {
  const room = snapshot.rooms[0], root = room.offers[0];
  client.read.mockResolvedValueOnce({ ...snapshot, revision: 1, sources, stale: false, rooms: [{ ...room, offers: [root, { ...root, id: "linked", price: { kind: "linked", parentId: root.id, adjustment: { kind: "percentage", basisPoints: -1000 }, dateOverrides: [] }, restrictions: { kind: "inherit" } }] }] });
  await mount(); await click("Save draft"); await click("Edit stay rules");
  expect(button("Use own stay rules").props.disabled).toBe(true);
  await click("Use own stay rules"); expect(button("Apply stay-rule ownership")).toBeUndefined();
  await click("Cancel stay-rule edit"); await click("Use own stay rules");
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true);
  expect(input().props.disabled).toBe(true); expect(button("Edit stay rules").props.disabled).toBe(true);
  expect(button("Apply stay-rule ownership").props.disabled).toBe(true);
  await click("Apply stay-rule ownership"); expect(button("Cancel ownership change")).toBeDefined();
  const warn = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined }; warn(event); expect(event.preventDefault).toHaveBeenCalled();
  await click("Cancel ownership change"); expect(button("Review saved charges").props.disabled).toBe(false);
  await click("Use own stay rules"); expect(view.root.findByProps({ type: "checkbox" }).props.checked).toBe(false);
  await act(async () => view.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }));
  await click("Apply stay-rule ownership"); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); expect(saved.snapshot.rooms[0].offers[1].restrictions).toEqual(root.restrictions);
  await click("Review saved charges"); expect(button("Use parent stay rules").props.disabled).toBe(true);
  expect(button("Approve rates").props.disabled).toBe(true);
});

it("changes only the linked adjustment with exact signed currency and percentage values", () => {
  const room = snapshot.rooms[0], root = room.offers[0];
  const linked = { ...root, id: "linked", price: { kind: "linked" as const, parentId: root.id, adjustment: { kind: "percentage" as const, basisPoints: -1000 }, dateOverrides: [{ date: "2026-12-25", price: { mode: "flat" as const, amountMinor: "15000" } }] } };
  const original = { ...room, offers: [root, linked] };
  for (const [kind, value, expected] of [["fixed", "-90071992547409.93", { kind: "fixed", deltaMinor: "-9007199254740993" }], ["percentage", "-10.25", { kind: "percentage", basisPoints: -1025 }], ["fixed", "+20.00", { kind: "fixed", deltaMinor: "2000" }], ["percentage", "-0", { kind: "percentage", basisPoints: 0 }]] as const) {
    expect(changeLinkedAdjustment(original, linked.id, { kind, value })).toEqual({ ...original, offers: [root, { ...linked, price: { ...linked.price, adjustment: expected } }] });
  }
  for (const value of ["", "1e2", " 10", "NaN", "1.001", "--2", "900719925474099.99", "-100.01"]) expect(() => changeLinkedAdjustment(original, linked.id, { kind: "percentage", value })).toThrow();
  expect(() => changeLinkedAdjustment(original, root.id, { kind: "fixed", value: "1" })).toThrow("linked");
  expect(() => changeLinkedAdjustment(original, linked.id, { kind: "other", value: "1" })).toThrow();
  expect(() => changeLinkedAdjustment({ ...original, currency: "JPY" }, linked.id, { kind: "fixed", value: "1.2" })).toThrow();
  expect(changeLinkedAdjustment({ ...original, currency: "KWD" }, linked.id, { kind: "fixed", value: "-1.234" }).offers[1].price).toMatchObject({ adjustment: { deltaMinor: "-1234" } });
  expect(original.offers[1]).toEqual(linked);
});
it("protects pending linked edits and reviews only the saved adjustment", async () => {
  const room = snapshot.rooms[0], root = room.offers[0];
  client.read.mockResolvedValueOnce({ ...snapshot, revision: 1, sources, stale: false, rooms: [{ ...room, offers: [root, { ...root, id: "linked", price: { kind: "linked", parentId: root.id, adjustment: { kind: "percentage", basisPoints: -1000 }, dateOverrides: [] }, restrictions: { kind: "inherit" } }] }] });
  await mount(); await click("Save draft"); await click("Edit linked adjustment");
  const field = () => view.root.findByProps({ "aria-label": "Linked adjustment for Room 1 Offer 2" });
  expect(field().props.value).toBe("-10.00"); expect(button("Save draft").props.disabled).toBe(true); expect(button("Use own stay rules").props.disabled).toBe(true);
  const warn = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined }; warn(event); expect(event.preventDefault).toHaveBeenCalled();
  await act(async () => view.root.findByProps({ "aria-label": "Linked adjustment type for Room 1 Offer 2" }).props.onChange({ target: { value: "fixed" } }));
  expect(field().props.value).toBe(""); await click("Apply linked adjustment"); expect(JSON.stringify(view.toJSON())).toContain("valid signed amount");
  await click("Cancel linked adjustment"); expect(button("Review saved charges").props.disabled).toBe(false);
  await click("Use own stay rules"); expect(button("Edit linked adjustment").props.disabled).toBe(true); await click("Cancel ownership change");
  await click("Edit linked adjustment"); expect(field().props.value).toBe("-10.00");
  await act(async () => field().props.onChange({ target: { value: "-15.25" } })); await click("Apply linked adjustment");
  expect(button("Review saved charges").props.disabled).toBe(true); await click("Save draft");
  expect(saved.snapshot.rooms[0].offers[1].price).toMatchObject({ adjustment: { kind: "percentage", basisPoints: -1525 } });
  await click("Review saved charges"); expect(button("Edit linked adjustment").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
});

it("changes every existing child charge exactly while preserving bands and all offers", () => {
  const original = snapshot.rooms[0], root = original.offers[0];
  const room = { ...original, children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 2, nightlyMinor: "0", countsTowardCapacity: false }, { fromAge: 3, throughAge: 11, nightlyMinor: "2500", countsTowardCapacity: true }] }, offers: [
    { ...root, meal: { kind: "breakfast" as const, charge: { kind: "person" as const, adultMinor: "1200", childBandAmountsMinor: ["0", "600"] } } },
    { ...root, id: "linked", price: { kind: "linked" as const, parentId: root.id, adjustment: { kind: "percentage" as const, basisPoints: -1000 }, dateOverrides: [] }, meal: { kind: "room_only" as const, charge: { kind: "room" as const, amountMinor: "0" } } },
  ] };
  expect(changeChildCharges(room, ["0", "90071992547409.93"])).toEqual({ ...room, children: { ...room.children, bands: [room.children.bands[0], { ...room.children.bands[1], nightlyMinor: "9007199254740993" }] } });
  expect(room.children.bands[1].nightlyMinor).toBe("2500");
  for (const amounts of [[], ["0"], ["0", "1", "2"], ["0", ""], ["0", "-1"], ["0", "1e2"], ["0", "1.001"], ["0", "10000000000000000"]]) expect(() => changeChildCharges(room, amounts)).toThrow();
  expect(() => changeChildCharges({ ...room, currency: "JPY" }, ["0", "1.2"])).toThrow();
  expect(changeChildCharges({ ...room, currency: "KWD" }, ["0", "1.234"]).children.bands[1].nightlyMinor).toBe("1234");
  expect(() => changeChildCharges({ ...room, children: { ...room.children, adultFromAge: 18 } }, ["0", "1"])).toThrow("invalid");
});
it("protects child charge edits and saves the changed room-wide charge for review", async () => {
  const room = snapshot.rooms[0], root = room.offers[0];
  client.read.mockResolvedValueOnce({ ...snapshot, revision: 1, sources, stale: false, rooms: [{ ...room, offers: [root, { ...root, id: "linked", price: { kind: "linked", parentId: root.id, adjustment: { kind: "percentage", basisPoints: -1000 }, dateOverrides: [] }, restrictions: { kind: "inherit" } }] }] });
  await mount(); await click("Save draft"); await click("Edit child charges");
  const field = () => view.root.findByProps({ "aria-label": "Child charge ages 0–11 for Room 1" });
  expect(field().props.value).toBe("25.00"); expect(button("Save draft").props.disabled).toBe(true); expect(button("Use own stay rules").props.disabled).toBe(true);
  const warn = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined }; warn(event); expect(event.preventDefault).toHaveBeenCalled();
  await act(async () => field().props.onChange({ target: { value: "-1" } })); await click("Apply child charges"); expect(client.prepare).toHaveBeenCalledTimes(1);
  await click("Cancel child charges"); expect(button("Review saved charges").props.disabled).toBe(false);
  await click("Use own stay rules"); expect(button("Edit child charges").props.disabled).toBe(true); await click("Cancel ownership change");
  await click("Edit child charges"); expect(field().props.value).toBe("25.00");
  await act(async () => field().props.onChange({ target: { value: "0" } })); await click("Apply child charges");
  expect(button("Review saved charges").props.disabled).toBe(true); await click("Save draft");
  expect(saved.snapshot.rooms[0].children.bands[0].nightlyMinor).toBe("0"); expect(saved.snapshot.rooms[0].offers[0]).toEqual(root);
  await click("Review saved charges"); expect(button("Edit child charges").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
});

it("edits both meal charging models exactly without altering linked prices or child supplements", () => {
  const room = snapshot.rooms[0], root = room.offers[0];
  const linked = { ...root, id: "linked", price: { kind: "linked" as const, parentId: root.id, adjustment: { kind: "percentage" as const, basisPoints: -1000 }, dateOverrides: [{ date: "2026-12-25", price: { mode: "flat" as const, amountMinor: "15000" } }] } };
  const original = { ...room, offers: [root, linked] };
  expect(changeMealCharges(original, linked.id, ["90071992547409.93", "0"])).toEqual({ ...original, offers: [root, { ...linked, meal: { ...linked.meal, charge: { kind: "person", adultMinor: "9007199254740993", childBandAmountsMinor: ["0"] } } }] });
  const perRoom = { ...original, offers: [root, { ...linked, meal: { kind: "half_board" as const, charge: { kind: "room" as const, amountMinor: "2000" } } }] };
  expect(changeMealCharges(perRoom, linked.id, ["0"]).offers[1].meal).toEqual({ kind: "half_board", charge: { kind: "room", amountMinor: "0" } });
  for (const amounts of [[], ["1"], ["1", "2", "3"], ["-1", "0"], ["1.001", "0"], ["1e2", "0"], ["", "0"], ["10000000000000000", "0"]]) expect(() => changeMealCharges(original, linked.id, amounts)).toThrow();
  expect(() => changeMealCharges(perRoom, linked.id, ["1", "2"])).toThrow();
  expect(() => changeMealCharges(original, "missing", ["1", "0"])).toThrow();
  expect(() => changeMealCharges({ ...original, currency: "JPY" }, linked.id, ["1.2", "0"])).toThrow();
  expect(changeMealCharges({ ...original, currency: "KWD" }, linked.id, ["1.234", "0"]).offers[1].meal.charge).toMatchObject({ adultMinor: "1234" });
  expect(() => changeMealCharges({ ...room, offers: [{ ...root, meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } } }] }, root.id, ["1"])).toThrow();
  const bands = [{ fromAge: 0, throughAge: 2, nightlyMinor: "0", countsTowardCapacity: false }, { fromAge: 3, throughAge: 11, nightlyMinor: "2500", countsTowardCapacity: true }];
  const multiple = { ...room, children: { ...room.children, bands }, offers: [{ ...root, meal: { ...root.meal, charge: { kind: "person" as const, adultMinor: "1200", childBandAmountsMinor: ["0", "600"] } } }] };
  expect(changeMealCharges(multiple, root.id, ["15", "0", "7.50"]).offers[0].meal.charge).toEqual({ kind: "person", adultMinor: "1500", childBandAmountsMinor: ["0", "750"] });
  expect(original.offers[1]).toEqual(linked);
});
it("guards meal edits, cancels safely and reviews saved adult and child meal amounts", async () => {
  const room = snapshot.rooms[0], root = room.offers[0];
  client.read.mockResolvedValueOnce({ ...snapshot, revision: 1, sources, stale: false, rooms: [{ ...room, offers: [root, { ...root, id: "linked", price: { kind: "linked", parentId: root.id, adjustment: { kind: "percentage", basisPoints: -1000 }, dateOverrides: [] }, meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } }, restrictions: { kind: "inherit" } }] }] });
  await mount(); await click("Save draft"); await click("Edit meal charges");
  const adult = () => view.root.findByProps({ "aria-label": "Meal charge Per adult for Room 1 Offer 1" });
  const child = () => view.root.findByProps({ "aria-label": "Meal charge Per child ages 0–11 for Room 1 Offer 1" });
  expect(adult().props.value).toBe("12.00"); expect(child().props.value).toBe("6.00"); expect(button("Save draft").props.disabled).toBe(true); expect(button("Use own stay rules").props.disabled).toBe(true);
  const warn = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined }; warn(event); expect(event.preventDefault).toHaveBeenCalled();
  await act(async () => child().props.onChange({ target: { value: "-1" } })); await click("Apply meal charges"); expect(client.prepare).toHaveBeenCalledTimes(1);
  await click("Cancel meal charges"); expect(button("Review saved charges").props.disabled).toBe(false);
  await click("Use own stay rules"); expect(button("Edit meal charges").props.disabled).toBe(true); await click("Cancel ownership change");
  await click("Edit meal charges"); expect(child().props.value).toBe("6.00");
  await act(async () => { adult().props.onChange({ target: { value: "15.25" } }); });
  await act(async () => child().props.onChange({ target: { value: "0" } })); await click("Apply meal charges");
  expect(button("Review saved charges").props.disabled).toBe(true); await click("Save draft");
  expect(saved.snapshot.rooms[0].offers[0].meal.charge).toEqual({ kind: "person", adultMinor: "1525", childBandAmountsMinor: ["0"] });
  expect(saved.snapshot.rooms[0].children).toEqual(room.children);
  await click("Review saved charges"); expect(button("Edit meal charges").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
});

it("changes meal type and basis while preserving all other settings and canonical room-only zero", () => {
  const room = snapshot.rooms[0], root = room.offers[0];
  const linked = { ...root, id: "linked", price: { kind: "linked" as const, parentId: root.id, adjustment: { kind: "percentage" as const, basisPoints: -1000 }, dateOverrides: [] }, restrictions: { kind: "inherit" as const } };
  const original = { ...room, offers: [root, linked] };
  for (const kind of ["breakfast", "half_board", "full_board", "all_inclusive"]) {
    for (const basis of ["room", "person"]) {
      const charge = basis === "room" ? { kind: "room", amountMinor: "1234" } : { kind: "person", adultMinor: "1234", childBandAmountsMinor: ["0"] };
      expect(changeMealPlan(original, linked.id, { kind, basis, amounts: basis === "room" ? ["12.34"] : ["12.34", "0"] })).toEqual({ ...original, offers: [root, { ...linked, meal: { kind, charge } }] });
    }
  }
  expect(changeMealPlan(original, linked.id, { kind: "room_only", basis: "room", amounts: [] }).offers[1].meal).toEqual({ kind: "room_only", charge: { kind: "room", amountMinor: "0" } });
  for (const entry of [{ kind: "other", basis: "room", amounts: ["0"] }, { kind: "breakfast", basis: "unknown", amounts: ["0"] }, { kind: "room_only", basis: "person", amounts: [] }, { kind: "room_only", basis: "room", amounts: ["10"] }, { kind: "breakfast", basis: "person", amounts: ["1"] }, { kind: "breakfast", basis: "room", amounts: ["-1"] }, { kind: "breakfast", basis: "room", amounts: ["1.001"] }]) expect(() => changeMealPlan(original, linked.id, entry)).toThrow();
  expect(() => changeMealPlan(original, "missing", { kind: "room_only", basis: "room", amounts: [] })).toThrow();
  expect(changeMealPlan({ ...original, currency: "KWD" }, linked.id, { kind: "breakfast", basis: "room", amounts: ["1.234"] }).offers[1].meal.charge).toEqual({ kind: "room", amountMinor: "1234" });
});
it("requires fresh meal-plan confirmation, blocks competing edits, and reviews the saved plan", async () => {
  await mount(); await click("Save draft"); await click("Edit meal charges");
  expect(button("Change meal plan").props.disabled).toBe(true); await click("Change meal plan"); expect(button("Apply meal plan")).toBeUndefined();
  await click("Cancel meal charges"); await click("Change meal plan");
  const checkbox = () => view.root.findByProps({ type: "checkbox" });
  const plan = () => view.root.findByProps({ "aria-label": "Meal plan for Room 1 Offer 1" });
  const amount = () => view.root.findByProps({ "aria-label": "New meal charge Per room for Room 1 Offer 1" });
  expect(checkbox().props.checked).toBe(false); expect(button("Apply meal plan").props.disabled).toBe(true);
  expect(button("Edit meal charges").props.disabled).toBe(true); expect(button("Edit child charges").props.disabled).toBe(true); expect(input().props.disabled).toBe(true);
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true);
  const warn = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined }; warn(event); expect(event.preventDefault).toHaveBeenCalled();
  expect(view.root.findByProps({ "aria-label": "New meal charge Per adult for Room 1 Offer 1" }).props.value).toBe("12.00");
  await click("Cancel meal plan"); expect(button("Review saved charges").props.disabled).toBe(false);
  await click("Change meal plan"); await act(async () => checkbox().props.onChange({ target: { checked: true } }));
  await act(async () => plan().props.onChange({ target: { value: "half_board" } })); expect(checkbox().props.checked).toBe(false);
  expect(view.root.findByProps({ "aria-label": "New meal charge Per adult for Room 1 Offer 1" }).props.value).toBe("");
  await act(async () => view.root.findByProps({ "aria-label": "Meal charging basis for Room 1 Offer 1" }).props.onChange({ target: { value: "room" } }));
  expect(amount().props.value).toBe(""); await act(async () => checkbox().props.onChange({ target: { checked: true } })); await click("Apply meal plan"); expect(client.prepare).toHaveBeenCalledTimes(1);
  await act(async () => amount().props.onChange({ target: { value: "20" } })); expect(checkbox().props.checked).toBe(false);
  await act(async () => checkbox().props.onChange({ target: { checked: true } })); await click("Apply meal plan");
  expect(button("Review saved charges").props.disabled).toBe(true); await click("Save draft");
  expect(saved.snapshot.rooms[0].offers[0].meal).toEqual({ kind: "half_board", charge: { kind: "room", amountMinor: "2000" } });
  await click("Review saved charges"); expect(button("Change meal plan").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
  await click("Back to editing"); await click("Change meal plan"); await act(async () => plan().props.onChange({ target: { value: "room_only" } }));
  expect(view.root.findAllByType("input").filter((node) => String(node.props["aria-label"]).startsWith("New meal charge"))).toHaveLength(0);
  await act(async () => checkbox().props.onChange({ target: { checked: true } })); await click("Apply meal plan"); await click("Save draft");
  expect(saved.snapshot.rooms[0].offers[0].meal).toEqual({ kind: "room_only", charge: { kind: "room", amountMinor: "0" } });
});

it("rejects cyclic parent choices and preserves every field except the linked parent", () => {
  const room = snapshot.rooms[0], root = room.offers[0];
  const linked = { ...root, id: "linked", price: { kind: "linked" as const, parentId: root.id, adjustment: { kind: "percentage" as const, basisPoints: -1000 }, dateOverrides: [{ date: "2026-12-25", price: { mode: "flat" as const, amountMinor: "15000" } }] }, restrictions: { kind: "inherit" as const } };
  const middle = { ...linked, id: "middle", price: { ...linked.price, parentId: linked.id } };
  const leaf = { ...linked, id: "leaf", price: { ...linked.price, parentId: middle.id } };
  const alternate = { ...root, id: "alternate" };
  const original = { ...room, offers: [root, linked, middle, leaf, alternate] };
  expect(linkedParentChoices(original, linked.id).map((value) => value.id)).toEqual([root.id, alternate.id]);
  expect(changeLinkedParent(original, linked.id, alternate.id)).toEqual({ ...original, offers: [root, { ...linked, price: { ...linked.price, parentId: alternate.id } }, middle, leaf, alternate] });
  for (const id of [linked.id, middle.id, leaf.id, "outside"]) expect(() => changeLinkedParent(original, linked.id, id)).toThrow("circular");
  expect(() => changeLinkedParent(original, root.id, alternate.id)).toThrow("linked");
  const own = { ...original, offers: original.offers.map((offer) => offer.id === linked.id ? { ...offer, restrictions: root.restrictions } : offer) };
  expect(changeLinkedParent(own, linked.id, alternate.id).offers[1].restrictions).toEqual(root.restrictions);
  expect(linkedParentChoices({ ...room, offers: [root, linked] }, linked.id)).toEqual([root]);
});
it("confirms parent changes with exclusive pending guards and fresh saved review", async () => {
  const room = snapshot.rooms[0], root = room.offers[0];
  const linked = { ...root, id: "linked", price: { kind: "linked", parentId: root.id, adjustment: { kind: "percentage", basisPoints: -1000 }, dateOverrides: [] }, restrictions: { kind: "inherit" } };
  client.read.mockResolvedValueOnce({ ...snapshot, revision: 1, sources, stale: false, rooms: [{ ...room, offers: [root, linked, { ...root, id: "alternate" }] }] });
  await mount(); await click("Save draft"); await click("Edit child charges"); expect(button("Change parent rate").props.disabled).toBe(true);
  await click("Change parent rate"); expect(button("Apply parent rate")).toBeUndefined(); await click("Cancel child charges");
  await click("Change parent rate"); const checkbox = () => view.root.findByProps({ type: "checkbox" });
  const parent = () => view.root.findByProps({ "aria-label": "Parent rate for Room 1 Offer 2" });
  expect(parent().props.value).toBe(root.id); expect(checkbox().props.checked).toBe(false);
  expect(button("Edit linked adjustment").props.disabled).toBe(true); expect(button("Use own stay rules").props.disabled).toBe(true); expect(button("Change meal plan").props.disabled).toBe(true);
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true); expect(input().props.disabled).toBe(true);
  const warn = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined }; warn(event); expect(event.preventDefault).toHaveBeenCalled();
  await act(async () => checkbox().props.onChange({ target: { checked: true } })); expect(button("Apply parent rate").props.disabled).toBe(true);
  await act(async () => parent().props.onChange({ target: { value: "alternate" } })); expect(checkbox().props.checked).toBe(false);
  await click("Cancel parent rate"); expect(button("Review saved charges").props.disabled).toBe(false);
  await click("Change parent rate"); expect(parent().props.value).toBe(root.id);
  await act(async () => parent().props.onChange({ target: { value: "alternate" } })); await act(async () => checkbox().props.onChange({ target: { checked: true } }));
  await click("Apply parent rate"); expect(button("Review saved charges").props.disabled).toBe(true); await click("Save draft");
  expect(saved.snapshot.rooms[0].offers[1].price).toMatchObject({ parentId: "alternate" }); expect(saved.snapshot.rooms[0].offers[1].restrictions).toEqual({ kind: "inherit" });
  await click("Review saved charges"); expect(button("Change parent rate").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
});

it("appends another room at the existing revision, preserving edits and retrying accepted terms once", async () => {
  const id = "61000000-0000-4000-8000-000000000004", room = { roomTypeId: id, name: "Family", capacity: { total: 3, adults: 3, children: 2 } };
  client.read.mockResolvedValueOnce({ ...snapshot, revision: 7, sources, stale: false });
  const policy = vi.fn().mockResolvedValue({ revision: id }); client.termsAction.mockReturnValue(policy);
  await act(async () => { view = create(<PricingEditor client={client as ReturnType<typeof createReplacementPricingClient>} setup={{ propertyId: "property", rooms: [{ roomTypeId: "room", name: "Existing", capacity: snapshot.rooms[0].capacity }, room] }} />); });
  await click("Save draft"); const prior = saved;
  await act(async () => input().props.onChange({ target: { value: "155.25" } }));
  await click("Add another room");
  expect(view.root.findByType(FirstPricingSetup).props.rooms).toEqual([room]);
  expect(view.root.findByProps({ "aria-label": "Currency code (for example EUR)" }).props.disabled).toBe(true);
  expect(view.root.findByProps({ "aria-label": "Currency code (for example EUR)" }).props.value).toBe("EUR");
  expect(view.root.findByProps({ "aria-label": "Room 1 Offer 1 Per room" }).props.disabled).toBe(true);
  const next = firstPricingInput("property", room, id, { mode: "occupancy", occupancy: ["100", "130", "155"], included: { adults: "", adjustments: [] }, room: id, currency: "EUR", base: "", adultAge: "12", childPrice: "0", countChildren: "yes", minimum: "1", maximum: "", cancellation: "non_refundable", freeDays: "", payment: "full" });
  client.prepare.mockRejectedValueOnce(new ApiErrorResponse(403, {}));
  await act(async () => view.root.findByType(FirstPricingSetup).props.onCreate(next));
  expect(button("Cancel room setup").props.disabled).toBe(true); expect(view.root.findByType(FirstPricingSetup).props.disabled).toBe(true);
  const attempted = client.prepare.mock.calls.at(-1)![0];
  await click("Retry last action"); expect(policy).toHaveBeenCalledOnce(); expect(client.termsAction).toHaveBeenCalledOnce(); expect(client.prepare.mock.calls.at(-1)![0]).toEqual(attempted);
  expect(client.saveDraft).toHaveBeenCalledTimes(1); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); expect(saved.draftId).toBe(prior.draftId); expect(saved.revision).toBe(prior.revision + 1); expect(saved.baseRevision).toBe(7);
  expect(saved.snapshot.rooms).toHaveLength(2); expect(saved.snapshot.rooms.map((value) => value.revision)).toEqual([8, 8]);
  expect(saved.snapshot.rooms[0]).toEqual(editedSnapshot({ ...snapshot, rooms: [{ ...snapshot.rooms[0], revision: 8 }] }, { "0:0:0": "155.25" }).rooms[0]);
  expect(saved.snapshot.rooms[1].offers[0]).toMatchObject({ termsRevision: id, price: { calendar: { base: { amountsMinor: ["10000", "13000", "15500"] } } } });
  expect(button("Add another room")).toBeUndefined(); await click("Review saved charges"); expect(button("Approve rates").props.disabled).toBe(true);
});
it("cancels room setup without changing the draft and rejects duplicate rooms or currency before policy writes", async () => {
  const id = "61000000-0000-4000-8000-000000000004", room = { roomTypeId: id, name: "Family", capacity: { total: 3, adults: 3, children: 2 } };
  await act(async () => { view = create(<PricingEditor client={client as ReturnType<typeof createReplacementPricingClient>} setup={{ propertyId: "property", rooms: [room] }} />); });
  await click("Save draft"); await click("Edit child charges"); expect(button("Add another room").props.disabled).toBe(true);
  await click("Add another room"); expect(button("Cancel room setup")).toBeUndefined(); await click("Cancel child charges"); await click("Add another room");
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true); expect(button("Change meal plan").props.disabled).toBe(true);
  const warn = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined }; warn(event); expect(event.preventDefault).toHaveBeenCalled();
  const next = firstPricingInput("property", room, id, { mode: "flat", occupancy: [], included: { adults: "", adjustments: [] }, room: id, currency: "EUR", base: "100", adultAge: "12", childPrice: "0", countChildren: "yes", minimum: "1", maximum: "", cancellation: "non_refundable", freeDays: "", payment: "full" });
  for (const configuration of [{ ...next.configuration, currency: "USD" }, { ...next.configuration, roomTypeId: "room" }]) {
    await act(async () => view.root.findByType(FirstPricingSetup).props.onCreate({ ...next, configuration }));
  }
  expect(client.termsAction).not.toHaveBeenCalled(); await click("Cancel room setup"); expect(button("Review saved charges").props.disabled).toBe(false);
  await click("Review saved charges"); expect(button("Add another room").props.disabled).toBe(true);
});

it("builds a linked room-only offer with explicit terms and rejects invalid settings", () => {
  const id = "61000000-0000-4000-8000-000000000004", room = { ...snapshot.rooms[0], roomTypeId: id };
  const values = { parent: room.offers[0].id, kind: "percentage", value: "-10.25", cancellation: "non_refundable", deadline: "", payment: "full" };
  const created = linkedOfferInput(room, id, values);
  expect(created.configuration.offers[0]).toEqual(room.offers[0]); expect(created.configuration.children).toEqual(room.children);
  expect(created.configuration.offers[1]).toEqual({ id, termsRevision: id, meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } }, restrictions: { kind: "inherit" }, price: { kind: "linked", parentId: "flex", adjustment: { kind: "percentage", basisPoints: -1025 }, dateOverrides: [] } });
  expect(created.terms).toMatchObject({ expectedRevision: null, cancellation: { kind: "non_refundable" }, payment: { kind: "full" } });
  expect(linkedOfferInput(room, id, { ...values, kind: "fixed", value: "-90071992547409.93", cancellation: "flexible", deadline: "365" }).configuration.offers[1].price).toMatchObject({ adjustment: { deltaMinor: "-9007199254740993" } });
  expect(linkedOfferInput(room, id, { ...values, cancellation: "flexible", deadline: "0" }).terms.cancellation).toMatchObject({ terms: { freeCancellationDeadlineDays: 0 } });
  for (const patch of [{ parent: "outside" }, { kind: "other" }, { value: "-100.01" }, { value: "1.001" }, { cancellation: "" }, { payment: "" }, { cancellation: "flexible", deadline: "366" }, { cancellation: "flexible", deadline: "1.5" }]) expect(() => linkedOfferInput(room, id, { ...values, ...patch })).toThrow();
  expect(() => linkedOfferInput(created.configuration, id, values)).toThrow();
});
it("appends linked offers preserving prices, revisions and accepted-policy retry identity", async () => {
  const id = "61000000-0000-4000-8000-000000000004", offerId = "61000000-0000-4000-8000-000000000005", room = { ...snapshot.rooms[0], roomTypeId: id };
  client.read.mockResolvedValueOnce({ ...snapshot, rooms: [room], revision: 7, sources, stale: false });
  const policy = vi.fn().mockResolvedValue({ revision: offerId }); client.termsAction.mockReturnValue(policy);
  await mount(); await click("Save draft"); const prior = saved;
  await act(async () => input().props.onChange({ target: { value: "155.25" } }));
  await click("Add linked offer"); expect(button("Save draft").props.disabled).toBe(true); expect(button("Change meal plan").props.disabled).toBe(true);
  const next = linkedOfferInput(room, offerId, { parent: "flex", kind: "percentage", value: "-10", cancellation: "non_refundable", deadline: "", payment: "full" });
  client.prepare.mockRejectedValueOnce(new ApiErrorResponse(403, {}));
  await act(async () => view.root.findByType(NewLinkedOffer).props.onCreate(next));
  expect(button("Cancel new offer").props.disabled).toBe(true); expect(view.root.findByType(NewLinkedOffer).props.disabled).toBe(true);
  const attempted = client.prepare.mock.calls.at(-1)![0]; await click("Retry last action");
  expect(policy).toHaveBeenCalledOnce(); expect(client.termsAction).toHaveBeenCalledOnce(); expect(client.prepare.mock.calls.at(-1)![0]).toEqual(attempted);
  expect(client.saveDraft).toHaveBeenCalledTimes(1); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); expect(saved.draftId).toBe(prior.draftId); expect(saved.revision).toBe(prior.revision + 1); expect(saved.baseRevision).toBe(7);
  expect(saved.snapshot.rooms).toHaveLength(1); expect(saved.snapshot.rooms[0].revision).toBe(8); expect(saved.snapshot.rooms[0].offers).toHaveLength(2);
  expect(saved.snapshot.rooms[0].offers[0]).toEqual(editedSnapshot({ ...snapshot, rooms: [room] }, { "0:0:0": "155.25" }).rooms[0].offers[0]);
  expect(saved.snapshot.rooms[0].offers[1].id).toBe(offerId); expect(saved.snapshot.rooms[0].offers[1].termsRevision).toBe(offerId);
  await click("Review saved charges"); expect(button("Add linked offer").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
});
it("cancels new-offer setup without writes and protects pending entries and leaving", async () => {
  await mount(); await click("Save draft"); await click("Edit child charges"); expect(button("Add linked offer").props.disabled).toBe(true);
  await click("Add linked offer"); expect(button("Cancel new offer")).toBeUndefined(); await click("Cancel child charges"); await click("Add linked offer");
  expect(input().props.disabled).toBe(true); expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true);
  const warn = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined }; warn(event); expect(event.preventDefault).toHaveBeenCalled();
  await click("Cancel new offer"); expect(client.termsAction).not.toHaveBeenCalled(); expect(button("Review saved charges").props.disabled).toBe(false);
});

it.each(["flat", "occupancy", "per_person", "included_guests"])("creates an independent %s offer without replacing existing child bands or offers", (mode) => {
  const id = "61000000-0000-4000-8000-000000000004", offerId = "61000000-0000-4000-8000-000000000005";
  const original = snapshot.rooms[0], root = { ...original.offers[0], meal: { kind: "room_only" as const, charge: { kind: "room" as const, amountMinor: "0" } } };
  const existing = { ...original, roomTypeId: id, children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 2, nightlyMinor: "0", countsTowardCapacity: false }, { fromAge: 3, throughAge: 11, nightlyMinor: "2500", countsTowardCapacity: true }] }, offers: [root, { ...root, id: "linked", price: { kind: "linked" as const, parentId: root.id, adjustment: { kind: "percentage" as const, basisPoints: -1000 }, dateOverrides: [] }, restrictions: { kind: "inherit" as const } }] };
  const setupRoom = { roomTypeId: id, name: "Double", capacity: existing.capacity };
  const values = { mode, occupancy: ["100", "130"], included: { adults: "1", adjustments: [{ kind: "fixed", value: "0" }, { kind: "fixed", value: "25" }] }, room: id, currency: "EUR", base: "130", adultAge: "", childPrice: "", countChildren: "", minimum: "2", maximum: "10", cancellation: "non_refundable", freeDays: "", payment: "full" };
  const next = firstPricingInput(existing.propertyId, setupRoom, offerId, values, existing);
  expect(next.configuration.children).toEqual(existing.children); expect(next.configuration.offers.slice(0, 2)).toEqual(existing.offers);
  expect(next.configuration.capacity).toEqual(existing.capacity); expect(next.configuration.offers[2]).toMatchObject({ price: { kind: "independent", calendar: { base: { mode }, months: [], seasons: [], weekdays: [], dates: [] } }, restrictions: { kind: "own", rules: { minArrivalNights: 2, maxStayNights: 10 } } });
  expect(() => firstPricingInput(existing.propertyId, setupRoom, offerId, { ...values, currency: "USD" }, existing)).toThrow("existing room");
  expect(() => firstPricingInput(existing.propertyId, setupRoom, offerId, { ...values, mode: "occupancy", occupancy: ["100"] }, existing)).toThrow();
  expect(() => firstPricingInput(existing.propertyId, setupRoom, offerId, { ...values, mode: "included_guests", included: { adults: "1", adjustments: [] } }, existing)).toThrow();
});
it("creates an independent offer through fixed-room setup and retains policy retry and saved review", async () => {
  const id = "61000000-0000-4000-8000-000000000004", offerId = "61000000-0000-4000-8000-000000000005", room = { ...snapshot.rooms[0], roomTypeId: id };
  client.read.mockResolvedValueOnce({ ...snapshot, rooms: [room], revision: 7, sources, stale: false });
  const policy = vi.fn().mockResolvedValue({ revision: offerId }); client.termsAction.mockReturnValue(policy);
  await mount(); await click("Save draft"); const prior = saved;
  await click("Edit child charges"); expect(button("Add independent offer").props.disabled).toBe(true); await click("Cancel child charges");
  await click("Add independent offer"); expect(view.root.findByType(FirstPricingSetup).props.existingRoom).toMatchObject({ roomTypeId: id });
  expect(view.root.findAllByProps({ "aria-label": "Room type" })).toHaveLength(0); expect(view.root.findAllByProps({ "aria-label": "Price per child per night (0 is allowed)" })).toHaveLength(0);
  expect(view.root.findByProps({ "aria-label": "Currency code (for example EUR)" }).props.disabled).toBe(true);
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Change meal plan").props.disabled).toBe(true);
  await click("Cancel new offer"); expect(client.termsAction).not.toHaveBeenCalled(); expect(button("Review saved charges").props.disabled).toBe(false);
  await act(async () => input().props.onChange({ target: { value: "155.25" } })); await click("Add independent offer");
  const next = firstPricingInput(room.propertyId, { roomTypeId: id, name: "Double", capacity: room.capacity }, offerId, { mode: "flat", occupancy: [], included: { adults: "", adjustments: [] }, room: id, currency: "EUR", base: "200", adultAge: "", childPrice: "", countChildren: "", minimum: "2", maximum: "", cancellation: "non_refundable", freeDays: "", payment: "full" }, room);
  client.prepare.mockRejectedValueOnce(new Error("lost preparation")); await act(async () => view.root.findByType(FirstPricingSetup).props.onCreate(next));
  expect(button("Cancel new offer").props.disabled).toBe(true); const attempted = client.prepare.mock.calls.at(-1)![0]; await click("Retry last action");
  expect(policy).toHaveBeenCalledOnce(); expect(client.prepare.mock.calls.at(-1)![0]).toEqual(attempted);
  await click("Save draft"); expect(saved.draftId).toBe(prior.draftId); expect(saved.baseRevision).toBe(7); expect(saved.snapshot.rooms[0].revision).toBe(8);
  expect(saved.snapshot.rooms[0].children).toEqual(room.children); expect(saved.snapshot.rooms[0].offers[0].termsRevision).toBe(room.offers[0].termsRevision);
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { base: { amountMinor: "15525" } } });
  expect(saved.snapshot.rooms[0].offers[1].price).toMatchObject({ kind: "independent", calendar: { base: { amountMinor: "20000" } } });
  await click("Review saved charges"); expect(button("Add independent offer").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
});

function includedRoom() {
  const room = structuredClone(snapshot.rooms[0]), offer = room.offers[0];
  const base = { mode: "included_guests" as const, baseGuests: 2, baseMinor: "13000", adjustments: [{ kind: "fixed" as const, deltaMinor: "-3000" }, { kind: "fixed" as const, deltaMinor: "0" }, { kind: "percentage" as const, basisPoints: 1925 }] };
  return { ...room, capacity: { ...room.capacity, total: 3, adults: 3 }, offers: [
    { ...offer, price: { kind: "independent" as const, calendar: { base, months: [{ month: 8, price: { ...base, baseMinor: "20000" } }], seasons: [{ from: "12-01", through: "12-31", name: "Winter", tier: "high", price: { ...base, baseMinor: "25000" } }], weekdays: [{ day: 0, adjustment: { kind: "fixed" as const, deltaMinor: "100" } }], dates: [{ date: "2026-12-25", price: { mode: "flat" as const, amountMinor: "30000" } }] } } },
    { ...offer, id: "linked", price: { kind: "linked" as const, parentId: offer.id, adjustment: { kind: "percentage" as const, basisPoints: -1000 }, dateOverrides: [] }, restrictions: { kind: "inherit" as const } },
    { ...offer, id: "other" },
  ] };
}
it("replaces included base settings exactly while preserving every other price and policy", () => {
  const room = includedRoom(), original = structuredClone(room);
  const originalPrice = room.offers[0].price; if (originalPrice.kind !== "independent") throw new Error("fixture");
  const entry = { adults: "2", adjustments: [{ kind: "fixed", value: "-30" }, { kind: "fixed", value: "0" }, { kind: "fixed", value: "+25" }] };
  const changed = changeIncludedAdjustments(room, "flex", entry, "130");
  expect(changed).toEqual({ ...room, offers: [{ ...room.offers[0], price: { ...room.offers[0].price, calendar: { ...originalPrice.calendar, base: { mode: "included_guests", baseGuests: 2, baseMinor: "13000", adjustments: [{ kind: "fixed", deltaMinor: "-3000" }, { kind: "fixed", deltaMinor: "0" }, { kind: "fixed", deltaMinor: "2500" }] } } } }, ...room.offers.slice(1)] });
  expect(changeIncludedAdjustments(room, "flex", { adults: "1", adjustments: [{ kind: "fixed", value: "0" }, { kind: "percentage", value: "+10.25" }, { kind: "percentage", value: "0" }] }, "150.25").offers[0].price).toMatchObject({ calendar: { base: { baseGuests: 1, baseMinor: "15025", adjustments: [{ kind: "fixed", deltaMinor: "0" }, { kind: "percentage", basisPoints: 1025 }, { kind: "percentage", basisPoints: 0 }] } } });
  for (const value of ["", "1e2", "NaN", "1.001", "-130", "10000000000000000"]) expect(() => changeIncludedAdjustments(room, "flex", { ...entry, adjustments: [{ kind: "fixed", value }, ...entry.adjustments.slice(1)] }, "130")).toThrow();
  for (const adults of ["", "0", "4", "1.5"]) expect(() => changeIncludedAdjustments(room, "flex", { ...entry, adults }, "130")).toThrow();
  expect(() => changeIncludedAdjustments(room, "flex", { ...entry, adjustments: [] }, "130")).toThrow();
  expect(() => changeIncludedAdjustments(room, "flex", { ...entry, adjustments: [{ kind: "percentage", value: "-100" }, ...entry.adjustments.slice(1)] }, "130")).toThrow();
  expect(() => changeIncludedAdjustments(room, "flex", entry, "bad")).toThrow();
  for (const id of ["missing", "linked", "other"]) expect(() => changeIncludedAdjustments(room, id, entry, "130")).toThrow();
  expect(room).toEqual(original);
});
it("prefills included settings, guards pending edits and saves current bases through review and reload", async () => {
  const room = includedRoom(); const originalPrice = room.offers[0].price; if (originalPrice.kind !== "independent") throw new Error("fixture"); client.read.mockResolvedValueOnce({ ...snapshot, rooms: [room], revision: 7, sources, stale: false });
  await mount(); await click("Save draft"); const draftId = saved.draftId;
  const field = (label: string) => view.root.findByProps({ "aria-label": label });
  const set = async (label: string, value: string) => { await act(async () => field(label).props.onChange({ target: { value } })); };
  expect(view.root.findAllByType("button").filter((node) => node.children.join("") === "Edit included-adult adjustments")).toHaveLength(1);
  await click("Edit stay rules"); expect(button("Edit included-adult adjustments").props.disabled).toBe(true); await click("Cancel stay-rule edit");
  await click("Edit included-adult adjustments");
  expect(field("Adults included in the base price").props.value).toBe("2"); expect(field("Adjustment for 1 adult").props.value).toBe("-30.00"); expect(field("Adjustment for 3 adults").props.value).toBe("19.25");
  expect(button("Save draft").props.disabled).toBe(true); expect(button("Review saved charges").props.disabled).toBe(true); expect(input().props.disabled).toBe(true);
  expect(button("Add independent offer").props.disabled).toBe(true); expect(button("Change meal plan").props.disabled).toBe(true); expect(button("Edit stay rules").props.disabled).toBe(true);
  const warn = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined }; warn(event); expect(event.preventDefault).toHaveBeenCalled();
  await set("Adjustment for 1 adult", "-200"); await click("Apply included-adult adjustments"); expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(1);
  await click("Cancel included-adult adjustments"); expect(button("Review saved charges").props.disabled).toBe(false); expect(client.saveDraft).toHaveBeenCalledTimes(1);
  await set("Room 1 Offer 1 2 adults included", "150.25"); await set("Room 1 Offer 3 Per room", "199.99");
  await click("Edit included-adult adjustments"); expect(JSON.stringify(view.toJSON())).toContain("150.25");
  await set("Adults included in the base price", "1"); expect(field("Adjustment for 2 adults").props.value).toBe(""); expect(field("Adjustment for 3 adults").props.value).toBe("");
  await click("Apply included-adult adjustments"); expect(button("Save draft").props.disabled).toBe(true);
  await set("Adjustment type for 2 adults", "percentage"); await set("Adjustment for 2 adults", "10.25"); await set("Adjustment type for 3 adults", "fixed"); await set("Adjustment for 3 adults", "25");
  await click("Apply included-adult adjustments"); expect(button("Review saved charges").props.disabled).toBe(true);
  await click("Save draft"); expect(saved).toMatchObject({ draftId, revision: 2, baseRevision: 7 }); expect(saved.snapshot.rooms[0].revision).toBe(8);
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { base: { baseGuests: 1, baseMinor: "15025", adjustments: [{ kind: "fixed", deltaMinor: "0" }, { kind: "percentage", basisPoints: 1025 }, { kind: "fixed", deltaMinor: "2500" }] }, months: originalPrice.calendar.months } });
  expect(saved.snapshot.rooms[0].offers[2].price).toMatchObject({ calendar: { base: { amountMinor: "19999" } } });
  expect(client.termsAction).not.toHaveBeenCalled(); await click("Review saved charges"); expect(button("Edit included-adult adjustments").props.disabled).toBe(true); expect(button("Approve rates").props.disabled).toBe(true);
  client.read.mockResolvedValueOnce({ ...saved.snapshot, revision: 8, sources, stale: false }); vi.mocked(window.confirm).mockReturnValue(true);
  await click("Reload pricing"); await click("Edit included-adult adjustments"); expect(field("Adults included in the base price").props.value).toBe("1"); expect(field("Adjustment for 2 adults").props.value).toBe("10.25");
});
