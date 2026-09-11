import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FirstPricingSetup, firstPricingInput } from "./FirstPricingSetup";
import { PricingEditor } from "./PricingEditor";
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
