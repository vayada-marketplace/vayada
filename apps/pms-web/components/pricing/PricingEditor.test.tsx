import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FirstPricingSetup, firstPricingInput } from "./FirstPricingSetup";
import { StepFirstPrices } from "./StepFirstPrices";
import { bookingsService } from "@/services/bookings";
import { PricingEditor } from "./PricingEditor";
import { PricingStayPreview } from "./PricingStayPreview";
import { OptionWindow } from "./OptionWindow";
import { StepOptions } from "./StepOptions";
import { GuestPreview } from "./GuestPreview";
import { PriceCalendar } from "./PriceCalendar";
import { changeIncludedAdjustments } from "./PricingIncludedAdjustments";
import { changeDatePrice } from "./PricingDates";
import { NewLinkedOffer, linkedOfferInput } from "./NewLinkedOffer";
import { changeLinkedParent, linkedParentChoices } from "./PricingLinkedParent";
import { changeMealPlan, PricingMealPlan } from "./PricingMealPlan";
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
import ConfirmDialog from "@/components/ConfirmDialog";
import Modal from "@/components/Modal";
import { ApiErrorResponse } from "@/services/api/client";
import type {
  PricingSnapshot,
  PricingDraft,
  createReplacementPricingClient,
} from "@/services/api/replacementPricingClient";

const snapshot: PricingSnapshot = {
  currency: "EUR",
  ownerReferences: { finance: "finance" },
  rooms: [
    {
      version: "pricing.v2",
      propertyId: "property",
      roomTypeId: "room",
      revision: 1,
      currency: "EUR",
      capacity: { total: 2, adults: 2, children: 1 },
      children: {
        adultFromAge: 12,
        bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "2500", countsTowardCapacity: true }],
      },
      offers: [
        {
          id: "flex",
          termsRevision: "terms",
          meal: {
            kind: "breakfast",
            charge: { kind: "person", adultMinor: "1200", childBandAmountsMinor: ["600"] },
          },
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
          restrictions: {
            kind: "own",
            rules: {
              minArrivalNights: 1,
              maxStayNights: null,
              closedToArrival: false,
              closedToDeparture: false,
              stopSell: false,
            },
            seasons: [],
            dates: [],
          },
        },
      ],
    },
  ],
};
const sources = { room: "room", terms: "terms", finance: "finance" };
let view: ReactTestRenderer;
let saved: PricingDraft;
const confirm = vi.fn(),
  publish = vi.fn();
const client = {
  termsAction: vi.fn(),
  readTerms: vi.fn(),
  read: vi.fn(),
  prepare: vi.fn(),
  saveDraft: vi.fn(),
  reviewCharges: vi.fn(),
  confirmationAction: vi.fn(() => confirm),
  publicationAction: vi.fn<(draft: PricingDraft) => typeof publish>(),
  readDraft: vi.fn(),
  paymentMethods: vi.fn(),
  cardReadiness: vi.fn(),
  notSellingRates: vi.fn(),
};
/** A button by its text; icons beside the text (e.g. "+ Add linked offer") are ignored. */
const button = (label: string) =>
  view.root
    .findAllByType("button")
    .find(
      (node) =>
        node.children
          .filter((child) => typeof child === "string")
          .join("")
          .trim() === label,
    )!;
const click = async (label: string) => {
  await act(async () => {
    button(label).props.onClick();
  });
};
const input = () =>
  view.root.findAllByType("input").find((node) => node.props.inputMode === "decimal")!;
/** Checkboxes other than More options' payment methods (VAY-2188), e.g. a window's confirmation. */
const paymentLabels = ["Card online", "Pay at property", "Bank transfer", "PayPal"];
const checkboxes = () =>
  view.root
    .findAllByProps({ type: "checkbox" })
    .filter((node) => node.type === "input" && !paymentLabels.includes(node.props["aria-label"]));
const onlyCheckbox = () => {
  const [only, ...more] = checkboxes();
  if (!only || more.length) throw new Error(`expected one checkbox, found ${checkboxes().length}`);
  return only;
};
/** The card's switch for an extra choice, by its name ("Non-refundable", "With breakfast"). */
const extraSwitch = (name: string) =>
  view.root.findByProps({ role: "switch", "aria-label": `Offer “${name}”` });
/** Re-enter the shown base price: something to save without changing any amount. */
const touch = async () => {
  await act(async () => input().props.onChange({ target: { value: input().props.value } }));
};
const reload = async () => {
  await click(button("Reload pricing") ? "Reload pricing" : "Discard");
  for (const confirm of ["Discard and reload", "Discard changes"])
    if (button(confirm)) await click(confirm);
};
/** More options' "Your own option": opens the new-option window and picks how the option is priced. Does nothing
 * while "Your own option" is disabled. */
const addOption = async (kind: "Based on another option" | "With its own prices") => {
  if (button("Your own option").props.disabled) return;
  await click("Your own option");
  await click(kind);
};
/** Opens the season window: a season from the "Busier dates" list by its name, or "Add a season". */
const openSeason = async (name?: string) => {
  const target = name
    ? view.root
        .findAllByType("button")
        .find((node) => String(node.props["aria-label"] ?? "").startsWith(`Edit season ${name} `))!
    : button("Add a season");
  await act(async () => target.props.onClick());
};
/** A button in the open season window (its footer has its own Cancel). */
const seasonButton = (label: string) =>
  view.root
    .findByType(Modal)
    .findAllByType("button")
    .find(
      (node) =>
        node.children
          .filter((child) => typeof child === "string")
          .join("")
          .trim() === label,
    );
const seasonClick = async (label: string) => {
  await act(async () => seasonButton(label)!.props.onClick());
};
const mount = async (roomTypeId = "room") => {
  await act(async () => {
    view = create(
      <PricingEditor
        client={client as ReturnType<typeof createReplacementPricingClient>}
        roomTypeId={roomTypeId}
      />,
    );
  });
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("React", React);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  // Bank-transfer and PayPal acceptance off (VAY-2139).
  client.paymentMethods.mockResolvedValue([]);
  // Card not ready on the booking page (VAY-2205).
  client.cardReadiness.mockResolvedValue({
    card: { ready: false, reason: "switch_off", charge: "at_booking" },
    deposits: { ready: false },
  });
  // Every published rate sells (VAY-2304).
  client.notSellingRates.mockResolvedValue([]);
  client.readTerms.mockImplementation(async (roomTypeId, offerId, revision) => ({
    roomTypeId,
    offerId,
    revision,
    cancellation: { kind: "non_refundable" },
    payment: { kind: "full" },
  }));
  client.read.mockResolvedValue({ ...snapshot, revision: 1, sources, stale: false });
  client.prepare.mockImplementation(async (value) => ({
    sources,
    snapshot: { ...snapshot, ...value },
  }));
  client.saveDraft.mockImplementation(
    async ({ draftId, expectedDraftRevision, baseRevision, snapshot: value }) => {
      saved = {
        draftId,
        revision: expectedDraftRevision + 1,
        baseRevision,
        snapshot: value,
        sources,
        stale: false,
      };
      return saved.revision;
    },
  );
  client.reviewCharges.mockImplementation(async () => ({
    ...saved,
    fingerprint: "fingerprint",
    declaration: "all_mandatory_charges_included",
  }));
  client.confirmationAction.mockReturnValue(confirm);
  client.publicationAction.mockReturnValue(publish);
  confirm.mockResolvedValue({ id: "declaration" });
  publish.mockResolvedValue({ revision: 2, replayed: false });
});
afterEach(() => {
  if (view) act(() => view.unmount());
  vi.unstubAllGlobals();
});
it("offers no price-source choice: published prices are the direct-booking prices (VAY-2079)", async () => {
  await mount();
  expect(view.root.findAllByProps({ "aria-label": "Price source" })).toHaveLength(0);
  expect(JSON.stringify(view.toJSON())).not.toContain("price source");
});
it("saves edited prices in one action: the press declares mandatory charges and a lost publication retries exactly", async () => {
  await mount();
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(checkboxes()).toHaveLength(0);
  const rendered = JSON.stringify(view.toJSON());
  for (const text of [
    "By saving, you confirm these prices include all mandatory taxes and fees.",
    "12.00",
    "6.00",
    "25.00",
  ])
    expect(rendered).toContain(text);
  await act(async () => input().props.onChange({ target: { value: "123.45" } }));
  publish.mockRejectedValueOnce(new Error("lost response"));
  await click("Save and publish");
  expect(input().props.disabled).toBe(true);
  expect(button("Reload pricing").props.disabled).toBe(true);
  expect(client.saveDraft.mock.calls[0][0]).toMatchObject({
    expectedDraftRevision: 0,
    baseRevision: 1,
    snapshot: {
      rooms: [{ offers: [{ price: { calendar: { base: { amountMinor: "12345" } } } }] }],
    },
  });
  expect(client.reviewCharges).toHaveBeenCalledWith(saved.draftId);
  expect(client.confirmationAction).toHaveBeenCalledWith(
    expect.objectContaining({ draftId: saved.draftId, revision: 1, fingerprint: "fingerprint" }),
    "save_prices",
  );
  await click("Retry last action");
  expect(client.prepare).toHaveBeenCalledTimes(1);
  expect(client.saveDraft).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(client.publicationAction).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(saved.snapshot.rooms[0].children).toEqual(snapshot.rooms[0].children);
  expect(client.publicationAction.mock.calls[0][0]).toMatchObject({
    revision: 2,
    snapshot: { ownerReferences: { charges: "declaration" } },
  });
  const text = JSON.stringify(view.toJSON());
  expect(text).toContain("Prices saved");
  expect(text).toContain("Channel distribution is not connected yet");
  expect(button("Save and publish").props.disabled).toBe(true);
});
it("rejects invalid decimals before making requests", async () => {
  await mount();
  await act(async () => input().props.onChange({ target: { value: "10.001" } }));
  await click("Save and publish");
  expect(client.prepare).not.toHaveBeenCalled();
  expect(JSON.stringify(view.toJSON())).toContain("Enter a valid price");
});
it("retains an uncertain draft save and serializes repeated clicks", async () => {
  await mount();
  await touch();
  const failure = new Error("lost save");
  client.saveDraft.mockRejectedValueOnce(failure);
  await click("Save and publish");
  const first = client.saveDraft.mock.calls[0][0];
  await click("Retry last action");
  expect(client.prepare).toHaveBeenCalledTimes(1);
  expect(client.saveDraft.mock.calls[1][0]).toEqual(first);
  expect(publish).toHaveBeenCalledTimes(1);
  await click("Reload pricing");
  await touch();
  let finish!: (value: unknown) => void;
  client.reviewCharges.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    button("Save and publish").props.onClick();
    button("Save and publish").props.onClick();
  });
  expect(client.prepare).toHaveBeenCalledTimes(2);
  expect(client.reviewCharges).toHaveBeenCalledTimes(2);
  await act(async () =>
    finish({ ...saved, fingerprint: "fingerprint", declaration: "all_mandatory_charges_included" }),
  );
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledTimes(2);
});
it.each([
  ["payments_disabled", "payments are switched off for this property"],
  ["deposit_execution_unavailable", "Deposit payment terms cannot be saved yet"],
])(
  "explains a Finance denial (%s), keeps the edits editable and saves again into a fresh draft",
  async (reason, text) => {
    await mount();
    await act(async () => input().props.onChange({ target: { value: "123.45" } }));
    const denied = { code: "denied", reason };
    client.prepare.mockRejectedValueOnce(new ApiErrorResponse(403, denied));
    await click("Save and publish");
    expect(JSON.stringify(view.toJSON())).toContain(text);
    expect(button("Retry last action")).toBeUndefined();
    expect(input().props.value).toBe("123.45");
    expect(input().props.disabled).toBe(false);
    expect(client.saveDraft).not.toHaveBeenCalled();
    // The edits are still unsaved, so the button beside Save discards them.
    expect(button("Discard").props.disabled).toBe(false);
    expect(button("Save and publish").props.disabled).toBe(false);
    await act(async () => input().props.onChange({ target: { value: "124.45" } }));
    await click("Save and publish");
    expect(client.prepare).toHaveBeenCalledTimes(2);
    expect(client.prepare.mock.calls[1][1].draftId).not.toBe(
      client.prepare.mock.calls[0][1].draftId,
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(client.saveDraft.mock.calls[0][0].draftId).toBe(client.prepare.mock.calls[1][1].draftId);
    expect(
      client.publicationAction.mock.calls[0][0].snapshot.rooms[0].offers[0].price,
    ).toMatchObject({ calendar: { base: { amountMinor: "12445" } } });
  },
);
it("never declares charges for a draft that changed after this save", async () => {
  await mount();
  await touch();
  client.reviewCharges.mockImplementationOnce(async () => ({
    ...saved,
    revision: saved.revision + 1,
    fingerprint: "fingerprint",
    declaration: "all_mandatory_charges_included",
  }));
  await click("Save and publish");
  expect(client.confirmationAction).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(JSON.stringify(view.toJSON())).toContain("Reload pricing before continuing");
  expect(button("Save and publish").props.disabled).toBe(true);
  await click("Reload pricing");
  await touch();
  const other = structuredClone(snapshot.rooms[0]);
  client.reviewCharges.mockImplementationOnce(async () => ({
    ...saved,
    snapshot: {
      ...saved.snapshot,
      rooms: [{ ...other, children: { ...other.children, adultFromAge: 16 } }],
    },
    fingerprint: "fingerprint",
    declaration: "all_mandatory_charges_included",
  }));
  await click("Save and publish");
  expect(client.confirmationAction).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});
it("declares for the saved draft even when the server returns its keys in another order", async () => {
  await mount();
  await touch();
  const reorder = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, item]) => [key, reorder(item)]),
          )
        : value;
  client.reviewCharges.mockImplementationOnce(async () => ({
    ...saved,
    snapshot: reorder(saved.snapshot),
    fingerprint: "fingerprint",
    declaration: "all_mandatory_charges_included",
  }));
  await click("Save and publish");
  expect(client.confirmationAction).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledOnce();
  expect(JSON.stringify(view.toJSON())).toContain("Prices saved");
});
it("distinguishes missing configuration from denial and requires reload after a conflict", async () => {
  client.read.mockResolvedValueOnce(null);
  await mount();
  expect(JSON.stringify(view.toJSON())).toContain("This room has no prices yet");
  client.read.mockRejectedValueOnce(new ApiErrorResponse(403, {}));
  await click("Reload pricing");
  expect(JSON.stringify(view.toJSON())).toContain("do not have access");
  expect(JSON.stringify(view.toJSON())).not.toContain("This room has no prices yet");
  await click("Reload pricing");
  await touch();
  client.prepare.mockRejectedValueOnce(new ApiErrorResponse(409, {}));
  await click("Save and publish");
  expect(client.prepare).toHaveBeenCalledTimes(1);
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(button("Reload pricing").props.disabled).toBe(false);
});
it("preserves all non-base settings and handles every supported mode without floating point rounding", () => {
  const bases = [
    { mode: "flat", amountMinor: "100" },
    { mode: "occupancy", amountsMinor: ["100", "200"] },
    { mode: "per_person", unitMinor: "100" },
    { mode: "included_guests", baseGuests: 1, baseMinor: "100", adjustments: [] },
  ] as const;
  for (const base of bases) {
    const original: PricingSnapshot = {
      ...snapshot,
      rooms: [
        {
          ...snapshot.rooms[0],
          offers: [
            {
              ...snapshot.rooms[0].offers[0],
              price: {
                kind: "independent",
                calendar: { base, months: [], seasons: [], weekdays: [], dates: [] },
              },
            },
          ],
        },
      ],
    };
    const changed = editedSnapshot(original, { "0:0:0": "90071992547409.93" });
    expect(JSON.stringify(changed)).toContain("9007199254740993");
    expect(original.rooms[0].offers[0].price).toMatchObject({ calendar: { base } });
    expect(changed.rooms[0].offers[0].meal).toEqual(original.rooms[0].offers[0].meal);
  }
  expect(() => editedSnapshot(snapshot, { "0:0:0": "1e2" })).toThrow();
  expect(() => editedSnapshot(snapshot, { "0:0:0": "0" })).toThrow("greater than zero");
});
it("shows included adjustments, date prices and restrictions with the saved prices", async () => {
  const room = snapshot.rooms[0],
    offer = room.offers[0];
  client.read.mockResolvedValueOnce({
    ...snapshot,
    revision: 1,
    sources,
    stale: false,
    rooms: [
      {
        ...room,
        offers: [
          {
            ...offer,
            price: {
              kind: "independent",
              calendar: {
                base: {
                  mode: "included_guests",
                  baseGuests: 2,
                  baseMinor: "13000",
                  adjustments: [
                    { kind: "fixed", deltaMinor: "-3000" },
                    { kind: "fixed", deltaMinor: "0" },
                  ],
                },
                months: [],
                seasons: [],
                weekdays: [],
                dates: [{ date: "2026-12-25", price: { mode: "flat", amountMinor: "20000" } }],
              },
            },
          },
          {
            ...offer,
            id: "discount",
            price: {
              kind: "linked",
              parentId: offer.id,
              adjustment: { kind: "percentage", basisPoints: -1000 },
              dateOverrides: [],
            },
            restrictions: { kind: "inherit" },
          },
        ],
      },
    ],
  });
  await mount();
  await touch();
  await click("Save and publish");
  expect(publish).toHaveBeenCalledOnce();
  const text = JSON.stringify(view.toJSON());
  // VAY-2125: step 1, the option cards, More options and the option windows show what "Retained rules" repeated.
  for (const value of [
    "−30.00 EUR",
    "2026-12-25",
    "200.00 EUR",
    "10% cheaper",
    "Minimum arrival stay: 1",
    "inherited from the parent offer",
    "Show cancellation and payment terms",
  ])
    expect(text).toContain(value);
});
it("warns before leaving pending work and cancels property changes before selection mutates", async () => {
  await mount();
  await act(async () => input().props.onChange({ target: { value: "120" } }));
  const listener = (name: string) =>
    vi
      .mocked(window.addEventListener)
      .mock.calls.filter(([event]) => event === name)
      .at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true });
  listener("beforeunload")(unload);
  expect(unload.defaultPrevented).toBe(true);
  const change = new Event("pms:before-property-change", { cancelable: true });
  listener("pms:before-property-change")(change);
  expect(change.defaultPrevented).toBe(true);
  const proceed = vi.fn(),
    accepted = new CustomEvent("pms:before-property-change", {
      cancelable: true,
      detail: { proceed },
    });
  await act(async () => listener("pms:before-property-change")(accepted));
  expect(accepted.defaultPrevented).toBe(true);
  await click("Cancel");
  expect(proceed).not.toHaveBeenCalled();
  await act(async () => listener("pms:before-property-change")(accepted));
  await click("Leave");
  expect(proceed).toHaveBeenCalledTimes(1);
  const leaving = new Event("beforeunload", { cancelable: true });
  listener("beforeunload")(leaving);
  expect(leaving.defaultPrevented).toBe(false);
});

it.each([new Error("lost preparation response")])(
  "retains a created policy after preparation failure %s and saves it on retry",
  async (failure) => {
    const id = "61000000-0000-4000-8000-000000000001",
      room = { roomTypeId: id, name: "Double", capacity: { total: 2, adults: 2, children: 1 } };
    client.read.mockResolvedValueOnce(null);
    const policy = vi.fn().mockResolvedValue({ revision: id });
    client.termsAction.mockReturnValue(policy);
    client.prepare.mockRejectedValueOnce(failure);
    await act(async () => {
      view = create(
        <PricingEditor
          client={client as ReturnType<typeof createReplacementPricingClient>}
          setup={{ propertyId: id, rooms: [room] }}
          roomTypeId={id}
        />,
      );
    });
    const input = firstPricingInput(id, room, id, {
      mode: "flat",
      occupancy: [],
      included: { adults: "", adjustments: [] },
      methods: ["card"],
      room: id,
      currency: "EUR",
      base: "130",
      adultAge: "12",
      childPrice: "0",
      countChildren: "yes",
      minimum: "1",
      maximum: "",
      cancellation: "non_refundable",
      freeDays: "",
      payment: "full",
    });
    // VAY-2188: the first prices save at once.
    await act(async () =>
      view.root
        .findByType(StepFirstPrices)
        .props.onCreate({ configuration: input.configuration, terms: [input.terms] }, "save"),
    );
    expect(button("Reload pricing").props.disabled).toBe(true);
    await click("Retry last action");
    expect(policy).toHaveBeenCalledOnce();
    expect(client.prepare).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(saved.baseRevision).toBe(0);
    expect(saved.snapshot.rooms[0].offers[0].termsRevision).toBe(id);
    expect(button("Save and publish").props.disabled).toBe(true);
  },
);
it.each(["occupancy", "per_person"])(
  "preserves %s prices through editing and saved charge review",
  async (mode) => {
    const value = structuredClone(snapshot),
      offer = value.rooms[0].offers[0];
    if (offer.price.kind !== "independent") throw new Error("fixture");
    const price = {
      ...offer.price,
      calendar: {
        ...offer.price.calendar,
        base:
          mode === "occupancy"
            ? { mode, amountsMinor: ["10000", "13000"] }
            : { mode: "per_person", unitMinor: "6000" },
      },
    };
    client.read.mockResolvedValue({
      ...value,
      rooms: [{ ...value.rooms[0], offers: [{ ...offer, price }] }],
      revision: 1,
      sources,
      stale: false,
    });
    await mount();
    const label = mode === "occupancy" ? "Room 1 Offer 1 2 adults" : "Room 1 Offer 1 Per adult";
    await act(async () =>
      view.root.findByProps({ "aria-label": label }).props.onChange({ target: { value: "75.25" } }),
    );
    await click("Save and publish");
    expect(view.root.findByProps({ "aria-label": label }).props.value).toBe("75.25");
    expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
      calendar: {
        base:
          mode === "occupancy"
            ? { mode, amountsMinor: ["10000", "7525"] }
            : { mode: "per_person", unitMinor: "7525" },
      },
    });
    expect(saved.snapshot.rooms[0].children).toEqual(snapshot.rooms[0].children);
    expect(button("Save and publish").props.disabled).toBe(true);
  },
);
it("keeps included-adult adjustments when editing and reviewing the saved base price", async () => {
  const value = structuredClone(snapshot),
    offer = value.rooms[0].offers[0];
  if (offer.price.kind !== "independent") throw new Error("fixture");
  const adjustments = [
    { kind: "fixed" as const, deltaMinor: "-3000" },
    { kind: "fixed" as const, deltaMinor: "0" },
  ];
  const price = {
    ...offer.price,
    calendar: {
      ...offer.price.calendar,
      base: { mode: "included_guests" as const, baseGuests: 2, baseMinor: "13000", adjustments },
    },
  };
  client.read.mockResolvedValue({
    ...value,
    rooms: [{ ...value.rooms[0], offers: [{ ...offer, price }] }],
    revision: 1,
    sources,
    stale: false,
  });
  await mount();
  await act(async () => input().props.onChange({ target: { value: "150" } }));
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: { base: { baseMinor: "15000", baseGuests: 2, adjustments } },
  });
  // VAY-2125: the guest-count row of "Prices and seasons" lists the other guest counts' adjustments (VAY-2280).
  expect(JSON.stringify(view.toJSON())).toContain("This room is priced another way: 1 adult −€30 · 2 adults €");
  expect(button("Save and publish").props.disabled).toBe(true);
});
it("labels every saved weekday using Monday-zero without changing its adjustment", async () => {
  const room = snapshot.rooms[0],
    offer = room.offers[0];
  if (offer.price.kind !== "independent") throw new Error("fixture");
  const weekdays = Array.from({ length: 7 }, (_, day) => ({
    day,
    adjustment: { kind: "percentage" as const, basisPoints: (day + 1) * 100 },
  }));
  client.read.mockResolvedValueOnce({
    ...snapshot,
    revision: 1,
    sources,
    stale: false,
    rooms: [
      {
        ...room,
        offers: [
          { ...offer, price: { ...offer.price, calendar: { ...offer.price.calendar, weekdays } } },
        ],
      },
    ],
  });
  await mount();
  await touch();
  await click("Save and publish");
  // VAY-2125: step 3 summarises every weekday rule.
  const paragraphs = view.root.findAllByType("p").map((node) => node.children.join(""));
  expect(paragraphs).toContain(
    "Monday +1% · Tuesday +2% · Wednesday +3% · Thursday +4% · Friday +5% · Saturday +6% · Sunday +7%",
  );
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { weekdays } });
});
it("adds and clears an independent date price without changing fallback or other rules", () => {
  const room = snapshot.rooms[0],
    before = structuredClone(room),
    added = changeDatePrice(room, "flex", "2028-02-29", "150.25");
  expect(added.offers[0].price).toMatchObject({
    calendar: {
      base: { amountMinor: "10000" },
      dates: [{ date: "2028-02-29", price: { mode: "flat", amountMinor: "15025" } }],
    },
  });
  expect(changeDatePrice(added, "flex", "2028-02-29", null)).toEqual(room);
  expect(room).toEqual(before);
  for (const [date, amount] of [
    ["2026-02-29", "100"],
    ["", "100"],
    ["2026-12-25", "0"],
    ["2026-12-25", "1.001"],
  ])
    expect(() => changeDatePrice(room, "flex", date, amount)).toThrow();
  expect(() => changeDatePrice(added, "flex", "2028-02-29", "200")).toThrow("Clear the existing");
});
it("keeps IDR date prices in whole rupiah (VAY-2085)", () => {
  const room = { ...snapshot.rooms[0], currency: "IDR" };
  expect(() => changeDatePrice(room, "flex", "2028-02-29", "150000.25")).toThrow("whole rupiah");
  expect(changeDatePrice(room, "flex", "2028-02-29", "150000").offers[0].price).toMatchObject({
    calendar: { dates: [{ date: "2028-02-29", price: { mode: "flat", amountMinor: "15000000" } }] },
  });
});
it("preserves linked adjustments, other dates and parents when clearing an override", () => {
  const room = snapshot.rooms[0],
    child = {
      ...room.offers[0],
      id: "nr",
      price: {
        kind: "linked" as const,
        parentId: "flex",
        adjustment: { kind: "percentage" as const, basisPoints: -1000 },
        dateOverrides: [
          { date: "2026-12-24", price: { mode: "flat" as const, amountMinor: "11000" } },
        ],
      },
      restrictions: { kind: "inherit" as const },
    };
  const linked = { ...room, offers: [...room.offers, child] };
  const added = changeDatePrice(linked, "nr", "2026-12-25", "200");
  expect(added.offers[0]).toEqual(room.offers[0]);
  expect(added.offers[1]).toMatchObject({
    meal: child.meal,
    restrictions: child.restrictions,
    price: { parentId: "flex", adjustment: child.price.adjustment },
  });
  expect(changeDatePrice(added, "nr", "2026-12-25", null)).toEqual(linked);
});
it("blocks saving unfinished date entry, protects leaving and requires review for applied dates", async () => {
  await mount();
  await touch();
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  expect(field("Override date for Room 1 Offer 1").props.type).toBe("text");
  await act(async () =>
    field("Override date for Room 1 Offer 1").props.onChange({ target: { value: "2026-12-" } }),
  );
  expect(button("Save and publish").props.disabled).toBe(true);
  await click("Cancel date entry");
  await act(async () =>
    field("Date room price for Room 1 Offer 1").props.onChange({ target: { value: "150.25" } }),
  );
  expect(button("Save and publish").props.disabled).toBe(true);
  const listener = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true });
  listener(unload);
  expect(unload.defaultPrevented).toBe(true);
  await click("Cancel date entry");
  expect(button("Save and publish").props.disabled).toBe(false);
  await act(async () =>
    field("Override date for Room 1 Offer 1").props.onChange({ target: { value: "2026-12-25" } }),
  );
  await act(async () =>
    field("Date room price for Room 1 Offer 1").props.onChange({ target: { value: "150.25" } }),
  );
  await click("Add date price");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: { dates: [{ date: "2026-12-25", price: { amountMinor: "15025" } }] },
  });
  expect(button("Clear date price").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});

it("adds exact weekday adjustments and clears only the selected rule", () => {
  const room = changeDatePrice(snapshot.rooms[0], "flex", "2026-12-25", "150.25");
  const monday = changeWeekdayPrice(room, "flex", "0", { kind: "percentage", value: "-10.25" });
  const friday = changeWeekdayPrice(monday, "flex", "4", { kind: "fixed", value: "+20.05" });
  expect(friday.offers[0].price).toMatchObject({
    calendar: {
      weekdays: [
        { day: 0, adjustment: { kind: "percentage", basisPoints: -1025 } },
        { day: 4, adjustment: { kind: "fixed", deltaMinor: "2005" } },
      ],
      dates: [{ date: "2026-12-25", price: { amountMinor: "15025" } }],
    },
  });
  expect(changeWeekdayPrice(friday, "flex", "4", null)).toEqual(monday);
  expect(changeWeekdayPrice(monday, "flex", "0", null)).toEqual(room);
  for (const day of ["", "7", "-1", "00", "0.0"])
    expect(() => changeWeekdayPrice(room, "flex", day, { kind: "fixed", value: "1" })).toThrow();
  for (const value of ["", "NaN", "1e2", "1.001", "9999999999999999999"])
    expect(() => changeWeekdayPrice(room, "flex", "0", { kind: "fixed", value })).toThrow();
  for (const value of ["-100.01", "90071992547409.92", "1.001"])
    expect(() => changeWeekdayPrice(room, "flex", "0", { kind: "percentage", value })).toThrow();
  expect(() => changeWeekdayPrice(monday, "flex", "0", { kind: "fixed", value: "1" })).toThrow(
    /Clear/,
  );
  expect(() => changeWeekdayPrice(room, "flex", "0", null)).toThrow();
  expect(
    changeWeekdayPrice({ ...room, currency: "KWD" }, "flex", "6", {
      kind: "fixed",
      value: "-1.123",
    }).offers[0].price,
  ).toMatchObject({ calendar: { weekdays: [{ day: 6, adjustment: { deltaMinor: "-1123" } }] } });
  expect(() =>
    changeWeekdayPrice({ ...room, currency: "JPY" }, "flex", "0", { kind: "fixed", value: "1.1" }),
  ).toThrow();
  const linked = {
    ...room.offers[0],
    id: "linked",
    price: {
      kind: "linked" as const,
      parentId: "flex",
      adjustment: { kind: "fixed" as const, deltaMinor: "0" },
      dateOverrides: [],
    },
    restrictions: { kind: "inherit" as const },
  };
  expect(() =>
    changeWeekdayPrice({ ...room, offers: [...room.offers, linked] }, "linked", "0", {
      kind: "fixed",
      value: "1",
    }),
  ).toThrow(/independent/);
});

it("keeps date and weekday pending entries separate and reviews saved weekday changes", async () => {
  await mount();
  await touch();
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  expect(field("Weekday for Room 1 Offer 1").props.value).toBe("");
  expect(field("Weekday adjustment type for Room 1 Offer 1").props.value).toBe("");
  await fill("Weekday for Room 1 Offer 1", "0");
  await fill("Override date for Room 1 Offer 1", "2026-");
  await click("Cancel date entry");
  expect(button("Save and publish").props.disabled).toBe(true);
  const listener = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true });
  listener(unload);
  expect(unload.defaultPrevented).toBe(true);
  await fill("Override date for Room 1 Offer 1", "2026-");
  await click("Cancel weekday entry");
  expect(button("Save and publish").props.disabled).toBe(true);
  await click("Cancel date entry");
  expect(button("Save and publish").props.disabled).toBe(false);
  await fill("Weekday for Room 1 Offer 1", "4");
  await fill("Weekday adjustment type for Room 1 Offer 1", "fixed");
  await fill("Weekday adjustment for Room 1 Offer 1", "+20.05");
  await click("Add weekday adjustment");

  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: { weekdays: [{ day: 4, adjustment: { deltaMinor: "2005" } }] },
  });
  expect(JSON.stringify(view.toJSON())).toContain("Friday");
  expect(button("Clear weekday adjustment").props.disabled).toBe(true);
  expect(button("Add weekday adjustment").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});

it("adds monthly prices in all recurring modes and preserves other rules on clear", () => {
  const modes = [
    { mode: "flat" as const, amountMinor: "10000" },
    { mode: "per_person" as const, unitMinor: "5000" },
    { mode: "occupancy" as const, amountsMinor: ["10000", "15000"] },
    {
      mode: "included_guests" as const,
      baseMinor: "13000",
      baseGuests: 2,
      adjustments: [
        { kind: "fixed" as const, deltaMinor: "-3000" },
        { kind: "fixed" as const, deltaMinor: "0" },
      ],
    },
  ];
  for (const base of modes) {
    const original = snapshot.rooms[0],
      offer = original.offers[0];
    if (offer.price.kind !== "independent") throw new Error();
    const room = {
      ...original,
      offers: [
        { ...offer, price: { ...offer.price, calendar: { ...offer.price.calendar, base } } },
      ],
    };
    const dates = changeDatePrice(room, "flex", "2026-08-25", "220");
    const weekday = changeWeekdayPrice(dates, "flex", "4", { kind: "fixed", value: "20" });
    const added = changeMonthPrice(
      weekday,
      "flex",
      "8",
      base.mode === "occupancy" ? ["170", "180"] : ["180"],
    );
    expect(changeMonthPrice(added, "flex", "8", null)).toEqual(weekday);
    expect(added.offers[0].price).toMatchObject({
      calendar: { base, months: [{ month: 8, price: { mode: base.mode } }] },
    });
    expect(() => changeMonthPrice(added, "flex", "8", ["190"])).toThrow(/Clear/);
    if (base.mode === "included_guests") {
      expect(added.offers[0].price).toMatchObject({
        calendar: {
          months: [{ price: { baseMinor: "18000", baseGuests: 2, adjustments: base.adjustments } }],
        },
      });
      expect(() => changeMonthPrice(weekday, "flex", "8", ["20"])).toThrow();
    }
    if (base.mode === "occupancy")
      expect(() => changeMonthPrice(weekday, "flex", "8", ["180"])).toThrow();
  }
  const room = snapshot.rooms[0];
  for (const month of ["", "0", "13", "01", "1.5"])
    expect(() => changeMonthPrice(room, "flex", month, ["180"])).toThrow();
  for (const amount of ["", "0", "-1", "1.001", "NaN"])
    expect(() => changeMonthPrice(room, "flex", "8", [amount])).toThrow();
  expect(
    changeMonthPrice({ ...room, currency: "KWD" }, "flex", "1", ["1.123"]).offers[0].price,
  ).toMatchObject({ calendar: { months: [{ price: { amountMinor: "1123" } }] } });
  expect(() => changeMonthPrice({ ...room, currency: "JPY" }, "flex", "1", ["1.1"])).toThrow();
  const added = changeMonthPrice(room, "flex", "8", ["180"]);
  const offer = added.offers[0];
  if (offer.price.kind !== "independent") throw new Error();
  const calendarOnly = {
    ...added,
    offers: [
      { ...offer, price: { ...offer.price, calendar: { ...offer.price.calendar, base: null } } },
    ],
  };
  expect(changeMonthPrice(calendarOnly, "flex", "9", ["190"]).offers[0].price).toMatchObject({
    calendar: { base: null, months: [{ month: 8 }, { month: 9 }] },
  });
  const cleared = changeMonthPrice(calendarOnly, "flex", "8", null);
  expect(() => changeMonthPrice(cleared, "flex", "9", ["190"])).toThrow(/recurring/);
});

it("protects unfinished monthly prices independently and reviews only saved changes", async () => {
  await mount();
  await touch();
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  expect(field("Month for Room 1 Offer 1").props.value).toBe("");
  await fill("Month for Room 1 Offer 1", "8");
  await fill("Weekday for Room 1 Offer 1", "0");
  await click("Cancel weekday entry");
  expect(button("Save and publish").props.disabled).toBe(true);
  const listener = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true });
  listener(unload);
  expect(unload.defaultPrevented).toBe(true);
  await fill("Override date for Room 1 Offer 1", "2026-");
  await click("Cancel month entry");
  expect(button("Save and publish").props.disabled).toBe(true);
  await click("Cancel date entry");
  expect(button("Save and publish").props.disabled).toBe(false);
  await fill("Month for Room 1 Offer 1", "8");
  await fill("Monthly Per room for Room 1 Offer 1", "180.25");
  await click("Add monthly price");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: { months: [{ month: 8, price: { amountMinor: "18025" } }] },
  });
  expect(button("Clear monthly price").props.disabled).toBe(true);
  expect(button("Add monthly price").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(JSON.stringify(view.toJSON())).toContain("August");
});

it("validates recurring season dates and preserves the exact other pricing rules", () => {
  const winter = { name: "Winter holidays", tier: "High", from: "12-15", through: "01-10" };
  const leap = { name: "Leap day", tier: "", from: "02-29", through: "02-29" };
  const original = changeMonthPrice(
    changeWeekdayPrice(
      changeDatePrice(snapshot.rooms[0], "flex", "2026-12-25", "250"),
      "flex",
      "4",
      { kind: "fixed", value: "20" },
    ),
    "flex",
    "8",
    ["180"],
  );
  const added = changeSeasonPrice(original, "flex", winter, ["200.25"]);
  expect(added.offers[0].price).toMatchObject({
    calendar: { seasons: [{ ...winter, price: { mode: "flat", amountMinor: "20025" } }] },
  });
  const both = changeSeasonPrice(added, "flex", leap, ["190"]);
  expect(changeSeasonPrice(both, "flex", leap, null)).toEqual(added);
  expect(changeSeasonPrice(added, "flex", winter, null)).toEqual(original);
  for (const season of [
    winter,
    { ...winter, from: "01-10", through: "02-01" },
    { ...winter, from: "12-01", through: "12-15" },
    { ...winter, from: "02-30" },
    { ...winter, from: "2-01" },
    { ...winter, name: " " },
  ])
    expect(() => changeSeasonPrice(added, "flex", season, ["200"])).toThrow();
  expect(() =>
    changeSeasonPrice(both, "flex", { ...leap, from: "02-28", through: "03-01" }, ["200"]),
  ).toThrow();
  expect(() => changeSeasonPrice(original, "flex", winter, ["0"])).toThrow();
  expect(() => changeSeasonPrice(original, "flex", winter, ["1.001"])).toThrow();
  expect(() => changeSeasonPrice(original, "flex", winter, null)).toThrow();
  const bases = [
    { mode: "per_person" as const, unitMinor: "5000" },
    { mode: "occupancy" as const, amountsMinor: ["10000", "13000"] },
    {
      mode: "included_guests" as const,
      baseMinor: "13000",
      baseGuests: 2,
      adjustments: [
        { kind: "fixed" as const, deltaMinor: "-3000" },
        { kind: "fixed" as const, deltaMinor: "0" },
      ],
    },
  ];
  for (const base of bases) {
    const room = snapshot.rooms[0],
      offer = room.offers[0];
    if (offer.price.kind !== "independent") throw new Error();
    const configured = {
      ...room,
      offers: [
        { ...offer, price: { ...offer.price, calendar: { ...offer.price.calendar, base } } },
      ],
    };
    const result = changeSeasonPrice(
      configured,
      "flex",
      winter,
      base.mode === "occupancy" ? ["160", "190"] : ["190"],
    );
    expect(result.offers[0].price).toMatchObject({
      calendar: { base, seasons: [{ ...winter, price: { mode: base.mode } }] },
    });
    expect(changeSeasonPrice(result, "flex", winter, null)).toEqual(configured);
    if (base.mode === "included_guests") {
      expect(result.offers[0].price).toMatchObject({
        calendar: {
          seasons: [
            { price: { baseMinor: "19000", baseGuests: 2, adjustments: base.adjustments } },
          ],
        },
      });
      expect(() => changeSeasonPrice(configured, "flex", winter, ["20"])).toThrow();
    }
    if (base.mode === "occupancy")
      expect(() => changeSeasonPrice(configured, "flex", winter, ["100"])).toThrow();
  }
});

it("protects the season window independently and requires review after adding a season", async () => {
  await mount();
  await touch();
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  await openSeason();
  await fill("Month for Room 1 Offer 1", "8");
  await click("Cancel month entry");
  expect(button("Save and publish").props.disabled).toBe(true);
  const listener = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true });
  listener(unload);
  expect(unload.defaultPrevented).toBe(true);
  await fill("Month for Room 1 Offer 1", "8");
  await seasonClick("Cancel");
  expect(view.root.findAllByType(Modal)).toHaveLength(0);
  expect(button("Save and publish").props.disabled).toBe(true);
  await click("Cancel month entry");
  expect(button("Save and publish").props.disabled).toBe(false);
  await openSeason();
  for (const [name, value] of [
    ["Season name", "Summer"],
    ["Tier label (optional)", "High"],
    ["Starts: day", "15"],
    ["Starts: month", "6"],
    ["Ends: day", "10"],
    ["Ends: month", "9"],
    ["Season price Per room", "180.25"],
  ])
    await fill(name, value);
  await seasonClick("Save season");
  expect(view.root.findAllByType(Modal)).toHaveLength(0);
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: {
      seasons: [
        {
          name: "Summer",
          tier: "High",
          from: "06-15",
          through: "09-10",
          price: { amountMinor: "18025" },
        },
      ],
    },
  });
  expect(button("Add a season").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(JSON.stringify(view.toJSON())).toContain("Summer · €180.25");
});
it("checks the season window's days and overlaps before changing the room", async () => {
  await mount();
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  const add = async (name: string, from: [string, string], through: [string, string]) => {
    await openSeason();
    for (const [label, value] of [
      ["Season name", name],
      ["Starts: day", from[0]],
      ["Starts: month", from[1]],
      ["Ends: day", through[0]],
      ["Ends: month", through[1]],
      ["Season price Per room", "150"],
    ])
      await fill(label, value);
    await seasonClick("Save season");
  };
  await add("Winter", ["20", "12"], ["5", "1"]);
  expect(view.root.findAllByType(Modal)).toHaveLength(0);
  await add("Odd", ["30", "2"], ["3", "3"]);
  expect(JSON.stringify(view.toJSON())).toContain("Choose a real start day and end day.");
  await seasonClick("Cancel");
  await add("New year", ["1", "1"], ["10", "1"]);
  expect(JSON.stringify(view.toJSON())).toContain("These days overlap another season.");
  await seasonClick("Cancel");
  await openSeason("Winter");
  expect(field("Starts: day").props.value).toBe("20");
  expect(field("Ends: month").props.value).toBe("1");
  await seasonClick("Delete season");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { seasons: [] } });
});

it("updates only own default stay rules and preserves exceptions and linked ownership", () => {
  const room = snapshot.rooms[0],
    offer = room.offers[0];
  if (offer.restrictions.kind !== "own") throw new Error();
  const exceptions = {
    ...offer.restrictions,
    seasons: [
      {
        from: "12-15",
        through: "01-10",
        rules: { ...offer.restrictions.rules, minArrivalNights: 5 },
      },
    ],
    dates: [{ date: "2026-12-25", rules: { ...offer.restrictions.rules, stopSell: true } }],
  };
  const own = { ...offer, restrictions: exceptions };
  const child = {
    ...own,
    id: "nr",
    price: {
      kind: "linked" as const,
      parentId: "flex",
      adjustment: { kind: "percentage" as const, basisPoints: -1000 },
      dateOverrides: [],
    },
  };
  const original = { ...room, offers: [own, child] };
  const input = {
    minimum: "3",
    maximum: "10",
    closedToArrival: true,
    closedToDeparture: true,
    stopSell: true,
  };
  const changed = changeStayRules(original, "nr", input);
  expect(changed).toEqual({
    ...original,
    offers: [
      own,
      {
        ...child,
        restrictions: {
          ...exceptions,
          rules: {
            minArrivalNights: 3,
            maxStayNights: 10,
            closedToArrival: true,
            closedToDeparture: true,
            stopSell: true,
          },
        },
      },
    ],
  });
  expect(
    changeStayRules(original, "flex", { ...input, maximum: "" }).offers[0].restrictions,
  ).toMatchObject({ rules: { maxStayNights: null } });
  for (const minimum of ["", "0", "-1", "1.5", "1e2", "9007199254740992"])
    expect(() => changeStayRules(original, "flex", { ...input, minimum })).toThrow();
  for (const maximum of ["0", "2", "1.5", " ", "9007199254740992"])
    expect(() => changeStayRules(original, "flex", { ...input, maximum })).toThrow();
  expect(() =>
    changeStayRules(
      { ...original, offers: [own, { ...child, restrictions: { kind: "inherit" } }] },
      "nr",
      input,
    ),
  ).toThrow(/inherits/);
  expect(original.offers[0].restrictions).toEqual(exceptions);
});

it("prefills and cancels stay-rule edits, preserves pending calendar entries and requires saved review", async () => {
  await mount();
  await touch();
  await click("Edit stay rules");
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  expect(field("Minimum nights for Room 1 Offer 1").props.value).toBe("1");
  expect(field("Maximum nights (blank means unlimited) for Room 1 Offer 1").props.value).toBe("");
  expect(field("Stop sales for Room 1 Offer 1").props.checked).toBe(false);
  expect(button("Save and publish").props.disabled).toBe(true);
  const listener = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true });
  listener(unload);
  expect(unload.defaultPrevented).toBe(true);
  await fill("Minimum nights for Room 1 Offer 1", "5");
  await fill("Month for Room 1 Offer 1", "8");
  await click("Cancel stay-rule edit");
  expect(button("Save and publish").props.disabled).toBe(true);
  await click("Cancel month entry");
  await click("Edit stay rules");
  expect(field("Minimum nights for Room 1 Offer 1").props.value).toBe("1");
  await fill("Month for Room 1 Offer 1", "8");
  await click("Cancel month entry");
  expect(button("Save and publish").props.disabled).toBe(true);
  await fill("Minimum nights for Room 1 Offer 1", "3");
  await fill("Maximum nights (blank means unlimited) for Room 1 Offer 1", "2");
  await click("Apply stay rules");
  expect(JSON.stringify(view.toJSON())).toContain("at least as large");
  await fill("Maximum nights (blank means unlimited) for Room 1 Offer 1", "10");
  await act(async () =>
    field("Stop sales for Room 1 Offer 1").props.onChange({ target: { checked: true } }),
  );
  await click("Apply stay rules");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].restrictions).toMatchObject({
    rules: { minArrivalNights: 3, maxStayNights: 10, stopSell: true },
  });
  expect(button("Edit stay rules").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});

it("adds and selectively clears date stay rules without changing defaults or prices", () => {
  const room = snapshot.rooms[0],
    offer = room.offers[0];
  if (offer.restrictions.kind !== "own") throw new Error();
  const input = {
    minimum: "5",
    maximum: "10",
    closedToArrival: true,
    closedToDeparture: false,
    stopSell: true,
  };
  const original = {
    ...room,
    offers: [
      {
        ...offer,
        restrictions: {
          ...offer.restrictions,
          seasons: [
            {
              from: "12-01",
              through: "12-31",
              rules: { ...offer.restrictions.rules, minArrivalNights: 3 },
            },
          ],
        },
      },
    ],
  };
  const first = changeStayDate(original, "flex", "2028-02-29", input);
  const second = changeStayDate(first, "flex", "2026-12-25", { ...input, maximum: "" });
  expect(second.offers[0].restrictions).toMatchObject({
    dates: [
      {
        date: "2028-02-29",
        rules: { minArrivalNights: 5, maxStayNights: 10, closedToArrival: true, stopSell: true },
      },
      { date: "2026-12-25", rules: { maxStayNights: null } },
    ],
  });
  expect(changeStayDate(second, "flex", "2026-12-25", null)).toEqual(first);
  expect(changeStayDate(first, "flex", "2028-02-29", null)).toEqual(original);
  for (const date of ["", "2026-12-", "2026-02-29", "2026-13-01"])
    expect(() => changeStayDate(original, "flex", date, input)).toThrow();
  expect(() => changeStayDate(first, "flex", "2028-02-29", input)).toThrow(/Clear/);
  expect(() => changeStayDate(original, "flex", "2026-12-25", null)).toThrow();
  expect(() =>
    changeStayDate(original, "flex", "2026-12-25", { ...input, maximum: "4" }),
  ).toThrow();
  const linked = {
    ...offer,
    id: "nr",
    price: {
      kind: "linked" as const,
      parentId: "flex",
      adjustment: { kind: "fixed" as const, deltaMinor: "0" },
      dateOverrides: [],
    },
  };
  expect(
    changeStayDate({ ...room, offers: [offer, linked] }, "nr", "2026-12-25", input).offers[1]
      .restrictions,
  ).toMatchObject({ dates: [{ date: "2026-12-25" }] });
  expect(() =>
    changeStayDate(
      { ...room, offers: [offer, { ...linked, restrictions: { kind: "inherit" } }] },
      "nr",
      "2026-12-25",
      input,
    ),
  ).toThrow(/owns/);
});

it("protects unfinished date stay rules, prefills defaults and reviews the saved exception", async () => {
  await mount();
  await touch();
  await click("Add date stay rules");
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  expect(field("Minimum nights for date rule Room 1 Offer 1").props.value).toBe("1");
  expect(button("Save and publish").props.disabled).toBe(true);
  const listener = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true });
  listener(unload);
  expect(unload.defaultPrevented).toBe(true);
  await fill("Month for Room 1 Offer 1", "8");
  await click("Cancel date stay rules");
  expect(button("Save and publish").props.disabled).toBe(true);
  await click("Add date stay rules");
  await click("Cancel month entry");
  expect(button("Save and publish").props.disabled).toBe(true);
  await fill("Stay-rule date for Room 1 Offer 1", "2026-02-29");
  await click("Apply date stay rules");
  expect(JSON.stringify(view.toJSON())).toContain("valid YYYY-MM-DD");
  await fill("Stay-rule date for Room 1 Offer 1", "2026-12-25");
  await fill("Minimum nights for date rule Room 1 Offer 1", "5");
  await act(async () =>
    field("Close arrivals for date rule Room 1 Offer 1").props.onChange({
      target: { checked: true },
    }),
  );
  await click("Apply date stay rules");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].restrictions).toMatchObject({
    rules: { minArrivalNights: 1 },
    dates: [{ date: "2026-12-25", rules: { minArrivalNights: 5, closedToArrival: true } }],
  });
  expect(button("Clear date stay rules").props.disabled).toBe(true);
  expect(button("Add date stay rules").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});

it("validates seasonal stay ranges and clears only the selected exception", () => {
  const input = {
    minimum: "5",
    maximum: "10",
    closedToArrival: false,
    closedToDeparture: true,
    stopSell: false,
  };
  const original = changeStayDate(snapshot.rooms[0], "flex", "2026-12-25", {
    ...input,
    minimum: "7",
  });
  const winter = changeStaySeason(original, "flex", "12-15", "01-10", input);
  const leap = changeStaySeason(winter, "flex", "02-29", "02-29", { ...input, maximum: "" });
  expect(winter.offers[0].restrictions).toMatchObject({
    rules: { minArrivalNights: 1 },
    seasons: [
      {
        from: "12-15",
        through: "01-10",
        rules: { minArrivalNights: 5, maxStayNights: 10, closedToDeparture: true },
      },
    ],
    dates: [{ date: "2026-12-25", rules: { minArrivalNights: 7 } }],
  });
  expect(changeStaySeason(leap, "flex", "02-29", "02-29", null)).toEqual(winter);
  expect(changeStaySeason(winter, "flex", "12-15", "01-10", null)).toEqual(original);
  for (const [from, through] of [
    ["12-15", "01-10"],
    ["01-10", "02-01"],
    ["12-01", "12-15"],
    ["02-28", "03-01"],
    ["02-30", "03-01"],
    ["", "01-01"],
    ["1-01", "01-02"],
  ])
    expect(() => changeStaySeason(leap, "flex", from, through, input)).toThrow();
  expect(() =>
    changeStaySeason(original, "flex", "06-01", "06-30", { ...input, minimum: "0" }),
  ).toThrow();
  expect(() =>
    changeStaySeason(original, "flex", "06-01", "06-30", { ...input, maximum: "4" }),
  ).toThrow();
  expect(() => changeStaySeason(original, "flex", "06-01", "06-30", null)).toThrow();
  const offer = original.offers[0],
    linked = {
      ...offer,
      id: "nr",
      price: {
        kind: "linked" as const,
        parentId: "flex",
        adjustment: { kind: "fixed" as const, deltaMinor: "0" },
        dateOverrides: [],
      },
    };
  expect(
    changeStaySeason({ ...original, offers: [offer, linked] }, "nr", "06-01", "06-30", input)
      .offers[1].restrictions,
  ).toMatchObject({ seasons: [{ from: "06-01" }] });
  expect(() =>
    changeStaySeason(
      { ...original, offers: [offer, { ...linked, restrictions: { kind: "inherit" } }] },
      "nr",
      "06-01",
      "06-30",
      input,
    ),
  ).toThrow(/owns/);
});

it("protects seasonal stay entries separately and reviews then clears the saved rule", async () => {
  await mount();
  await touch();
  await click("Add seasonal stay rules");
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  expect(field("Minimum nights for season rule Room 1 Offer 1").props.value).toBe("1");
  expect(button("Save and publish").props.disabled).toBe(true);
  const listener = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: Event) => void;
  const unload = new Event("beforeunload", { cancelable: true });
  listener(unload);
  expect(unload.defaultPrevented).toBe(true);
  await click("Add date stay rules");
  await click("Cancel seasonal stay rules");
  expect(button("Save and publish").props.disabled).toBe(true);
  await click("Add seasonal stay rules");
  await click("Cancel date stay rules");
  expect(button("Save and publish").props.disabled).toBe(true);
  await fill("Stay-rule Start (MM-DD) for Room 1 Offer 1", "12-");
  await click("Apply seasonal stay rules");
  expect(JSON.stringify(view.toJSON())).toContain("valid MM-DD");
  await fill("Stay-rule Start (MM-DD) for Room 1 Offer 1", "12-15");
  await fill("Stay-rule End (MM-DD) for Room 1 Offer 1", "01-10");
  await fill("Minimum nights for season rule Room 1 Offer 1", "5");
  await click("Apply seasonal stay rules");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].restrictions).toMatchObject({
    seasons: [{ from: "12-15", through: "01-10", rules: { minArrivalNights: 5 } }],
  });
  expect(button("Clear seasonal stay rules").props.disabled).toBe(true);
  expect(button("Add seasonal stay rules").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});

it("copies the nearest rule owner through linked chains without altering other settings", () => {
  const room = structuredClone(snapshot.rooms[0]),
    root = room.offers[0];
  if (root.restrictions.kind !== "own") throw new Error("fixture");
  const policy = {
    ...root.restrictions,
    dates: [{ date: "2026-12-25", rules: { ...root.restrictions.rules, minArrivalNights: 5 } }],
    seasons: [{ from: "12-01", through: "12-31", rules: root.restrictions.rules }],
  };
  const linked = {
    ...root,
    id: "child",
    price: {
      kind: "linked" as const,
      parentId: root.id,
      adjustment: { kind: "percentage" as const, basisPoints: -1000 },
      dateOverrides: [],
    },
    restrictions: policy,
  };
  const leaf = {
    ...linked,
    id: "leaf",
    price: { ...linked.price, parentId: "middle" },
    restrictions: { kind: "inherit" as const },
  };
  const chain = {
    ...room,
    offers: [
      root,
      linked,
      {
        ...linked,
        id: "middle",
        price: { ...linked.price, parentId: "child" },
        restrictions: { kind: "inherit" as const },
      },
      leaf,
    ],
  };
  const changed = changeStayOwnership(chain, "leaf");
  expect(changed.offers[3]).toEqual({ ...leaf, restrictions: policy });
  expect(changed.offers.slice(0, 3)).toEqual(chain.offers.slice(0, 3));
  expect(changed.children).toEqual(chain.children);
  expect(changed.offers[3].restrictions).not.toBe(policy);
  expect(chain.offers[3].restrictions).toEqual({ kind: "inherit" });
  expect(changeStayOwnership(changed, "leaf").offers[3]).toEqual(leaf);
  expect(() => changeStayOwnership(chain, root.id)).toThrow("Independent");
  expect(() => changeStayOwnership(chain, "missing")).toThrow("missing");
  expect(() =>
    changeStayOwnership(
      {
        ...chain,
        offers: [
          ...chain.offers.slice(0, 3),
          { ...leaf, price: { ...leaf.price, parentId: "leaf" } },
        ],
      },
      "leaf",
    ),
  ).toThrow("invalid");
});
it("guards ownership confirmation, cancels without mutation, and saves the acknowledged copy for review", async () => {
  const room = snapshot.rooms[0],
    root = room.offers[0];
  client.read.mockResolvedValueOnce({
    ...snapshot,
    revision: 1,
    sources,
    stale: false,
    rooms: [
      {
        ...room,
        offers: [
          root,
          {
            ...root,
            id: "linked",
            price: {
              kind: "linked",
              parentId: root.id,
              adjustment: { kind: "percentage", basisPoints: -1000 },
              dateOverrides: [],
            },
            restrictions: { kind: "inherit" },
          },
        ],
      },
    ],
  });
  await mount();
  await touch();
  await click("Edit stay rules");
  expect(button("Use own stay rules").props.disabled).toBe(true);
  await click("Use own stay rules");
  expect(button("Apply stay-rule ownership")).toBeUndefined();
  await click("Cancel stay-rule edit");
  await click("Use own stay rules");
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(input().props.disabled).toBe(true);
  expect(button("Edit stay rules").props.disabled).toBe(true);
  expect(button("Apply stay-rule ownership").props.disabled).toBe(true);
  await click("Apply stay-rule ownership");
  expect(button("Cancel ownership change")).toBeDefined();
  const warn = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  warn(event);
  expect(event.preventDefault).toHaveBeenCalled();
  await click("Cancel ownership change");
  expect(button("Save and publish").props.disabled).toBe(false);
  await click("Use own stay rules");
  expect(onlyCheckbox().props.checked).toBe(false);
  await act(async () => onlyCheckbox().props.onChange({ target: { checked: true } }));
  await click("Apply stay-rule ownership");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[1].restrictions).toEqual(root.restrictions);
  expect(button("Use parent stay rules").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});

it("changes only the linked adjustment with exact signed currency and percentage values", () => {
  const room = snapshot.rooms[0],
    root = room.offers[0];
  const linked = {
    ...root,
    id: "linked",
    price: {
      kind: "linked" as const,
      parentId: root.id,
      adjustment: { kind: "percentage" as const, basisPoints: -1000 },
      dateOverrides: [
        { date: "2026-12-25", price: { mode: "flat" as const, amountMinor: "15000" } },
      ],
    },
  };
  const original = { ...room, offers: [root, linked] };
  for (const [kind, value, expected] of [
    ["fixed", "-90071992547409.93", { kind: "fixed", deltaMinor: "-9007199254740993" }],
    ["percentage", "-10.25", { kind: "percentage", basisPoints: -1025 }],
    ["fixed", "+20.00", { kind: "fixed", deltaMinor: "2000" }],
    ["percentage", "-0", { kind: "percentage", basisPoints: 0 }],
  ] as const) {
    expect(changeLinkedAdjustment(original, linked.id, { kind, value })).toEqual({
      ...original,
      offers: [root, { ...linked, price: { ...linked.price, adjustment: expected } }],
    });
  }
  for (const value of ["", "1e2", " 10", "NaN", "1.001", "--2", "900719925474099.99", "-100.01"])
    expect(() =>
      changeLinkedAdjustment(original, linked.id, { kind: "percentage", value }),
    ).toThrow();
  expect(() => changeLinkedAdjustment(original, root.id, { kind: "fixed", value: "1" })).toThrow(
    "linked",
  );
  expect(() =>
    changeLinkedAdjustment(original, linked.id, { kind: "other", value: "1" }),
  ).toThrow();
  expect(() =>
    changeLinkedAdjustment({ ...original, currency: "JPY" }, linked.id, {
      kind: "fixed",
      value: "1.2",
    }),
  ).toThrow();
  expect(
    changeLinkedAdjustment({ ...original, currency: "KWD" }, linked.id, {
      kind: "fixed",
      value: "-1.234",
    }).offers[1].price,
  ).toMatchObject({ adjustment: { deltaMinor: "-1234" } });
  expect(original.offers[1]).toEqual(linked);
});
it("protects pending linked edits and reviews only the saved adjustment", async () => {
  const room = snapshot.rooms[0],
    root = room.offers[0];
  client.read.mockResolvedValueOnce({
    ...snapshot,
    revision: 1,
    sources,
    stale: false,
    rooms: [
      {
        ...room,
        offers: [
          root,
          {
            ...root,
            id: "linked",
            price: {
              kind: "linked",
              parentId: root.id,
              adjustment: { kind: "percentage", basisPoints: -1000 },
              dateOverrides: [],
            },
            restrictions: { kind: "inherit" },
          },
        ],
      },
    ],
  });
  await mount();
  await touch();
  await click("Edit linked adjustment");
  const field = () =>
    view.root.findByProps({ "aria-label": "Linked adjustment for Room 1 Offer 2" });
  expect(field().props.value).toBe("-10.00");
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(button("Use own stay rules").props.disabled).toBe(true);
  const warn = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  warn(event);
  expect(event.preventDefault).toHaveBeenCalled();
  await act(async () =>
    view.root
      .findByProps({ "aria-label": "Linked adjustment type for Room 1 Offer 2" })
      .props.onChange({ target: { value: "fixed" } }),
  );
  expect(field().props.value).toBe("");
  await click("Apply linked adjustment");
  expect(JSON.stringify(view.toJSON())).toContain("valid signed amount");
  await click("Cancel linked adjustment");
  expect(button("Save and publish").props.disabled).toBe(false);
  await click("Use own stay rules");
  expect(button("Edit linked adjustment").props.disabled).toBe(true);
  await click("Cancel ownership change");
  await click("Edit linked adjustment");
  expect(field().props.value).toBe("-10.00");
  await act(async () => field().props.onChange({ target: { value: "-15.25" } }));
  await click("Apply linked adjustment");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[1].price).toMatchObject({
    adjustment: { kind: "percentage", basisPoints: -1525 },
  });
  expect(button("Edit linked adjustment").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});

it("changes every existing child charge exactly while preserving bands and all offers", () => {
  const original = snapshot.rooms[0],
    root = original.offers[0];
  const room = {
    ...original,
    children: {
      adultFromAge: 12,
      bands: [
        { fromAge: 0, throughAge: 2, nightlyMinor: "0", countsTowardCapacity: false },
        { fromAge: 3, throughAge: 11, nightlyMinor: "2500", countsTowardCapacity: true },
      ],
    },
    offers: [
      {
        ...root,
        meal: {
          kind: "breakfast" as const,
          charge: {
            kind: "person" as const,
            adultMinor: "1200",
            childBandAmountsMinor: ["0", "600"],
          },
        },
      },
      {
        ...root,
        id: "linked",
        price: {
          kind: "linked" as const,
          parentId: root.id,
          adjustment: { kind: "percentage" as const, basisPoints: -1000 },
          dateOverrides: [],
        },
        meal: { kind: "room_only" as const, charge: { kind: "room" as const, amountMinor: "0" } },
      },
    ],
  };
  expect(changeChildCharges(room, ["0", "90071992547409.93"])).toEqual({
    ...room,
    children: {
      ...room.children,
      bands: [
        room.children.bands[0],
        { ...room.children.bands[1], nightlyMinor: "9007199254740993" },
      ],
    },
  });
  expect(room.children.bands[1].nightlyMinor).toBe("2500");
  for (const amounts of [
    [],
    ["0"],
    ["0", "1", "2"],
    ["0", ""],
    ["0", "-1"],
    ["0", "1e2"],
    ["0", "1.001"],
    ["0", "10000000000000000"],
  ])
    expect(() => changeChildCharges(room, amounts)).toThrow();
  expect(() => changeChildCharges({ ...room, currency: "JPY" }, ["0", "1.2"])).toThrow();
  expect(
    changeChildCharges({ ...room, currency: "KWD" }, ["0", "1.234"]).children.bands[1].nightlyMinor,
  ).toBe("1234");
  expect(() =>
    changeChildCharges({ ...room, children: { ...room.children, adultFromAge: 18 } }, ["0", "1"]),
  ).toThrow("invalid");
});
it("protects child charge edits and saves the changed room-wide charge for review", async () => {
  const room = snapshot.rooms[0],
    root = room.offers[0];
  client.read.mockResolvedValueOnce({
    ...snapshot,
    revision: 1,
    sources,
    stale: false,
    rooms: [
      {
        ...room,
        offers: [
          root,
          {
            ...root,
            id: "linked",
            price: {
              kind: "linked",
              parentId: root.id,
              adjustment: { kind: "percentage", basisPoints: -1000 },
              dateOverrides: [],
            },
            restrictions: { kind: "inherit" },
          },
        ],
      },
    ],
  });
  await mount();
  await touch();
  await click("Edit child charges");
  const field = () => view.root.findByProps({ "aria-label": "Child charge ages 0–11 for Room 1" });
  expect(field().props.value).toBe("25.00");
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(button("Use own stay rules").props.disabled).toBe(true);
  const warn = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  warn(event);
  expect(event.preventDefault).toHaveBeenCalled();
  await act(async () => field().props.onChange({ target: { value: "-1" } }));
  await click("Apply child charges");
  expect(client.prepare).not.toHaveBeenCalled();
  await click("Cancel child charges");
  expect(button("Save and publish").props.disabled).toBe(false);
  await click("Use own stay rules");
  expect(button("Edit child charges").props.disabled).toBe(true);
  await click("Cancel ownership change");
  await click("Edit child charges");
  expect(field().props.value).toBe("25.00");
  await act(async () => field().props.onChange({ target: { value: "0" } }));
  await click("Apply child charges");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].children.bands[0].nightlyMinor).toBe("0");
  expect(saved.snapshot.rooms[0].offers[0]).toEqual(root);
  expect(button("Edit child charges").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});

it("edits both meal charging models exactly without altering linked prices or child supplements", () => {
  const room = snapshot.rooms[0],
    root = room.offers[0];
  const linked = {
    ...root,
    id: "linked",
    price: {
      kind: "linked" as const,
      parentId: root.id,
      adjustment: { kind: "percentage" as const, basisPoints: -1000 },
      dateOverrides: [
        { date: "2026-12-25", price: { mode: "flat" as const, amountMinor: "15000" } },
      ],
    },
  };
  const original = { ...room, offers: [root, linked] };
  expect(changeMealCharges(original, linked.id, ["90071992547409.93", "0"])).toEqual({
    ...original,
    offers: [
      root,
      {
        ...linked,
        meal: {
          ...linked.meal,
          charge: { kind: "person", adultMinor: "9007199254740993", childBandAmountsMinor: ["0"] },
        },
      },
    ],
  });
  const perRoom = {
    ...original,
    offers: [
      root,
      {
        ...linked,
        meal: {
          kind: "half_board" as const,
          charge: { kind: "room" as const, amountMinor: "2000" },
        },
      },
    ],
  };
  expect(changeMealCharges(perRoom, linked.id, ["0"]).offers[1].meal).toEqual({
    kind: "half_board",
    charge: { kind: "room", amountMinor: "0" },
  });
  for (const amounts of [
    [],
    ["1"],
    ["1", "2", "3"],
    ["-1", "0"],
    ["1.001", "0"],
    ["1e2", "0"],
    ["", "0"],
    ["10000000000000000", "0"],
  ])
    expect(() => changeMealCharges(original, linked.id, amounts)).toThrow();
  expect(() => changeMealCharges(perRoom, linked.id, ["1", "2"])).toThrow();
  expect(() => changeMealCharges(original, "missing", ["1", "0"])).toThrow();
  expect(() =>
    changeMealCharges({ ...original, currency: "JPY" }, linked.id, ["1.2", "0"]),
  ).toThrow();
  expect(
    changeMealCharges({ ...original, currency: "KWD" }, linked.id, ["1.234", "0"]).offers[1].meal
      .charge,
  ).toMatchObject({ adultMinor: "1234" });
  expect(() =>
    changeMealCharges(
      {
        ...room,
        offers: [
          { ...root, meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } } },
        ],
      },
      root.id,
      ["1"],
    ),
  ).toThrow();
  const bands = [
    { fromAge: 0, throughAge: 2, nightlyMinor: "0", countsTowardCapacity: false },
    { fromAge: 3, throughAge: 11, nightlyMinor: "2500", countsTowardCapacity: true },
  ];
  const multiple = {
    ...room,
    children: { ...room.children, bands },
    offers: [
      {
        ...root,
        meal: {
          ...root.meal,
          charge: {
            kind: "person" as const,
            adultMinor: "1200",
            childBandAmountsMinor: ["0", "600"],
          },
        },
      },
    ],
  };
  expect(changeMealCharges(multiple, root.id, ["15", "0", "7.50"]).offers[0].meal.charge).toEqual({
    kind: "person",
    adultMinor: "1500",
    childBandAmountsMinor: ["0", "750"],
  });
  expect(original.offers[1]).toEqual(linked);
});
it("guards meal edits, cancels safely and reviews saved adult and child meal amounts", async () => {
  const room = snapshot.rooms[0],
    root = room.offers[0];
  client.read.mockResolvedValueOnce({
    ...snapshot,
    revision: 1,
    sources,
    stale: false,
    rooms: [
      {
        ...room,
        offers: [
          root,
          {
            ...root,
            id: "linked",
            price: {
              kind: "linked",
              parentId: root.id,
              adjustment: { kind: "percentage", basisPoints: -1000 },
              dateOverrides: [],
            },
            meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
            restrictions: { kind: "inherit" },
          },
        ],
      },
    ],
  });
  await mount();
  await touch();
  await click("Edit meal charges");
  const adult = () =>
    view.root.findByProps({ "aria-label": "Meal charge Per adult for Room 1 Offer 1" });
  const child = () =>
    view.root.findByProps({ "aria-label": "Meal charge Per child ages 0–11 for Room 1 Offer 1" });
  expect(adult().props.value).toBe("12.00");
  expect(child().props.value).toBe("6.00");
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(button("Use own stay rules").props.disabled).toBe(true);
  const warn = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  warn(event);
  expect(event.preventDefault).toHaveBeenCalled();
  await act(async () => child().props.onChange({ target: { value: "-1" } }));
  await click("Apply meal charges");
  expect(client.prepare).not.toHaveBeenCalled();
  await click("Cancel meal charges");
  expect(button("Save and publish").props.disabled).toBe(false);
  await click("Use own stay rules");
  expect(button("Edit meal charges").props.disabled).toBe(true);
  await click("Cancel ownership change");
  await click("Edit meal charges");
  expect(child().props.value).toBe("6.00");
  await act(async () => {
    adult().props.onChange({ target: { value: "15.25" } });
  });
  await act(async () => child().props.onChange({ target: { value: "0" } }));
  await click("Apply meal charges");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].meal.charge).toEqual({
    kind: "person",
    adultMinor: "1525",
    childBandAmountsMinor: ["0"],
  });
  expect(saved.snapshot.rooms[0].children).toEqual(room.children);
  expect(button("Edit meal charges").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});

it("changes meal type and basis while preserving all other settings and canonical room-only zero", () => {
  const room = snapshot.rooms[0],
    root = room.offers[0];
  const linked = {
    ...root,
    id: "linked",
    price: {
      kind: "linked" as const,
      parentId: root.id,
      adjustment: { kind: "percentage" as const, basisPoints: -1000 },
      dateOverrides: [],
    },
    restrictions: { kind: "inherit" as const },
  };
  const original = { ...room, offers: [root, linked] };
  for (const kind of ["breakfast", "half_board", "full_board", "all_inclusive"]) {
    for (const basis of ["room", "person"]) {
      const charge =
        basis === "room"
          ? { kind: "room", amountMinor: "1234" }
          : { kind: "person", adultMinor: "1234", childBandAmountsMinor: ["0"] };
      expect(
        changeMealPlan(original, linked.id, {
          kind,
          basis,
          amounts: basis === "room" ? ["12.34"] : ["12.34", "0"],
        }),
      ).toEqual({ ...original, offers: [root, { ...linked, meal: { kind, charge } }] });
    }
  }
  expect(
    changeMealPlan(original, linked.id, { kind: "room_only", basis: "room", amounts: [] }).offers[1]
      .meal,
  ).toEqual({ kind: "room_only", charge: { kind: "room", amountMinor: "0" } });
  for (const entry of [
    { kind: "other", basis: "room", amounts: ["0"] },
    { kind: "breakfast", basis: "unknown", amounts: ["0"] },
    { kind: "room_only", basis: "person", amounts: [] },
    { kind: "room_only", basis: "room", amounts: ["10"] },
    { kind: "breakfast", basis: "person", amounts: ["1"] },
    { kind: "breakfast", basis: "room", amounts: ["-1"] },
    { kind: "breakfast", basis: "room", amounts: ["1.001"] },
  ])
    expect(() => changeMealPlan(original, linked.id, entry)).toThrow();
  expect(() =>
    changeMealPlan(original, "missing", { kind: "room_only", basis: "room", amounts: [] }),
  ).toThrow();
  expect(
    changeMealPlan({ ...original, currency: "KWD" }, linked.id, {
      kind: "breakfast",
      basis: "room",
      amounts: ["1.234"],
    }).offers[1].meal.charge,
  ).toEqual({ kind: "room", amountMinor: "1234" });
});
it("requires fresh meal-plan confirmation, blocks competing edits, and reviews the saved plan", async () => {
  await mount();
  await touch();
  await click("Edit meal charges");
  expect(button("Change meal plan").props.disabled).toBe(true);
  await click("Change meal plan");
  expect(button("Apply meal plan")).toBeUndefined();
  await click("Cancel meal charges");
  await click("Change meal plan");
  const checkbox = onlyCheckbox;
  const plan = () => view.root.findByProps({ "aria-label": "Meal plan for Room 1 Offer 1" });
  const amount = () =>
    view.root.findByProps({ "aria-label": "New meal charge Per room for Room 1 Offer 1" });
  expect(checkbox().props.checked).toBe(false);
  expect(button("Apply meal plan").props.disabled).toBe(true);
  expect(button("Edit meal charges").props.disabled).toBe(true);
  expect(button("Edit child charges").props.disabled).toBe(true);
  expect(input().props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  const warn = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  warn(event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(
    view.root.findByProps({ "aria-label": "New meal charge Per adult for Room 1 Offer 1" }).props
      .value,
  ).toBe("12.00");
  await click("Cancel meal plan");
  expect(button("Save and publish").props.disabled).toBe(false);
  await click("Change meal plan");
  await act(async () => checkbox().props.onChange({ target: { checked: true } }));
  await act(async () => plan().props.onChange({ target: { value: "half_board" } }));
  expect(checkbox().props.checked).toBe(false);
  expect(
    view.root.findByProps({ "aria-label": "New meal charge Per adult for Room 1 Offer 1" }).props
      .value,
  ).toBe("");
  await act(async () =>
    view.root
      .findByProps({ "aria-label": "Meal charging basis for Room 1 Offer 1" })
      .props.onChange({ target: { value: "room" } }),
  );
  expect(amount().props.value).toBe("");
  await act(async () => checkbox().props.onChange({ target: { checked: true } }));
  await click("Apply meal plan");
  expect(client.prepare).not.toHaveBeenCalled();
  await act(async () => amount().props.onChange({ target: { value: "20" } }));
  expect(checkbox().props.checked).toBe(false);
  await act(async () => checkbox().props.onChange({ target: { checked: true } }));
  await click("Apply meal plan");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].meal).toEqual({
    kind: "half_board",
    charge: { kind: "room", amountMinor: "2000" },
  });
  expect(button("Change meal plan").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  await reload();
  await click("Change meal plan");
  await act(async () => plan().props.onChange({ target: { value: "room_only" } }));
  expect(
    view.root
      .findAllByType("input")
      .filter((node) => String(node.props["aria-label"]).startsWith("New meal charge")),
  ).toHaveLength(0);
  await act(async () => checkbox().props.onChange({ target: { checked: true } }));
  await click("Apply meal plan");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].meal).toEqual({
    kind: "room_only",
    charge: { kind: "room", amountMinor: "0" },
  });
});

it("rejects cyclic parent choices and preserves every field except the linked parent", () => {
  const room = snapshot.rooms[0],
    root = room.offers[0];
  const linked = {
    ...root,
    id: "linked",
    price: {
      kind: "linked" as const,
      parentId: root.id,
      adjustment: { kind: "percentage" as const, basisPoints: -1000 },
      dateOverrides: [
        { date: "2026-12-25", price: { mode: "flat" as const, amountMinor: "15000" } },
      ],
    },
    restrictions: { kind: "inherit" as const },
  };
  const middle = { ...linked, id: "middle", price: { ...linked.price, parentId: linked.id } };
  const leaf = { ...linked, id: "leaf", price: { ...linked.price, parentId: middle.id } };
  const alternate = { ...root, id: "alternate" };
  const original = { ...room, offers: [root, linked, middle, leaf, alternate] };
  expect(linkedParentChoices(original, linked.id).map((value) => value.id)).toEqual([
    root.id,
    alternate.id,
  ]);
  expect(changeLinkedParent(original, linked.id, alternate.id)).toEqual({
    ...original,
    offers: [
      root,
      { ...linked, price: { ...linked.price, parentId: alternate.id } },
      middle,
      leaf,
      alternate,
    ],
  });
  for (const id of [linked.id, middle.id, leaf.id, "outside"])
    expect(() => changeLinkedParent(original, linked.id, id)).toThrow("circular");
  expect(() => changeLinkedParent(original, root.id, alternate.id)).toThrow("linked");
  const own = {
    ...original,
    offers: original.offers.map((offer) =>
      offer.id === linked.id ? { ...offer, restrictions: root.restrictions } : offer,
    ),
  };
  expect(changeLinkedParent(own, linked.id, alternate.id).offers[1].restrictions).toEqual(
    root.restrictions,
  );
  expect(linkedParentChoices({ ...room, offers: [root, linked] }, linked.id)).toEqual([root]);
});
it("confirms parent changes with exclusive pending guards and fresh saved review", async () => {
  const room = snapshot.rooms[0],
    root = room.offers[0];
  const linked = {
    ...root,
    id: "linked",
    price: {
      kind: "linked",
      parentId: root.id,
      adjustment: { kind: "percentage", basisPoints: -1000 },
      dateOverrides: [],
    },
    restrictions: { kind: "inherit" },
  };
  client.read.mockResolvedValueOnce({
    ...snapshot,
    revision: 1,
    sources,
    stale: false,
    rooms: [{ ...room, offers: [root, linked, { ...root, id: "alternate" }] }],
  });
  await mount();
  await touch();
  await click("Edit child charges");
  expect(button("Change parent rate").props.disabled).toBe(true);
  await click("Change parent rate");
  expect(button("Apply parent rate")).toBeUndefined();
  await click("Cancel child charges");
  await click("Change parent rate");
  const checkbox = onlyCheckbox;
  const parent = () => view.root.findByProps({ "aria-label": "Parent rate for Room 1 Offer 2" });
  expect(parent().props.value).toBe(root.id);
  expect(checkbox().props.checked).toBe(false);
  expect(button("Edit linked adjustment").props.disabled).toBe(true);
  expect(button("Use own stay rules").props.disabled).toBe(true);
  expect(button("Change meal plan").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(input().props.disabled).toBe(true);
  const warn = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  warn(event);
  expect(event.preventDefault).toHaveBeenCalled();
  await act(async () => checkbox().props.onChange({ target: { checked: true } }));
  expect(button("Apply parent rate").props.disabled).toBe(true);
  await act(async () => parent().props.onChange({ target: { value: "alternate" } }));
  expect(checkbox().props.checked).toBe(false);
  await click("Cancel parent rate");
  expect(button("Save and publish").props.disabled).toBe(false);
  await click("Change parent rate");
  expect(parent().props.value).toBe(root.id);
  await act(async () => parent().props.onChange({ target: { value: "alternate" } }));
  await act(async () => checkbox().props.onChange({ target: { checked: true } }));
  await click("Apply parent rate");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[1].price).toMatchObject({ parentId: "alternate" });
  expect(saved.snapshot.rooms[0].offers[1].restrictions).toEqual({ kind: "inherit" });
  expect(button("Change parent rate").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});

it("builds a linked room-only offer with explicit terms and rejects invalid settings", () => {
  const id = "61000000-0000-4000-8000-000000000004",
    room = { ...snapshot.rooms[0], roomTypeId: id };
  const values = {
    parent: room.offers[0].id,
    kind: "percentage",
    value: "-10.25",
    cancellation: "non_refundable",
    deadline: "",
    payment: "full",
    methods: ["card"] as ("card" | "pay_at_property")[],
  };
  const created = linkedOfferInput(room, id, values);
  expect(created.configuration.offers[0]).toEqual(room.offers[0]);
  expect(created.configuration.children).toEqual(room.children);
  expect(created.configuration.offers[1]).toEqual({
    id,
    termsRevision: id,
    meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
    restrictions: { kind: "inherit" },
    price: {
      kind: "linked",
      parentId: "flex",
      adjustment: { kind: "percentage", basisPoints: -1025 },
      dateOverrides: [],
    },
  });
  expect(created.terms).toMatchObject({
    expectedRevision: null,
    cancellation: { kind: "non_refundable" },
    payment: { kind: "full", acceptedMethods: ["card"] },
  });
  expect(
    linkedOfferInput(room, id, {
      ...values,
      kind: "fixed",
      value: "-90071992547409.93",
      cancellation: "flexible",
      deadline: "365",
    }).configuration.offers[1].price,
  ).toMatchObject({ adjustment: { deltaMinor: "-9007199254740993" } });
  expect(
    linkedOfferInput(room, id, { ...values, cancellation: "flexible", deadline: "0" }).terms
      .cancellation,
  ).toMatchObject({ terms: { freeCancellationDeadlineDays: 0 } });
  for (const patch of [
    { parent: "outside" },
    { kind: "other" },
    { value: "-100.01" },
    { value: "1.001" },
    { cancellation: "" },
    { payment: "" },
    { methods: [] },
    { cancellation: "flexible", deadline: "366" },
    { cancellation: "flexible", deadline: "1.5" },
  ])
    expect(() => linkedOfferInput(room, id, { ...values, ...patch })).toThrow();
  expect(() => linkedOfferInput(created.configuration, id, values)).toThrow();
});
it("appends linked offers preserving prices, revisions and accepted-policy retry identity", async () => {
  const id = "61000000-0000-4000-8000-000000000004",
    offerId = "61000000-0000-4000-8000-000000000005",
    room = { ...snapshot.rooms[0], roomTypeId: id };
  client.read.mockResolvedValueOnce({
    ...snapshot,
    rooms: [room],
    revision: 7,
    sources,
    stale: false,
  });
  const policy = vi.fn().mockResolvedValue({ revision: offerId });
  client.termsAction.mockReturnValue(policy);
  await mount(id);
  await touch();
  await act(async () => input().props.onChange({ target: { value: "155.25" } }));
  await addOption("Based on another option");
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(button("Change meal plan").props.disabled).toBe(true);
  const next = linkedOfferInput(room, offerId, {
    parent: "flex",
    kind: "percentage",
    value: "-10",
    cancellation: "non_refundable",
    deadline: "",
    payment: "full",
    methods: ["card"],
  });
  client.prepare.mockRejectedValueOnce(new Error("lost preparation"));
  await act(async () => view.root.findByType(NewLinkedOffer).props.onCreate(next));
  expect(client.termsAction).not.toHaveBeenCalled();
  await click("Save and publish");
  expect(button("Reload pricing").props.disabled).toBe(true);
  const attempted = client.prepare.mock.calls.at(-1)![0];
  await click("Retry last action");
  expect(policy).toHaveBeenCalledOnce();
  expect(client.termsAction).toHaveBeenCalledOnce();
  expect(client.prepare.mock.calls.at(-1)![0]).toEqual(attempted);
  expect(client.saveDraft).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledOnce();
  expect(saved.revision).toBe(2);
  expect(saved.baseRevision).toBe(7);
  expect(saved.snapshot.rooms).toHaveLength(1);
  expect(saved.snapshot.rooms[0].revision).toBe(8);
  expect(saved.snapshot.rooms[0].offers).toHaveLength(2);
  expect(saved.snapshot.rooms[0].offers[0]).toEqual(
    editedSnapshot({ ...snapshot, rooms: [room] }, { "0:0:0": "155.25" }).rooms[0].offers[0],
  );
  expect(saved.snapshot.rooms[0].offers[1].id).toBe(offerId);
  expect(saved.snapshot.rooms[0].offers[1].termsRevision).toBe(offerId);
  expect(button("Your own option").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});
it("cancels new-offer setup without writes and protects pending entries and leaving", async () => {
  await mount();
  await touch();
  await click("Edit child charges");
  expect(button("Your own option").props.disabled).toBe(true);
  await addOption("Based on another option");
  expect(button("Cancel new offer")).toBeUndefined();
  await click("Cancel child charges");
  await addOption("Based on another option");
  expect(input().props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  const warn = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  warn(event);
  expect(event.preventDefault).toHaveBeenCalled();
  await click("Cancel new offer");
  expect(client.termsAction).not.toHaveBeenCalled();
  expect(button("Save and publish").props.disabled).toBe(false);
});

it.each(["flat", "occupancy", "per_person", "included_guests"])(
  "creates an independent %s offer without replacing existing child bands or offers",
  (mode) => {
    const id = "61000000-0000-4000-8000-000000000004",
      offerId = "61000000-0000-4000-8000-000000000005";
    const original = snapshot.rooms[0],
      root = {
        ...original.offers[0],
        meal: { kind: "room_only" as const, charge: { kind: "room" as const, amountMinor: "0" } },
      };
    const existing = {
      ...original,
      roomTypeId: id,
      children: {
        adultFromAge: 12,
        bands: [
          { fromAge: 0, throughAge: 2, nightlyMinor: "0", countsTowardCapacity: false },
          { fromAge: 3, throughAge: 11, nightlyMinor: "2500", countsTowardCapacity: true },
        ],
      },
      offers: [
        root,
        {
          ...root,
          id: "linked",
          price: {
            kind: "linked" as const,
            parentId: root.id,
            adjustment: { kind: "percentage" as const, basisPoints: -1000 },
            dateOverrides: [],
          },
          restrictions: { kind: "inherit" as const },
        },
      ],
    };
    const setupRoom = { roomTypeId: id, name: "Double", capacity: existing.capacity };
    const values = {
      mode,
      occupancy: ["100", "130"],
      included: {
        adults: "1",
        adjustments: [
          { kind: "fixed", value: "0" },
          { kind: "fixed", value: "25" },
        ],
      },
      methods: ["card"] as ("card" | "pay_at_property")[],
      room: id,
      currency: "EUR",
      base: "130",
      adultAge: "",
      childPrice: "",
      countChildren: "",
      minimum: "2",
      maximum: "10",
      cancellation: "non_refundable",
      freeDays: "",
      payment: "full",
    };
    const next = firstPricingInput(existing.propertyId, setupRoom, offerId, values, existing);
    expect(next.configuration.children).toEqual(existing.children);
    expect(next.configuration.offers.slice(0, 2)).toEqual(existing.offers);
    expect(next.configuration.capacity).toEqual(existing.capacity);
    expect(next.configuration.offers[2]).toMatchObject({
      price: {
        kind: "independent",
        calendar: { base: { mode }, months: [], seasons: [], weekdays: [], dates: [] },
      },
      restrictions: { kind: "own", rules: { minArrivalNights: 2, maxStayNights: 10 } },
    });
    expect(() =>
      firstPricingInput(
        existing.propertyId,
        setupRoom,
        offerId,
        { ...values, currency: "USD" },
        existing,
      ),
    ).toThrow("existing room");
    expect(() =>
      firstPricingInput(
        existing.propertyId,
        setupRoom,
        offerId,
        { ...values, mode: "occupancy", occupancy: ["100"] },
        existing,
      ),
    ).toThrow();
    expect(() =>
      firstPricingInput(
        existing.propertyId,
        setupRoom,
        offerId,
        { ...values, mode: "included_guests", included: { adults: "1", adjustments: [] } },
        existing,
      ),
    ).toThrow();
  },
);
it("creates an independent offer through fixed-room setup and retains policy retry and saved review", async () => {
  const id = "61000000-0000-4000-8000-000000000004",
    offerId = "61000000-0000-4000-8000-000000000005",
    room = { ...snapshot.rooms[0], roomTypeId: id };
  client.read.mockResolvedValueOnce({
    ...snapshot,
    rooms: [room],
    revision: 7,
    sources,
    stale: false,
  });
  const policy = vi.fn().mockResolvedValue({ revision: offerId });
  client.termsAction.mockReturnValue(policy);
  await mount(id);
  await touch();
  await click("Edit child charges");
  expect(button("Your own option").props.disabled).toBe(true);
  await click("Cancel child charges");
  await addOption("With its own prices");
  expect(view.root.findByType(FirstPricingSetup).props.existingRoom).toMatchObject({
    roomTypeId: id,
  });
  expect(view.root.findAllByProps({ "aria-label": "Room type" })).toHaveLength(0);
  expect(
    view.root.findAllByProps({ "aria-label": "Price per child per night (0 is allowed)" }),
  ).toHaveLength(0);
  expect(
    view.root.findByProps({ "aria-label": "Currency code (for example EUR)" }).props.disabled,
  ).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(button("Change meal plan").props.disabled).toBe(true);
  await click("Cancel new offer");
  expect(client.termsAction).not.toHaveBeenCalled();
  expect(button("Save and publish").props.disabled).toBe(false);
  await act(async () => input().props.onChange({ target: { value: "155.25" } }));
  await addOption("With its own prices");
  const next = firstPricingInput(
    room.propertyId,
    { roomTypeId: id, name: "Double", capacity: room.capacity },
    offerId,
    {
      mode: "flat",
      occupancy: [],
      included: { adults: "", adjustments: [] },
      methods: ["card"],
      room: id,
      currency: "EUR",
      base: "200",
      adultAge: "",
      childPrice: "",
      countChildren: "",
      minimum: "2",
      maximum: "",
      cancellation: "non_refundable",
      freeDays: "",
      payment: "full",
    },
    room,
  );
  client.prepare.mockRejectedValueOnce(new Error("lost preparation"));
  await act(async () => view.root.findByType(FirstPricingSetup).props.onCreate(next));
  expect(client.termsAction).not.toHaveBeenCalled();
  await click("Save and publish");
  const attempted = client.prepare.mock.calls.at(-1)![0];
  await click("Retry last action");
  expect(policy).toHaveBeenCalledOnce();
  expect(client.prepare.mock.calls.at(-1)![0]).toEqual(attempted);
  expect(publish).toHaveBeenCalledOnce();
  expect(saved.baseRevision).toBe(7);
  expect(saved.snapshot.rooms[0].revision).toBe(8);
  expect(saved.snapshot.rooms[0].children).toEqual(room.children);
  expect(saved.snapshot.rooms[0].offers[0].termsRevision).toBe(room.offers[0].termsRevision);
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: { base: { amountMinor: "15525" } },
  });
  expect(saved.snapshot.rooms[0].offers[1].price).toMatchObject({
    kind: "independent",
    calendar: { base: { amountMinor: "20000" } },
  });
  expect(button("Your own option").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
});

function includedRoom() {
  const room = structuredClone(snapshot.rooms[0]),
    offer = room.offers[0];
  const base = {
    mode: "included_guests" as const,
    baseGuests: 2,
    baseMinor: "13000",
    adjustments: [
      { kind: "fixed" as const, deltaMinor: "-3000" },
      { kind: "fixed" as const, deltaMinor: "0" },
      { kind: "percentage" as const, basisPoints: 1925 },
    ],
  };
  return {
    ...room,
    capacity: { ...room.capacity, total: 3, adults: 3 },
    offers: [
      {
        ...offer,
        price: {
          kind: "independent" as const,
          calendar: {
            base,
            months: [{ month: 8, price: { ...base, baseMinor: "20000" } }],
            seasons: [
              {
                from: "12-01",
                through: "12-31",
                name: "Winter",
                tier: "high",
                price: { ...base, baseMinor: "25000" },
              },
            ],
            weekdays: [{ day: 0, adjustment: { kind: "fixed" as const, deltaMinor: "100" } }],
            dates: [{ date: "2026-12-25", price: { mode: "flat" as const, amountMinor: "30000" } }],
          },
        },
      },
      {
        ...offer,
        id: "linked",
        price: {
          kind: "linked" as const,
          parentId: offer.id,
          adjustment: { kind: "percentage" as const, basisPoints: -1000 },
          dateOverrides: [],
        },
        restrictions: { kind: "inherit" as const },
      },
      { ...offer, id: "other" },
    ],
  };
}
it("replaces included base settings exactly while preserving every other price and policy", () => {
  const room = includedRoom(),
    original = structuredClone(room);
  const originalPrice = room.offers[0].price;
  if (originalPrice.kind !== "independent") throw new Error("fixture");
  const entry = {
    adults: "2",
    adjustments: [
      { kind: "fixed", value: "-30" },
      { kind: "fixed", value: "0" },
      { kind: "fixed", value: "+25" },
    ],
  };
  const changed = changeIncludedAdjustments(room, "flex", entry, "130");
  expect(changed).toEqual({
    ...room,
    offers: [
      {
        ...room.offers[0],
        price: {
          ...room.offers[0].price,
          calendar: {
            ...originalPrice.calendar,
            base: {
              mode: "included_guests",
              baseGuests: 2,
              baseMinor: "13000",
              adjustments: [
                { kind: "fixed", deltaMinor: "-3000" },
                { kind: "fixed", deltaMinor: "0" },
                { kind: "fixed", deltaMinor: "2500" },
              ],
            },
          },
        },
      },
      ...room.offers.slice(1),
    ],
  });
  expect(
    changeIncludedAdjustments(
      room,
      "flex",
      {
        adults: "1",
        adjustments: [
          { kind: "fixed", value: "0" },
          { kind: "percentage", value: "+10.25" },
          { kind: "percentage", value: "0" },
        ],
      },
      "150.25",
    ).offers[0].price,
  ).toMatchObject({
    calendar: {
      base: {
        baseGuests: 1,
        baseMinor: "15025",
        adjustments: [
          { kind: "fixed", deltaMinor: "0" },
          { kind: "percentage", basisPoints: 1025 },
          { kind: "percentage", basisPoints: 0 },
        ],
      },
    },
  });
  for (const value of ["", "1e2", "NaN", "1.001", "-130", "10000000000000000"])
    expect(() =>
      changeIncludedAdjustments(
        room,
        "flex",
        { ...entry, adjustments: [{ kind: "fixed", value }, ...entry.adjustments.slice(1)] },
        "130",
      ),
    ).toThrow();
  for (const adults of ["", "0", "4", "1.5"])
    expect(() => changeIncludedAdjustments(room, "flex", { ...entry, adults }, "130")).toThrow();
  expect(() =>
    changeIncludedAdjustments(room, "flex", { ...entry, adjustments: [] }, "130"),
  ).toThrow();
  expect(() =>
    changeIncludedAdjustments(
      room,
      "flex",
      {
        ...entry,
        adjustments: [{ kind: "percentage", value: "-100" }, ...entry.adjustments.slice(1)],
      },
      "130",
    ),
  ).toThrow();
  expect(() => changeIncludedAdjustments(room, "flex", entry, "bad")).toThrow();
  for (const id of ["missing", "linked", "other"])
    expect(() => changeIncludedAdjustments(room, id, entry, "130")).toThrow();
  expect(room).toEqual(original);
});
it("prefills included settings, guards pending edits and saves current bases through review and reload", async () => {
  const room = includedRoom();
  const originalPrice = room.offers[0].price;
  if (originalPrice.kind !== "independent") throw new Error("fixture");
  client.read.mockResolvedValueOnce({
    ...snapshot,
    rooms: [room],
    revision: 7,
    sources,
    stale: false,
  });
  await mount();
  await touch();
  const field = (label: string) => view.root.findByProps({ "aria-label": label });
  const set = async (label: string, value: string) => {
    await act(async () => field(label).props.onChange({ target: { value } }));
  };
  expect(
    view.root
      .findAllByType("button")
      .filter((node) => node.children.join("") === "Edit included-adult adjustments"),
  ).toHaveLength(1);
  await click("Edit stay rules");
  expect(button("Edit included-adult adjustments").props.disabled).toBe(true);
  await click("Cancel stay-rule edit");
  await click("Edit included-adult adjustments");
  expect(field("Adults included in the base price").props.value).toBe("2");
  expect(field("Adjustment for 1 adult").props.value).toBe("-30.00");
  expect(field("Adjustment for 3 adults").props.value).toBe("19.25");
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(input().props.disabled).toBe(true);
  expect(button("Your own option").props.disabled).toBe(true);
  expect(button("Change meal plan").props.disabled).toBe(true);
  expect(button("Edit stay rules").props.disabled).toBe(true);
  const warn = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  warn(event);
  expect(event.preventDefault).toHaveBeenCalled();
  await set("Adjustment for 1 adult", "-200");
  await click("Apply included-adult adjustments");
  expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(1);
  await click("Cancel included-adult adjustments");
  expect(button("Save and publish").props.disabled).toBe(false);
  expect(client.saveDraft).not.toHaveBeenCalled();
  await set("Room 1 Offer 1 2 adults included", "150.25");
  await set("Room 1 Offer 3 Per room", "199.99");
  await click("Edit included-adult adjustments");
  expect(JSON.stringify(view.toJSON())).toContain("150.25");
  await set("Adults included in the base price", "1");
  expect(field("Adjustment for 2 adults").props.value).toBe("");
  expect(field("Adjustment for 3 adults").props.value).toBe("");
  await click("Apply included-adult adjustments");
  expect(button("Save and publish").props.disabled).toBe(true);
  await set("Adjustment type for 2 adults", "percentage");
  await set("Adjustment for 2 adults", "10.25");
  await set("Adjustment type for 3 adults", "fixed");
  await set("Adjustment for 3 adults", "25");
  await click("Apply included-adult adjustments");
  await click("Save and publish");
  expect(saved).toMatchObject({ revision: 2, baseRevision: 7 });
  expect(saved.snapshot.rooms[0].revision).toBe(8);
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: {
      base: {
        baseGuests: 1,
        baseMinor: "15025",
        adjustments: [
          { kind: "fixed", deltaMinor: "0" },
          { kind: "percentage", basisPoints: 1025 },
          { kind: "fixed", deltaMinor: "2500" },
        ],
      },
      months: originalPrice.calendar.months,
    },
  });
  expect(saved.snapshot.rooms[0].offers[2].price).toMatchObject({
    calendar: { base: { amountMinor: "19999" } },
  });
  expect(client.termsAction).not.toHaveBeenCalled();
  expect(button("Edit included-adult adjustments").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  client.read.mockResolvedValueOnce({ ...saved.snapshot, revision: 8, sources, stale: false });
  await reload();
  await click("Edit included-adult adjustments");
  expect(field("Adults included in the base price").props.value).toBe("1");
  expect(field("Adjustment for 2 adults").props.value).toBe("10.25");
});

it("replaces monthly amounts in all modes while retaining each month's own settings", () => {
  const room = snapshot.rooms[0],
    offer = room.offers[0];
  if (offer.price.kind !== "independent") throw new Error("fixture");
  const bases = [
    { mode: "flat" as const, amountMinor: "10000" },
    { mode: "occupancy" as const, amountsMinor: ["10000", "13000"] },
    { mode: "per_person" as const, unitMinor: "6000" },
    {
      mode: "included_guests" as const,
      baseMinor: "13000",
      baseGuests: 2,
      adjustments: [
        { kind: "fixed" as const, deltaMinor: "-3000" },
        { kind: "fixed" as const, deltaMinor: "0" },
      ],
    },
  ];
  for (const base of bases) {
    const basePrice =
      base.mode === "included_guests"
        ? {
            ...base,
            baseGuests: 1,
            adjustments: [
              { kind: "fixed" as const, deltaMinor: "0" },
              { kind: "percentage" as const, basisPoints: 1000 },
            ],
          }
        : base;
    const configured = {
      ...room,
      offers: [
        {
          ...offer,
          price: {
            ...offer.price,
            calendar: {
              ...offer.price.calendar,
              base: basePrice,
              months: [
                { month: 8, price: base },
                { month: 9, price: basePrice },
              ],
            },
          },
        },
      ],
    };
    const original = structuredClone(configured),
      amounts = base.mode === "occupancy" ? ["160.25", "190.99"] : ["190.99"];
    const expected =
      base.mode === "flat"
        ? { ...base, amountMinor: "19099" }
        : base.mode === "per_person"
          ? { ...base, unitMinor: "19099" }
          : base.mode === "occupancy"
            ? { ...base, amountsMinor: ["16025", "19099"] }
            : { ...base, baseMinor: "19099" };
    expect(changeMonthPrice(configured, "flex", "8", amounts, true)).toEqual({
      ...configured,
      offers: [
        {
          ...configured.offers[0],
          price: {
            ...configured.offers[0].price,
            calendar: {
              ...configured.offers[0].price.calendar,
              months: [
                { month: 8, price: expected },
                { month: 9, price: basePrice },
              ],
            },
          },
        },
      ],
    });
    expect(() => changeMonthPrice(configured, "flex", "7", amounts, true)).toThrow("existing");
    expect(() => changeMonthPrice(configured, "flex", "8", null, true)).toThrow("existing");
    expect(() => changeMonthPrice(configured, "flex", "8", amounts)).toThrow("Edit");
    for (const invalid of [[], [""], ["0"], ["1.001"]])
      expect(() => changeMonthPrice(configured, "flex", "8", invalid, true)).toThrow();
    if (base.mode === "included_guests")
      expect(() => changeMonthPrice(configured, "flex", "8", ["20"], true)).toThrow();
    expect(configured).toEqual(original);
  }
});
it("prefills monthly edits, protects pending values and saves the same monthly settings for review and reload", async () => {
  const original = includedRoom();
  const room = changeIncludedAdjustments(
    original,
    "flex",
    {
      adults: "1",
      adjustments: [
        { kind: "fixed", value: "0" },
        { kind: "fixed", value: "10" },
        { kind: "fixed", value: "20" },
      ],
    },
    "130",
  );
  client.read.mockResolvedValueOnce({
    ...snapshot,
    rooms: [room],
    revision: 7,
    sources,
    stale: false,
  });
  await mount();
  await touch();
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  await fill("Month for Room 1 Offer 1", "9");
  expect(button("Edit monthly price").props.disabled).toBe(true);
  await click("Edit monthly price");
  expect(button("Apply monthly price")).toBeUndefined();
  await click("Cancel month entry");
  await click("Edit monthly price");
  expect(field("Month for Room 1 Offer 1").props.value).toBe("8");
  expect(field("Month for Room 1 Offer 1").props.disabled).toBe(true);
  expect(field("Monthly 2 adults included for Room 1 Offer 1").props.value).toBe("200.00");
  expect(button("Clear monthly price").props.disabled).toBe(true);
  expect(button("Edit monthly price").props.disabled).toBe(true);
  await click("Clear monthly price");
  expect(button("Apply monthly price")).toBeDefined();
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(button("Edit included-adult adjustments").props.disabled).toBe(true);
  await fill("Monthly 2 adults included for Room 1 Offer 1", "20");
  await click("Apply monthly price");
  expect(JSON.stringify(view.toJSON())).toContain("Every adjusted room price must be positive");
  await click("Cancel month entry");
  expect(button("Save and publish").props.disabled).toBe(false);
  expect(client.saveDraft).not.toHaveBeenCalled();
  await fill("Room 1 Offer 1 1 adult included", "150.25");
  await click("Edit monthly price");
  expect(field("Monthly 2 adults included for Room 1 Offer 1").props.value).toBe("200.00");
  await fill("Monthly 2 adults included for Room 1 Offer 1", "210.25");
  await click("Apply monthly price");
  await click("Save and publish");
  expect(saved).toMatchObject({ baseRevision: 7, revision: 2 });
  expect(saved.snapshot.rooms[0].revision).toBe(8);
  const price = saved.snapshot.rooms[0].offers[0].price,
    source = room.offers[0].price;
  if (price.kind !== "independent" || source.kind !== "independent") throw new Error("fixture");
  expect(price.calendar.months).toEqual([
    {
      ...source.calendar.months[0],
      price: { ...source.calendar.months[0].price, baseMinor: "21025" },
    },
  ]);
  expect(price.calendar.base).toMatchObject({ baseGuests: 1, baseMinor: "15025" });
  expect(price.calendar.seasons).toEqual(source.calendar.seasons);
  expect(price.calendar.dates).toEqual(source.calendar.dates);
  expect(saved.snapshot.rooms[0].offers.slice(1)).toEqual(room.offers.slice(1));
  expect(button("Edit monthly price").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  client.read.mockResolvedValueOnce({ ...saved.snapshot, revision: 8, sources, stale: false });
  await reload();
  await click("Edit monthly price");
  expect(field("Monthly 2 adults included for Room 1 Offer 1").props.value).toBe("210.25");
});

it("edits seasonal prices in all four modes without replacing the season's settings", () => {
  const room = snapshot.rooms[0],
    offer = room.offers[0];
  if (offer.price.kind !== "independent") throw new Error("fixture");
  const winter = { name: "Winter", tier: "High", from: "12-15", through: "01-10" },
    leap = { name: "Leap", tier: "", from: "02-29", through: "02-29" };
  const bases = [
    { mode: "flat" as const, amountMinor: "10000" },
    { mode: "occupancy" as const, amountsMinor: ["10000", "13000"] },
    { mode: "per_person" as const, unitMinor: "6000" },
    {
      mode: "included_guests" as const,
      baseMinor: "13000",
      baseGuests: 2,
      adjustments: [
        { kind: "fixed" as const, deltaMinor: "-3000" },
        { kind: "fixed" as const, deltaMinor: "0" },
      ],
    },
  ];
  for (const base of bases) {
    const different =
      base.mode === "included_guests"
        ? {
            ...base,
            baseGuests: 1,
            adjustments: [
              { kind: "fixed" as const, deltaMinor: "0" },
              { kind: "fixed" as const, deltaMinor: "2000" },
            ],
          }
        : base;
    const calendar = {
      ...offer.price.calendar,
      base: different,
      months: [{ month: 8, price: different }],
      seasons: [
        { ...winter, price: base },
        { ...leap, price: different },
      ],
    };
    const configured = { ...room, offers: [{ ...offer, price: { ...offer.price, calendar } }] },
      original = structuredClone(calendar);
    const amounts = base.mode === "occupancy" ? ["160.25", "190.99"] : ["190.99"];
    const expected =
      base.mode === "flat"
        ? { ...base, amountMinor: "19099" }
        : base.mode === "per_person"
          ? { ...base, unitMinor: "19099" }
          : base.mode === "occupancy"
            ? { ...base, amountsMinor: ["16025", "19099"] }
            : { ...base, baseMinor: "19099" };
    expect(changeSeasonPrice(configured, "flex", winter, amounts, winter)).toEqual({
      ...configured,
      offers: [
        {
          ...configured.offers[0],
          price: {
            ...offer.price,
            calendar: {
              ...calendar,
              seasons: [
                { ...winter, price: expected },
                { ...leap, price: different },
              ],
            },
          },
        },
      ],
    });
    expect(
      changeSeasonPrice(configured, "flex", leap, amounts, leap).offers[0].price,
    ).toMatchObject({ calendar: { seasons: [{ ...winter, price: base }, { ...leap }] } });
    for (const changed of [
      { ...winter, name: "Other" },
      { ...winter, tier: "" },
      { ...winter, through: "01-11" },
    ])
      expect(() => changeSeasonPrice(configured, "flex", changed, amounts, changed)).toThrow(
        "existing",
      );
    for (const invalid of [null, [], [""], ["0"], ["1.001"], ["10000000000000000"]])
      expect(() => changeSeasonPrice(configured, "flex", winter, invalid, winter)).toThrow();
    if (base.mode === "included_guests")
      expect(() => changeSeasonPrice(configured, "flex", winter, ["20"], winter)).toThrow();
    expect(calendar).toEqual(original);
  }
});
it("prefills season edits, protects pending values and retains settings through save review and reload", async () => {
  const original = includedRoom();
  const room = changeIncludedAdjustments(
    original,
    "flex",
    {
      adults: "1",
      adjustments: [
        { kind: "fixed", value: "0" },
        { kind: "fixed", value: "10" },
        { kind: "fixed", value: "20" },
      ],
    },
    "130",
  );
  client.read.mockResolvedValueOnce({
    ...snapshot,
    rooms: [room],
    revision: 7,
    sources,
    stale: false,
  });
  await mount();
  await touch();
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  const bar = () =>
    view.root
      .findAllByType("button")
      .find((node) => String(node.props["aria-label"] ?? "").startsWith("Edit season Winter "))!;
  await openSeason("Winter");
  expect(field("Season price 2 adults included").props.value).toBe("250.00");
  for (const [name, value] of [
    ["Season name", "Winter"],
    ["Starts: day", "1"],
    ["Starts: month", "12"],
    ["Ends: day", "31"],
    ["Ends: month", "12"],
  ]) {
    expect(field(name).props.value).toBe(value);
    expect(field(name).props.disabled).toBe(false);
  }
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(button("Edit included-adult adjustments").props.disabled).toBe(true);
  const warn = vi
    .mocked(window.addEventListener)
    .mock.calls.filter(([name]) => name === "beforeunload")
    .at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  warn(event);
  expect(event.preventDefault).toHaveBeenCalled();
  await fill("Season price 2 adults included", "20");
  await seasonClick("Save season");
  expect(JSON.stringify(view.toJSON())).toContain("Every adjusted room price must be positive");
  await seasonClick("Cancel");
  expect(button("Save and publish").props.disabled).toBe(false);
  expect(client.saveDraft).not.toHaveBeenCalled();
  await fill("Room 1 Offer 1 1 adult included", "150.25");
  await openSeason("Winter");
  expect(field("Season price 2 adults included").props.value).toBe("250.00");
  await fill("Season price 2 adults included", "260.25");
  await seasonClick("Save season");
  await click("Save and publish");
  expect(saved).toMatchObject({ baseRevision: 7, revision: 2 });
  expect(saved.snapshot.rooms[0].revision).toBe(8);
  const price = saved.snapshot.rooms[0].offers[0].price,
    source = room.offers[0].price;
  if (price.kind !== "independent" || source.kind !== "independent") throw new Error("fixture");
  expect(price.calendar.seasons).toEqual([
    {
      ...source.calendar.seasons[0],
      price: { ...source.calendar.seasons[0].price, baseMinor: "26025" },
    },
  ]);
  expect(price.calendar.base).toMatchObject({ baseGuests: 1, baseMinor: "15025" });
  expect(price.calendar.months).toEqual(source.calendar.months);
  expect(price.calendar.dates).toEqual(source.calendar.dates);
  expect(saved.snapshot.rooms[0].offers.slice(1)).toEqual(room.offers.slice(1));
  expect(bar().props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  client.read.mockResolvedValueOnce({ ...saved.snapshot, revision: 8, sources, stale: false });
  await reload();
  await openSeason("Winter");
  expect(field("Season price 2 adults included").props.value).toBe("260.25");
});

it("moves only the original season and checks overlaps against other seasons", () => {
  const room = includedRoom(),
    offer = room.offers[0];
  if (offer.price.kind !== "independent") throw new Error("fixture");
  const original = offer.price.calendar.seasons[0],
    next = { name: "Holiday", tier: "", from: "12-15", through: "01-10" };
  const result = changeSeasonPrice(room, "flex", next, ["250"], original);
  expect(result).toEqual({
    ...room,
    offers: [
      {
        ...offer,
        price: {
          ...offer.price,
          calendar: { ...offer.price.calendar, seasons: [{ ...original, ...next }] },
        },
      },
      ...room.offers.slice(1),
    ],
  });
  for (const patch of [{ name: " " }, { from: "02-30" }, { through: "13-01" }])
    expect(() =>
      changeSeasonPrice(room, "flex", { ...next, ...patch }, ["250"], original),
    ).toThrow();
  const occupied = changeSeasonPrice(
    room,
    "flex",
    { name: "January", tier: "", from: "01-01", through: "01-31" },
    ["200"],
  );
  expect(() => changeSeasonPrice(occupied, "flex", next, ["250"], original)).toThrow(/overlapping/);
  expect(() =>
    changeSeasonPrice(room, "flex", next, ["250"], { ...original, name: "missing" }),
  ).toThrow("existing");
  expect(
    changeSeasonPrice(room, "flex", { ...next, from: "02-29", through: "02-29" }, ["250"], original)
      .offers[0].price,
  ).toMatchObject({ calendar: { seasons: [{ from: "02-29", through: "02-29" }] } });
});
it("keeps the season window open on an error and saves renamed dates with the original price", async () => {
  const room = includedRoom();
  client.read.mockResolvedValueOnce({
    ...snapshot,
    rooms: [room],
    revision: 7,
    sources,
    stale: false,
  });
  await mount();
  await touch();
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  await openSeason("Winter");
  for (const name of [
    "Season name",
    "Starts: day",
    "Starts: month",
    "Ends: day",
    "Ends: month",
    "Season price 2 adults included",
  ])
    await fill(name, "");
  expect(button("Save and publish").props.disabled).toBe(true);
  await seasonClick("Save season");
  expect(JSON.stringify(view.toJSON())).toContain("Enter a season name");
  expect(view.root.findAllByType(Modal)).toHaveLength(1);
  await seasonClick("Cancel");
  expect(button("Save and publish").props.disabled).toBe(false);
  await openSeason("Winter");
  expect(field("Season name").props.value).toBe("Winter");
  expect(field("Season price 2 adults included").props.value).toBe("250.00");
  for (const [name, value] of [
    ["Season name", "Holiday"],
    ["Starts: day", "15"],
    ["Starts: month", "12"],
    ["Ends: day", "10"],
    ["Ends: month", "1"],
  ])
    await fill(name, value);
  expect(field("Season price 2 adults included").props.value).toBe("250.00");
  await seasonClick("Save season");
  await click("Save and publish");
  expect(saved).toMatchObject({ revision: 2, baseRevision: 7 });
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: {
      seasons: [
        {
          name: "Holiday",
          tier: "high",
          from: "12-15",
          through: "01-10",
          price: { baseMinor: "25000", baseGuests: 2 },
        },
      ],
    },
  });
  expect(saved.snapshot.rooms[0].offers[0].restrictions).toEqual(room.offers[0].restrictions);
  expect(button("Save and publish").props.disabled).toBe(true);
  client.read.mockResolvedValueOnce({ ...saved.snapshot, revision: 8, sources, stale: false });
  await reload();
  await openSeason("Holiday");
  expect(field("Season name").props.value).toBe("Holiday");
  expect(field("Ends: day").props.value).toBe("10");
});

it.each([false, true])(
  "edits every stored date-price mode without flattening it (linked=%s)",
  (linked) => {
    const room = snapshot.rooms[0],
      root = room.offers[0];
    if (root.price.kind !== "independent") throw new Error("fixture");
    const bases = [
      { mode: "flat" as const, amountMinor: "10000" },
      { mode: "occupancy" as const, amountsMinor: ["10000", "13000"] },
      { mode: "per_person" as const, unitMinor: "6000" },
      {
        mode: "included_guests" as const,
        baseMinor: "13000",
        baseGuests: 2,
        adjustments: [
          { kind: "fixed" as const, deltaMinor: "-3000" },
          { kind: "fixed" as const, deltaMinor: "0" },
        ],
      },
    ];
    for (const base of bases) {
      const dates = [
        { date: "2026-12-25", price: base },
        { date: "2026-12-26", price: { mode: "flat" as const, amountMinor: "50000" } },
      ];
      const offer = {
        ...root,
        id: "target",
        price: linked
          ? {
              kind: "linked" as const,
              parentId: root.id,
              adjustment: { kind: "percentage" as const, basisPoints: -1000 },
              dateOverrides: dates,
            }
          : { ...root.price, calendar: { ...root.price.calendar, dates } },
      };
      const configured = { ...room, offers: [root, offer] },
        original = structuredClone(configured);
      const values = base.mode === "occupancy" ? ["150.25", "180.99"] : ["180.99"];
      const expected =
        base.mode === "flat"
          ? { ...base, amountMinor: "18099" }
          : base.mode === "per_person"
            ? { ...base, unitMinor: "18099" }
            : base.mode === "occupancy"
              ? { ...base, amountsMinor: ["15025", "18099"] }
              : { ...base, baseMinor: "18099" };
      const result = changeDatePrice(configured, "target", "2026-12-25", values),
        price = result.offers[1].price;
      expect(price.kind === "linked" ? price.dateOverrides : price.calendar.dates).toEqual([
        { ...dates[0], price: expected },
        dates[1],
      ]);
      expect(result.offers[0]).toEqual(root);
      expect(result.children).toEqual(room.children);
      expect(result.offers[1].restrictions).toEqual(offer.restrictions);
      for (const values of [[], [""], ["0"], ["1.001"], ["10000000000000000"]])
        expect(() => changeDatePrice(configured, "target", "2026-12-25", values)).toThrow();
      expect(() => changeDatePrice(configured, "target", "2026-12-24", ["100"])).toThrow(
        "existing",
      );
      if (base.mode === "included_guests")
        expect(() => changeDatePrice(configured, "target", "2026-12-25", ["20"])).toThrow();
      expect(configured).toEqual(original);
    }
  },
);
it("prefills a linked occupancy override and preserves pending guards through save review and reload", async () => {
  const room = snapshot.rooms[0],
    root = room.offers[0],
    dates = [
      {
        date: "2026-12-25",
        price: { mode: "occupancy" as const, amountsMinor: ["10000", "13000"] },
      },
    ];
  const offer = {
    ...root,
    id: "linked",
    price: {
      kind: "linked" as const,
      parentId: root.id,
      adjustment: { kind: "percentage" as const, basisPoints: -1000 },
      dateOverrides: dates,
    },
    restrictions: { kind: "inherit" as const },
  };
  client.read.mockResolvedValueOnce({
    ...snapshot,
    rooms: [{ ...room, offers: [root, offer] }],
    revision: 7,
    sources,
    stale: false,
  });
  await mount();
  await touch();
  const field = (name: string) => view.root.findByProps({ "aria-label": name });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  await fill("Override date for Room 1 Offer 2", "2026-");
  expect(button("Edit date price").props.disabled).toBe(true);
  await click("Edit date price");
  expect(button("Apply date price")).toBeUndefined();
  // The first editor has no pending input; cancel the pending linked editor directly.
  await act(async () =>
    view.root
      .findAllByType("button")
      .find((node) => node.children.join("") === "Cancel date entry")!
      .props.onClick(),
  );
  await click("Edit date price");
  expect(field("Override date for Room 1 Offer 2").props.disabled).toBe(true);
  expect(field("Date 2 adults for Room 1 Offer 2").props.value).toBe("130.00");
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(button("Clear date price").props.disabled).toBe(true);
  await click("Clear date price");
  await fill("Date 2 adults for Room 1 Offer 2", "");
  await click("Apply date price");
  expect(button("Save and publish").props.disabled).toBe(true);
  expect(view.root.findAllByProps({ role: "alert" }).length).toBeGreaterThan(0);
  await click("Cancel date entry");
  expect(button("Save and publish").props.disabled).toBe(false);
  expect(client.saveDraft).not.toHaveBeenCalled();
  await fill("Room 1 Offer 1 Per room", "150.25");
  await click("Edit date price");
  await fill("Date 2 adults for Room 1 Offer 2", "180.99");
  await click("Apply date price");
  await click("Save and publish");
  expect(saved).toMatchObject({ baseRevision: 7, revision: 2 });
  expect(saved.snapshot.rooms[0].offers[1].price).toEqual({
    ...offer.price,
    dateOverrides: [
      { date: "2026-12-25", price: { mode: "occupancy", amountsMinor: ["10000", "18099"] } },
    ],
  });
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: { base: { amountMinor: "15025" } },
  });
  expect(button("Edit date price").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  client.read.mockResolvedValueOnce({ ...saved.snapshot, revision: 8, sources, stale: false });
  await reload();
  await click("Edit date price");
  expect(field("Date 2 adults for Room 1 Offer 2").props.value).toBe("180.99");
});

it("replaces weekday adjustments exactly and preserves other rules", () => {
  const room = changeWeekdayPrice(
    changeWeekdayPrice(snapshot.rooms[0], "flex", "0", { kind: "fixed", value: "-30.25" }),
    "flex",
    "6",
    { kind: "percentage", value: "10" },
  );
  const offer = room.offers[0];
  if (offer.price.kind !== "independent") throw new Error("fixture");
  for (const [kind, value, expected] of [
    ["percentage", "-10.25", { kind: "percentage", basisPoints: -1025 }],
    ["fixed", "0", { kind: "fixed", deltaMinor: "0" }],
    ["fixed", "90071992547409.93", { kind: "fixed", deltaMinor: "9007199254740993" }],
  ] as const) {
    expect(changeWeekdayPrice(room, "flex", "0", { kind, value }, true)).toEqual({
      ...room,
      offers: [
        {
          ...offer,
          price: {
            ...offer.price,
            calendar: {
              ...offer.price.calendar,
              weekdays: [{ day: 0, adjustment: expected }, offer.price.calendar.weekdays[1]],
            },
          },
        },
      ],
    });
  }
  expect(() => changeWeekdayPrice(room, "flex", "1", { kind: "fixed", value: "1" }, true)).toThrow(
    "existing",
  );
  expect(() => changeWeekdayPrice(room, "flex", "0", null, true)).toThrow("existing");
  for (const value of ["", "1e2", "1.001", "-100.01", "NaN"])
    expect(() =>
      changeWeekdayPrice(room, "flex", "0", { kind: "percentage", value }, true),
    ).toThrow();
  expect(
    changeWeekdayPrice(
      { ...room, currency: "KWD" },
      "flex",
      "0",
      { kind: "fixed", value: "-1.234" },
      true,
    ).offers[0].price,
  ).toMatchObject({ calendar: { weekdays: [{ adjustment: { deltaMinor: "-1234" } }, {}] } });
});
it("prefills weekday edits and requires fresh saved review after replacing their type", async () => {
  const room = changeWeekdayPrice(snapshot.rooms[0], "flex", "0", {
    kind: "fixed",
    value: "-30.25",
  });
  client.read.mockResolvedValueOnce({
    ...snapshot,
    rooms: [room],
    revision: 7,
    sources,
    stale: false,
  });
  await mount();
  await touch();
  const field = (name: string) =>
    view.root.findByProps({ "aria-label": `${name} for Room 1 Offer 1` });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  await fill("Weekday", "1");
  expect(button("Edit weekday adjustment").props.disabled).toBe(true);
  await click("Edit weekday adjustment");
  expect(button("Apply weekday adjustment")).toBeUndefined();
  await click("Cancel weekday entry");
  await click("Edit weekday adjustment");
  expect(field("Weekday").props.value).toBe("0");
  expect(field("Weekday").props.disabled).toBe(true);
  expect(field("Weekday adjustment").props.value).toBe("-30.25");
  expect(button("Clear weekday adjustment").props.disabled).toBe(true);
  await click("Clear weekday adjustment");
  expect(button("Save and publish").props.disabled).toBe(true);
  await fill("Weekday adjustment type", "percentage");
  expect(field("Weekday adjustment").props.value).toBe("");
  await click("Apply weekday adjustment");
  expect(view.root.findAllByProps({ role: "alert" }).length).toBeGreaterThan(0);
  await click("Cancel weekday entry");
  expect(button("Save and publish").props.disabled).toBe(false);
  expect(client.saveDraft).not.toHaveBeenCalled();
  await act(async () => input().props.onChange({ target: { value: "150.25" } }));
  await click("Edit weekday adjustment");
  await fill("Weekday adjustment type", "percentage");
  await fill("Weekday adjustment", "-10.25");
  await click("Apply weekday adjustment");
  await click("Save and publish");
  expect(saved).toMatchObject({ revision: 2, baseRevision: 7 });
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: {
      base: { amountMinor: "15025" },
      weekdays: [{ day: 0, adjustment: { kind: "percentage", basisPoints: -1025 } }],
    },
  });
  expect(button("Edit weekday adjustment").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  client.read.mockResolvedValueOnce({ ...saved.snapshot, revision: 8, sources, stale: false });
  await reload();
  await click("Edit weekday adjustment");
  expect(field("Weekday adjustment").props.value).toBe("-10.25");
  expect(field("Weekday adjustment type").props.value).toBe("percentage");
});

it("creates final date prices using the displayed recurring mode and keeps other rules", () => {
  const room = snapshot.rooms[0],
    offer = room.offers[0];
  if (offer.price.kind !== "independent") throw new Error("fixture");
  const bases = [
    { mode: "flat" as const, amountMinor: "10000" },
    { mode: "occupancy" as const, amountsMinor: ["10000", "13000"] },
    { mode: "per_person" as const, unitMinor: "6000" },
    {
      mode: "included_guests" as const,
      baseMinor: "13000",
      baseGuests: 2,
      adjustments: [
        { kind: "fixed" as const, deltaMinor: "-3000" },
        { kind: "fixed" as const, deltaMinor: "0" },
      ],
    },
  ];
  for (const base of bases) {
    const configured = {
        ...room,
        offers: [
          { ...offer, price: { ...offer.price, calendar: { ...offer.price.calendar, base } } },
        ],
      },
      amounts = base.mode === "occupancy" ? ["150.25", "180.99"] : ["180.99"];
    const result = changeDatePrice(configured, "flex", "2026-12-25", amounts, true),
      price = result.offers[0].price;
    if (price.kind !== "independent") throw new Error("fixture");
    expect(price.calendar.base).toEqual(base);
    expect(price.calendar.dates[0].price.mode).toBe(base.mode);
    expect(result.children).toEqual(room.children);
    expect(result.offers[0].meal).toEqual(offer.meal);
    if (base.mode === "included_guests") {
      expect(price.calendar.dates[0].price).toEqual({ ...base, baseMinor: "18099" });
      expect(() => changeDatePrice(configured, "flex", "2026-12-25", ["20"], true)).toThrow();
    }
    if (base.mode === "occupancy") {
      expect(price.calendar.dates[0].price).toEqual({
        mode: "occupancy",
        amountsMinor: ["15025", "18099"],
      });
      expect(() => changeDatePrice(configured, "flex", "2026-12-25", ["150"], true)).toThrow();
    }
    if (base.mode === "per_person")
      expect(price.calendar.dates[0].price).toEqual({ mode: "per_person", unitMinor: "18099" });
    expect(() => changeDatePrice(result, "flex", "2026-12-25", amounts, true)).toThrow();
    expect(() => changeDatePrice(configured, "flex", "2026-02-30", amounts, true)).toThrow();
    expect(() => changeDatePrice(configured, "flex", "2026-12-25", [], true)).toThrow();
  }
  const linked = {
    ...offer,
    id: "linked",
    price: {
      kind: "linked" as const,
      parentId: offer.id,
      adjustment: { kind: "fixed" as const, deltaMinor: "0" },
      dateOverrides: [],
    },
  };
  expect(() =>
    changeDatePrice({ ...room, offers: [offer, linked] }, "linked", "2026-12-25", ["100"], true),
  ).toThrow("recurring");
  const independentPrice = offer.price;
  expect(() =>
    changeDatePrice(
      {
        ...room,
        offers: [
          {
            ...offer,
            price: { ...independentPrice, calendar: { ...independentPrice.calendar, base: null } },
          },
        ],
      },
      "flex",
      "2026-12-25",
      ["100"],
      true,
    ),
  ).toThrow("recurring");
});
it("protects date mode selection, resets inputs and saves a complete occupancy date price", async () => {
  const room = snapshot.rooms[0],
    offer = room.offers[0];
  if (offer.price.kind !== "independent") throw new Error("fixture");
  client.read.mockResolvedValueOnce({
    ...snapshot,
    rooms: [
      {
        ...room,
        offers: [
          {
            ...offer,
            price: {
              ...offer.price,
              calendar: {
                ...offer.price.calendar,
                base: { mode: "occupancy", amountsMinor: ["10000", "13000"] },
              },
            },
          },
        ],
      },
    ],
    revision: 7,
    sources,
    stale: false,
  });
  await mount();
  await touch();
  const field = (name: string) =>
    view.root.findByProps({ "aria-label": `${name} for Room 1 Offer 1` });
  const fill = async (name: string, value: string) =>
    act(async () => field(name).props.onChange({ target: { value } }));
  await fill("New date pricing", "recurring");
  expect(button("Save and publish").props.disabled).toBe(true);
  await fill("Date 1 adult", "150.25");
  await fill("New date pricing", "flat");
  expect(field("Date room price").props.value).toBe("");
  expect(button("Save and publish").props.disabled).toBe(false);
  await fill("New date pricing", "recurring");
  await click("Cancel date entry");
  expect(field("New date pricing").props.value).toBe("flat");
  expect(client.saveDraft).not.toHaveBeenCalled();
  await fill("New date pricing", "recurring");
  await fill("Override date", "2026-12-25");
  await fill("Date 1 adult", "150.25");
  await click("Add date price");
  expect(button("Save and publish").props.disabled).toBe(true);
  await fill("Date 2 adults", "180.99");
  await click("Add date price");
  expect(field("New date pricing").props.value).toBe("flat");
  await click("Save and publish");
  expect(saved).toMatchObject({ revision: 2, baseRevision: 7 });
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: {
      dates: [
        { date: "2026-12-25", price: { mode: "occupancy", amountsMinor: ["15025", "18099"] } },
      ],
    },
  });
  expect(field("New date pricing").props.disabled).toBe(true);
  expect(button("Save and publish").props.disabled).toBe(true);
  client.read.mockResolvedValueOnce({ ...saved.snapshot, revision: 8, sources, stale: false });
  await reload();
  await click("Edit date price");
  expect(field("Date 2 adults").props.value).toBe("180.99");
});

it.each(["monthly", "seasonal"] as const)(
  "edits %s included counts independently and retains them through save, review and reload",
  async (scope) => {
    const original = includedRoom();
    const room = changeIncludedAdjustments(
      original,
      "flex",
      {
        adults: "1",
        adjustments: [
          { kind: "fixed", value: "0" },
          { kind: "fixed", value: "10" },
          { kind: "fixed", value: "20" },
        ],
      },
      "130",
    );
    client.read.mockResolvedValueOnce({
      ...snapshot,
      rooms: [room],
      revision: 7,
      sources,
      stale: false,
    });
    await mount();
    await touch();
    const field = (name: string) => view.root.findByProps({ "aria-label": name });
    const fill = async (name: string, value: string) =>
      act(async () => field(name).props.onChange({ target: { value } }));
    const suffix = ` for Room 1 Offer 1 ${scope} price`;
    // Monthly prices are edited under More options; seasons in step 2's season window.
    const open = () => (scope === "monthly" ? click("Edit monthly price") : openSeason("Winter"));
    const apply = () => (scope === "monthly" ? click("Apply monthly price") : seasonClick("Save season"));
    const cancel = () => (scope === "monthly" ? click("Cancel month entry") : seasonClick("Cancel"));
    const editButton = () =>
      scope === "monthly"
        ? button("Edit monthly price")
        : view.root
            .findAllByType("button")
            .find((node) => String(node.props["aria-label"] ?? "").startsWith("Edit season Winter "))!;
    await open();
    expect(field(`Adults included in the base price${suffix}`).props.value).toBe("2");
    expect(field(`Adjustment for 1 adult${suffix}`).props.value).toBe("-30.00");
    expect(field(`Adjustment for 3 adults${suffix}`).props.value).toBe("19.25");
    await fill(`Adults included in the base price${suffix}`, "1");
    expect(field(`Adjustment for 2 adults${suffix}`).props.value).toBe("");
    await apply();
    expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(button("Save and publish").props.disabled).toBe(true);
    await cancel();
    expect(button("Save and publish").props.disabled).toBe(false);
    await open();
    expect(field(`Adults included in the base price${suffix}`).props.value).toBe("2");
    await fill(`Adults included in the base price${suffix}`, "1");
    for (const [count, kind, value] of [
      [2, "fixed", "12.25"],
      [3, "percentage", "15.75"],
    ] as const) {
      await fill(`Adjustment type for ${count} adults${suffix}`, kind);
      await fill(`Adjustment for ${count} adults${suffix}`, value);
    }
    await apply();
    await click("Save and publish");
    const source = room.offers[0].price,
      price = saved.snapshot.rooms[0].offers[0].price;
    if (source.kind !== "independent" || price.kind !== "independent") throw new Error("fixture");
    const key = scope === "monthly" ? "months" : "seasons";
    expect(price.calendar).toEqual({
      ...source.calendar,
      [key]: [
        {
          ...source.calendar[key][0],
          price: {
            mode: "included_guests",
            baseGuests: 1,
            baseMinor: scope === "monthly" ? "20000" : "25000",
            adjustments: [
              { kind: "fixed", deltaMinor: "0" },
              { kind: "fixed", deltaMinor: "1225" },
              { kind: "percentage", basisPoints: 1575 },
            ],
          },
        },
      ],
    });
    expect(saved.snapshot.rooms[0].offers.slice(1)).toEqual(room.offers.slice(1));
    expect(editButton().props.disabled).toBe(true);
    client.read.mockResolvedValueOnce({ ...saved.snapshot, revision: 8, sources, stale: false });
    await reload();
    await open();
    expect(field(`Adults included in the base price${suffix}`).props.value).toBe("1");
    expect(field(`Adjustment for 2 adults${suffix}`).props.value).toBe("12.25");
  },
);
it("retains independent pending included edits for both calendar forms", async () => {
  client.read.mockResolvedValueOnce({
    ...snapshot,
    rooms: [includedRoom()],
    revision: 7,
    sources,
    stale: false,
  });
  await mount();
  await click("Edit monthly price");
  await openSeason("Winter");
  const fill = async (name: string, value: string) =>
    act(async () =>
      view.root.findByProps({ "aria-label": name }).props.onChange({ target: { value } }),
    );
  await fill("Adjustment for 1 adult for Room 1 Offer 1 monthly price", "-20.25");
  await fill("Adjustment for 1 adult for Room 1 Offer 1 seasonal price", "-10.25");
  await click("Apply monthly price");
  expect(button("Save and publish").props.disabled).toBe(true);
  await seasonClick("Save season");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: {
      months: [{ price: { adjustments: [{ deltaMinor: "-2025" }, {}, {}] } }],
      seasons: [{ price: { adjustments: [{ deltaMinor: "-1025" }, {}, {}] } }],
    },
  });
});

it.each([false, true])(
  "edits date-specific included settings through save review and reload (linked=%s)",
  async (linked) => {
    const original = includedRoom(),
      root = original.offers[0];
    if (root.price.kind !== "independent") throw new Error("fixture");
    const dates = [
      {
        date: "2026-12-25",
        price: {
          mode: "included_guests" as const,
          baseGuests: 1,
          baseMinor: "30000",
          adjustments: [
            { kind: "fixed" as const, deltaMinor: "0" },
            { kind: "fixed" as const, deltaMinor: "1225" },
            { kind: "percentage" as const, basisPoints: 1575 },
          ],
        },
      },
      { date: "2026-12-26", price: { mode: "flat" as const, amountMinor: "40000" } },
    ];
    const target = {
      ...root,
      id: "target",
      price: linked
        ? {
            kind: "linked" as const,
            parentId: root.id,
            adjustment: { kind: "percentage" as const, basisPoints: -1000 },
            dateOverrides: dates,
          }
        : { ...root.price, calendar: { ...root.price.calendar, dates } },
    };
    const room = { ...original, offers: [root, target] };
    client.read.mockResolvedValueOnce({
      ...snapshot,
      rooms: [room],
      revision: 7,
      sources,
      stale: false,
    });
    await mount();
    await touch();
    const field = (name: string) => view.root.findByProps({ "aria-label": name });
    const fill = async (name: string, value: string) =>
      act(async () => field(name).props.onChange({ target: { value } }));
    const edit = async () =>
      act(async () => field("Edit 2026-12-25 price for Room 1 Offer 2").props.onClick());
    const suffix = " for Room 1 Offer 2 date price";
    await edit();
    expect(field(`Adults included in the base price${suffix}`).props.value).toBe("1");
    expect(field(`Adjustment for 2 adults${suffix}`).props.value).toBe("12.25");
    expect(field(`Adjustment for 3 adults${suffix}`).props.value).toBe("15.75");
    await fill(`Adults included in the base price${suffix}`, "2");
    expect(field(`Adjustment for 1 adult${suffix}`).props.value).toBe("");
    expect(field("Date 2 adults included for Room 1 Offer 2").props.value).toBe("300.00");
    await click("Apply date price");
    expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(button("Save and publish").props.disabled).toBe(true);
    expect(field("Edit 2026-12-26 price for Room 1 Offer 2").props.disabled).toBe(true);
    expect(field("Clear 2026-12-25 price for Room 1 Offer 2").props.disabled).toBe(true);
    await click("Cancel date entry");
    expect(button("Save and publish").props.disabled).toBe(false);
    await edit();
    expect(field(`Adults included in the base price${suffix}`).props.value).toBe("1");
    await fill(`Adults included in the base price${suffix}`, "2");
    await fill(`Adjustment type for 1 adult${suffix}`, "fixed");
    await fill(`Adjustment for 1 adult${suffix}`, "-300");
    await fill(`Adjustment type for 3 adults${suffix}`, "percentage");
    await fill(`Adjustment for 3 adults${suffix}`, "19.25");
    await click("Apply date price");
    expect(JSON.stringify(view.toJSON())).toContain("Every adjusted room price must be positive");
    await fill(`Adjustment for 1 adult${suffix}`, "-30.25");
    await click("Apply date price");
    await click("Save and publish");
    const price = saved.snapshot.rooms[0].offers[1].price,
      expectedDates = [
        {
          ...dates[0],
          price: {
            mode: "included_guests",
            baseGuests: 2,
            baseMinor: "30000",
            adjustments: [
              { kind: "fixed", deltaMinor: "-3025" },
              { kind: "fixed", deltaMinor: "0" },
              { kind: "percentage", basisPoints: 1925 },
            ],
          },
        },
        dates[1],
      ];
    expect(price).toEqual(
      target.price.kind === "linked"
        ? { ...target.price, dateOverrides: expectedDates }
        : { ...target.price, calendar: { ...target.price.calendar, dates: expectedDates } },
    );
    expect(saved.snapshot.rooms[0].offers[0]).toEqual(root);
    expect(saved.snapshot.rooms[0].children).toEqual(room.children);
    expect(saved.snapshot.rooms[0].offers[1].meal).toEqual(target.meal);
    expect(field("Edit 2026-12-25 price for Room 1 Offer 2").props.disabled).toBe(true);
    client.read.mockResolvedValueOnce({ ...saved.snapshot, revision: 8, sources, stale: false });
    await reload();
    await edit();
    expect(field(`Adults included in the base price${suffix}`).props.value).toBe("2");
    expect(field(`Adjustment for 1 adult${suffix}`).props.value).toBe("-30.25");
    const entry = {
      adults: "2",
      adjustments: [
        { kind: "fixed", value: "-30" },
        { kind: "fixed", value: "0" },
        { kind: "fixed", value: "20" },
      ],
    };
    expect(() => changeDatePrice(room, "target", "2026-12-26", ["400"], false, entry)).toThrow(
      "included-adult",
    );
    expect(
      changeDatePrice(room, "flex", "2026-12-27", ["400"], true, entry).offers[0].price,
    ).toMatchObject({
      calendar: {
        dates: [{}, { date: "2026-12-27", price: { baseGuests: 2, baseMinor: "40000" } }],
      },
    });
    expect(() =>
      changeDatePrice(room, "target", "2026-12-25", ["400", "500"], false, entry),
    ).toThrow("included-adult");
  },
);

it.each(["monthly", "seasonal", "date"] as const)(
  "creates a %s price with its own included settings in one step",
  async (scope) => {
    const room = includedRoom();
    client.read.mockResolvedValueOnce({
      ...snapshot,
      rooms: [room],
      revision: 7,
      sources,
      stale: false,
    });
    await mount();
    await touch();
    const field = (name: string) => view.root.findByProps({ "aria-label": name });
    const fill = async (name: string, value: string) =>
      act(async () => field(name).props.onChange({ target: { value } }));
    const suffix = ` for Room 1 Offer 1 ${scope} price`;
    // A new season is added in step 2's season window.
    const add = () => (scope === "seasonal" ? seasonClick("Save season") : click(`Add ${scope} price`));
    if (scope === "seasonal") await openSeason();
    if (scope === "date") await fill("New date pricing for Room 1 Offer 1", "recurring");
    expect(field(`Adults included in the base price${suffix}`).props.value).toBe("2");
    expect(field(`Adjustment for 1 adult${suffix}`).props.value).toBe("-30.00");
    expect(field(`Adjustment for 3 adults${suffix}`).props.value).toBe("19.25");
    await fill(`Adults included in the base price${suffix}`, "1");
    expect(field(`Adjustment for 2 adults${suffix}`).props.value).toBe("");
    expect(button("Save and publish").props.disabled).toBe(true);
    // Clearing other fields must not drop the pending occupancy settings.
    if (scope === "monthly") await fill("Month for Room 1 Offer 1", "");
    if (scope === "seasonal") await fill("Season name", "");
    expect(button("Save and publish").props.disabled).toBe(true);
    if (scope === "seasonal") await seasonClick("Cancel");
    else await click(scope === "monthly" ? "Cancel month entry" : "Cancel date entry");
    expect(button("Save and publish").props.disabled).toBe(false);
    if (scope === "seasonal") await openSeason();
    if (scope === "date") await fill("New date pricing for Room 1 Offer 1", "recurring");
    expect(field(`Adults included in the base price${suffix}`).props.value).toBe("2");
    await fill(`Adults included in the base price${suffix}`, "1");
    if (scope === "monthly") await fill("Month for Room 1 Offer 1", "9");
    else if (scope === "seasonal")
      for (const [label, value] of [
        ["Season name", "Spring"],
        ["Starts: day", "1"],
        ["Starts: month", "3"],
        ["Ends: day", "31"],
        ["Ends: month", "3"],
      ])
        await fill(label, value);
    else await fill("Override date for Room 1 Offer 1", "2027-03-01");
    await fill(
      scope === "seasonal"
        ? "Season price 1 adult included"
        : `${scope === "monthly" ? "Monthly" : "Date"} 1 adult included for Room 1 Offer 1`,
      "240.25",
    );
    await add();
    expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    await fill(`Adjustment type for 2 adults${suffix}`, "fixed");
    await fill(`Adjustment for 2 adults${suffix}`, "12.25");
    await fill(`Adjustment type for 3 adults${suffix}`, "percentage");
    await fill(`Adjustment for 3 adults${suffix}`, "15.75");
    await add();
    await click("Save and publish");
    const source = room.offers[0].price,
      result = saved.snapshot.rooms[0].offers[0].price;
    if (source.kind !== "independent" || result.kind !== "independent") throw new Error("fixture");
    const key = scope === "monthly" ? "months" : scope === "seasonal" ? "seasons" : "dates";
    const price = {
      mode: "included_guests",
      baseGuests: 1,
      baseMinor: "24025",
      adjustments: [
        { kind: "fixed", deltaMinor: "0" },
        { kind: "fixed", deltaMinor: "1225" },
        { kind: "percentage", basisPoints: 1575 },
      ],
    };
    const row =
      scope === "monthly"
        ? { month: 9, price }
        : scope === "seasonal"
          ? { name: "Spring", tier: "", from: "03-01", through: "03-31", price }
          : { date: "2027-03-01", price };
    expect(result.calendar).toEqual({ ...source.calendar, [key]: [...source.calendar[key], row] });
    expect(saved.snapshot.rooms[0].offers.slice(1)).toEqual(room.offers.slice(1));
    client.read.mockResolvedValueOnce({ ...saved.snapshot, revision: 8, sources, stale: false });
    await reload();
    if (scope === "seasonal") await openSeason("Spring");
    else
      await act(async () =>
        field(
          `${scope === "monthly" ? "Edit September price" : "Edit 2027-03-01 price"} for Room 1 Offer 1`,
        ).props.onClick(),
      );
    expect(field(`Adults included in the base price${suffix}`).props.value).toBe("1");
    expect(field(`Adjustment for 2 adults${suffix}`).props.value).toBe("12.25");
  },
);
it("discards new-date included settings when switching to a flat final price", async () => {
  client.read.mockResolvedValueOnce({
    ...snapshot,
    rooms: [includedRoom()],
    revision: 7,
    sources,
    stale: false,
  });
  await mount();
  const fill = async (name: string, value: string) =>
    act(async () =>
      view.root.findByProps({ "aria-label": name }).props.onChange({ target: { value } }),
    );
  await fill("New date pricing for Room 1 Offer 1", "recurring");
  await fill("Adults included in the base price for Room 1 Offer 1 date price", "1");
  await fill("New date pricing for Room 1 Offer 1", "flat");
  expect(
    view.root.findAllByProps({
      "aria-label": "Adults included in the base price for Room 1 Offer 1 date price",
    }),
  ).toHaveLength(0);
  await fill("Override date for Room 1 Offer 1", "2027-03-01");
  await fill("Date room price for Room 1 Offer 1", "250");
  await click("Add date price");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({
    calendar: {
      dates: [{}, { date: "2027-03-01", price: { mode: "flat", amountMinor: "25000" } }],
    },
  });
});

it("binds the stay preview to raw editor inputs and shows the saved prices after saving", async () => {
  await mount();
  await act(async () => input().props.onChange({ target: { value: "150.25" } }));
  expect(view.root.findByType(PricingStayPreview).props.inputs).toEqual({ "0:0:0": "150.25" });
  await click("Save and publish");
  const preview = view.root.findByType(PricingStayPreview).props;
  expect(preview.saved).toBe(false);
  expect(preview.inputs).toEqual({});
  expect(preview.snapshot).toEqual(saved.snapshot);
  expect(input().props.value).toBe("150.25");
});

it("disables the stay preview for unapplied calendar edits", async () => {
  await mount();
  await act(async () =>
    view.root
      .findByProps({ "aria-label": "Month for Room 1 Offer 1" })
      .props.onChange({ target: { value: "9" } }),
  );
  expect(view.root.findByType(PricingStayPreview).props.disabled).toBe(true);
});

const familyId = "61000000-0000-4000-8000-000000000004", family = { ...snapshot.rooms[0], roomTypeId: familyId };
const familySetup = { roomTypeId: familyId, name: "Family", capacity: family.capacity };
const published = (rooms: PricingSnapshot["rooms"] = [snapshot.rooms[0], family], revision = 1) => ({ ...snapshot, rooms, revision, sources, stale: false });
type RoomProps = Partial<Pick<Parameters<typeof PricingEditor>[0], "onAttention" | "onPublished" | "refresh" | "staleShown">>;
const roomEditor = (rooms: { roomTypeId: string; name: string; capacity: PricingSnapshot["rooms"][number]["capacity"] }[], extra: RoomProps = {}) =>
  <PricingEditor client={client as ReturnType<typeof createReplacementPricingClient>} roomNames={{ room: "Existing", [familyId]: "Family" }} setup={{ propertyId: "property", rooms }} roomTypeId={familyId} {...extra} />;
const mountRoom = async (rooms = [{ roomTypeId: "room", name: "Existing", capacity: snapshot.rooms[0].capacity }, familySetup], extra: RoomProps = {}) => {
  await act(async () => { view = create(roomEditor(rooms, extra)); });
};
const familyInput = (base: string) => firstPricingInput("property", familySetup, familyId, { mode: "flat", occupancy: [], included: { adults: "", adjustments: [] }, methods: ["card"], room: familyId, currency: "EUR", base, adultAge: "12", childPrice: "0", countChildren: "yes", minimum: "1", maximum: "", cancellation: "non_refundable", freeDays: "", payment: "full" });
it("on a room page, edits only that room, publishes every other room exactly as read and continues from the new publication (VAY-2093)", async () => {
  client.read.mockResolvedValue(published()); await mountRoom();
  expect(view.root.findAllByProps({ inputMode: "decimal" }).filter((node) => node.type === "input" && !["How much cheaper, in percent", "Breakfast price", "Price a night for each child"].includes(node.props["aria-label"]))).toHaveLength(1);
  expect(input().props["aria-label"]).toContain("Family"); expect(button("Add another room")).toBeUndefined();
  await act(async () => {});
  expect(view.root.findByProps({ "aria-label": "Preview room and offer" }).findAllByType("option").map((node) => node.children.join(""))).toEqual(["Family · Breakfast included, non-refundable"]);
  await act(async () => input().props.onChange({ target: { value: "123.45" } }));
  const termsReads = client.readTerms.mock.calls.length;
  client.read.mockResolvedValueOnce(published(undefined, 2)); await click("Save and publish");
  // The options' terms are read again, so the Rates step doesn't stay "loading" (same revisions).
  expect(client.readTerms.mock.calls.length).toBeGreaterThan(termsReads);
  expect(saved.baseRevision).toBe(1); expect(saved.snapshot.rooms[0]).toEqual({ ...snapshot.rooms[0], revision: 2 });
  expect(saved.snapshot.rooms[1]).toMatchObject({ roomTypeId: familyId, revision: 2, offers: [{ price: { calendar: { base: { amountMinor: "12345" } } } }] });
  expect(client.confirmationAction).toHaveBeenCalledWith(expect.anything(), "save_prices"); expect(client.publicationAction.mock.calls[0][0]).toMatchObject({ baseRevision: 1 });
  // Saved and live (VAY-2305): the tab re-reads the publication and editing goes on from it.
  expect(JSON.stringify(view.toJSON())).toContain("Prices saved"); expect(client.read).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(view.toJSON())).toContain("All prices saved and live");
  expect(input().props.disabled).toBe(false); expect(button("Save and publish").props.disabled).toBe(true);
});
it("keeps the saved prices on show for review when the re-read after publishing fails (VAY-2305)", async () => {
  client.read.mockResolvedValueOnce(published()); await mountRoom();
  await act(async () => input().props.onChange({ target: { value: "123.45" } }));
  client.read.mockRejectedValueOnce(new Error("offline")); await click("Save and publish");
  expect(client.read).toHaveBeenCalledTimes(2);
  const text = JSON.stringify(view.toJSON());
  expect(text).toContain("Saved and published"); expect(text).not.toContain("could not be saved");
  expect(input().props.disabled).toBe(true); expect(input().props.value).toBe("123.45");
  client.read.mockResolvedValueOnce(published([snapshot.rooms[0], { ...family, revision: 2 }], 2)); await click("Edit prices again");
  expect(input().props.disabled).toBe(false); expect(button("Save and publish").props.disabled).toBe(true);
});
it("keeps the saved prices on show for review when someone else published after this save (VAY-2305)", async () => {
  client.read.mockResolvedValueOnce(published()); await mountRoom();
  await act(async () => input().props.onChange({ target: { value: "123.45" } }));
  // Revision 3 isn't the one this save made (2): its prices may not be these.
  client.read.mockResolvedValueOnce(published([snapshot.rooms[0], { ...family, revision: 3 }], 3)); await click("Save and publish");
  expect(client.read).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(view.toJSON())).toContain("Saved and published"); expect(input().props.disabled).toBe(true); expect(input().props.value).toBe("123.45");
});
it("keeps this room's edits over the reload after a refused save when only another room changed, and declares again", async () => {
  client.read.mockResolvedValueOnce(published()); await mountRoom();
  await act(async () => input().props.onChange({ target: { value: "123.45" } }));
  publish.mockRejectedValueOnce(new ApiErrorResponse(409, { code: "stale" })); await click("Save and publish");
  expect(JSON.stringify(view.toJSON())).toContain("Your changes to this room are kept if nobody else changed this room"); expect(button("Save and publish").props.disabled).toBe(true);
  const changed = { ...snapshot.rooms[0], children: { ...snapshot.rooms[0].children, adultFromAge: 16 } };
  client.read.mockResolvedValueOnce(published([changed, family], 2)); await click("Reload pricing");
  expect(button("Discard and reload")).toBeUndefined(); expect(input().props.value).toBe("123.45");
  expect(JSON.stringify(view.toJSON())).toContain("your changes to this room are kept"); expect(button("Save and publish").props.disabled).toBe(false);
  await click("Save and publish");
  expect(saved.baseRevision).toBe(2); expect(saved.snapshot.rooms[0]).toEqual({ ...changed, revision: 3 });
  expect(saved.snapshot.rooms[1].offers[0].price).toMatchObject({ calendar: { base: { amountMinor: "12345" } } });
  expect(confirm).toHaveBeenCalledTimes(2); expect(publish).toHaveBeenCalledTimes(2);
});
it("drops this room's edits when someone else changed the room, so a later save cannot overwrite their change", async () => {
  client.read.mockResolvedValueOnce(published()); await mountRoom();
  await act(async () => input().props.onChange({ target: { value: "123.45" } }));
  client.prepare.mockRejectedValueOnce(new ApiErrorResponse(409, {})); await click("Save and publish");
  client.read.mockResolvedValueOnce(published([snapshot.rooms[0], { ...family, offers: [{ ...family.offers[0], termsRevision: "terms-2" }] }], 2)); await click("Reload pricing");
  expect(input().props.value).toBe("100.00"); expect(JSON.stringify(view.toJSON())).toContain("Someone else changed this room"); expect(button("Save and publish").props.disabled).toBe(true);
});
it("starts an unpriced room with the first setup in the property currency and publishes it next to the other rooms", async () => {
  vi.spyOn(bookingsService, "getPaymentSettings").mockRejectedValueOnce(new Error("offline"));
  client.read.mockResolvedValue({ ...snapshot, revision: 3, sources, stale: false });
  const policy = vi.fn().mockResolvedValue({ revision: familyId }); client.termsAction.mockReturnValue(policy);
  await mountRoom();
  expect(view.root.findByType(StepFirstPrices).props).toMatchObject({ rooms: [familySetup], fixedCurrency: "EUR" });
  // The bar holds the one Save (VAY-2305): the first-price form's submit button, so Enter in a field saves too.
  const saves = () => view.root.findAllByType("button").filter((node) => node.children.includes("Save and publish"));
  const form = view.root.findByType("form");
  expect(saves()).toHaveLength(1); expect(saves()[0].props).toMatchObject({ type: "submit", form: form.props.id }); expect(form.props.id).toBeTruthy();
  expect(view.root.findAllByType(PricingStayPreview)).toHaveLength(0); expect(JSON.stringify(view.toJSON())).toContain("No price yet: guests can't book this room");
  await act(async () => {}); expect(saves()[0].props.disabled).toBe(false); // Payment settings can't be read here: the form asks.
  expect(JSON.stringify(view.toJSON())).toContain("names anything else still missing");
  await act(async () => form.props.onSubmit({ preventDefault() {} })); expect(JSON.stringify(view.toJSON())).toContain("Fill in what is still missing:"); expect(client.publicationAction).not.toHaveBeenCalled();
  const first = familyInput("90");
  await act(async () => view.root.findByType(StepFirstPrices).props.onCreate({ configuration: first.configuration, terms: [first.terms] }, "save"));
  expect(saved.baseRevision).toBe(3); expect(saved.snapshot.rooms.map((room) => [room.roomTypeId, room.revision])).toEqual([["room", 4], [familyId, 4]]);
  expect(saved.snapshot.rooms[0]).toEqual({ ...snapshot.rooms[0], revision: 4 }); expect(policy).toHaveBeenCalledOnce();
});
it("says before the first price that payments aren't set up, and after a refused save that nothing was saved (VAY-2383)", async () => {
  vi.spyOn(bookingsService, "getPaymentSettings").mockResolvedValue({ paymentSettings: { payAtPropertyEnabled: false, onlineCardPayment: false, defaultCurrency: "EUR" } } as never);
  client.read.mockResolvedValue({ ...snapshot, revision: 3, sources, stale: false });
  const policy = vi.fn().mockResolvedValue({ revision: familyId }); client.termsAction.mockReturnValue(policy);
  client.prepare.mockRejectedValue(new ApiErrorResponse(403, { code: "denied", reason: "payments_disabled" } as never));
  await mountRoom();
  await act(async () => {});
  const shown = () => JSON.stringify(view.toJSON());
  // Payment settings were read and nothing is on: the page says so before any typing, with the payment currency.
  // The facade answers EUR for a hotel without any settings row, so the notice never names a currency.
  expect(shown()).toContain("Payments aren't set up for this property yet, so prices can't be saved.");
  expect(shown()).not.toContain("(now EUR)");
  const first = familyInput("90");
  await act(async () => view.root.findByType(StepFirstPrices).props.onCreate({ configuration: first.configuration, terms: [first.terms] }, "save"));
  // The refusal says nothing was saved and where to set payments up; the typed prices live on this page only.
  expect(shown()).toContain("Your prices were not saved: payments are switched off for this property.");
  expect(shown()).toContain("Booking Admin (Settings → Payments)");
  expect(shown()).toContain("What you typed stays on this page only until you leave or reload it.");
  expect(shown()).not.toContain("edits are kept");
  expect(shown()).not.toContain("so prices can't be saved.");
  expect(client.publicationAction).not.toHaveBeenCalled();
});
it("names the payment currency when the first prices are refused for another one (VAY-2383)", async () => {
  vi.spyOn(bookingsService, "getPaymentSettings").mockResolvedValue({ paymentSettings: { payAtPropertyEnabled: true, onlineCardPayment: false, defaultCurrency: "EUR" } } as never);
  client.read.mockResolvedValue(null);
  const policy = vi.fn().mockResolvedValue({ revision: familyId }); client.termsAction.mockReturnValue(policy);
  client.prepare.mockRejectedValue(new ApiErrorResponse(403, { code: "denied", reason: "currency_mismatch" } as never));
  await mountRoom();
  await act(async () => {});
  const shown = () => JSON.stringify(view.toJSON());
  expect(shown()).not.toContain("so prices can't be saved.");
  const first = firstPricingInput("property", familySetup, familyId, { mode: "flat", occupancy: [], included: { adults: "", adjustments: [] }, methods: ["pay_at_property"], room: familyId, currency: "IDR", base: "1500000", adultAge: "12", childPrice: "0", countChildren: "yes", minimum: "1", maximum: "", cancellation: "flexible", freeDays: "3", payment: "full" });
  await act(async () => view.root.findByType(StepFirstPrices).props.onCreate({ configuration: first.configuration, terms: [first.terms] }, "save"));
  expect(shown()).toContain("Your prices were not saved: the property takes payments in EUR. Enter the prices in EUR");
  expect(shown()).not.toContain("edits are kept");
});
it("on a room page, offers only that room for the first setup and asks to finish room details when it cannot have prices", async () => {
  client.read.mockResolvedValueOnce(null); await mountRoom();
  expect(view.root.findByType(StepFirstPrices).props.rooms).toEqual([familySetup]); expect(view.root.findByType(StepFirstPrices).props.fixedCurrency).toBeUndefined();
  act(() => view.unmount());
  client.read.mockResolvedValueOnce(null); await mountRoom([]);
  expect(JSON.stringify(view.toJSON())).toContain("Finish this room's details first"); expect(view.root.findAllByType(StepFirstPrices)).toHaveLength(0);
  client.read.mockResolvedValueOnce({ ...snapshot, revision: 1, sources, stale: false }); await click("Reload pricing");
  expect(JSON.stringify(view.toJSON())).toContain("Finish this room's details first"); expect(button("Save and publish")).toBeUndefined();
});
it("on a room page, lets links navigate in the app until there are unsaved prices, then asks before leaving", async () => {
  class FakeElement { constructor(readonly link: unknown) {} closest() { return this.link; } }
  class FakeAnchor { href = "http://localhost/rooms"; target = ""; }
  const assign = vi.fn();
  vi.stubGlobal("Element", FakeElement); vi.stubGlobal("HTMLAnchorElement", FakeAnchor);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { assign } });
  const onAttention = vi.fn();
  client.read.mockResolvedValue(published()); await mountRoom(undefined, { onAttention });
  const listener = () => vi.mocked(document.addEventListener).mock.calls.filter(([name]) => name === "click").at(-1)![1] as (event: unknown) => void;
  const linkClick = () => ({ target: new FakeElement(new FakeAnchor()), preventDefault: vi.fn(), stopPropagation: vi.fn() });
  const free = linkClick(); listener()(free); expect(free.preventDefault).not.toHaveBeenCalled();
  await act(async () => input().props.onChange({ target: { value: "120" } }));
  expect(onAttention).not.toHaveBeenCalled();
  const held = linkClick(); await act(async () => listener()(held)); expect(held.preventDefault).toHaveBeenCalled(); expect(assign).not.toHaveBeenCalled();
  // The page shows the Prices tab, so the confirmation is visible even when another tab was open.
  expect(onAttention).toHaveBeenCalledOnce();
  await click("Leave"); expect(assign).toHaveBeenCalledWith("http://localhost/rooms");
});
it("reloads on a page refresh only without unsaved work and tells the page after publishing", async () => {
  const onPublished = vi.fn();
  client.read.mockResolvedValue(published()); await mountRoom(undefined, { onPublished });
  const rooms = [{ roomTypeId: "room", name: "Existing", capacity: snapshot.rooms[0].capacity }, familySetup];
  await act(async () => view.update(roomEditor(rooms, { onPublished, refresh: 1 }))); expect(client.read).toHaveBeenCalledTimes(2);
  await act(async () => input().props.onChange({ target: { value: "123.45" } }));
  await act(async () => view.update(roomEditor(rooms, { onPublished, refresh: 2 }))); expect(client.read).toHaveBeenCalledTimes(2); expect(input().props.value).toBe("123.45");
  // Saving re-reads the publication (VAY-2305); one that isn't the new revision yet keeps the saved prices on show for
  // review until "Edit prices again", and a page refresh doesn't replace them.
  await click("Save and publish"); expect(onPublished).toHaveBeenCalledOnce(); expect(client.read).toHaveBeenCalledTimes(3);
  await act(async () => view.update(roomEditor(rooms, { onPublished, refresh: 3 }))); expect(client.read).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(view.toJSON())).toContain("Prices saved");
});
it("keeps the newest read when an older one answers last", async () => {
  let answerFirst!: (value: unknown) => void;
  client.read.mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }));
  await act(async () => { view = create(roomEditor([familySetup])); });
  client.read.mockResolvedValueOnce(published([snapshot.rooms[0], { ...family, offers: [{ ...family.offers[0], price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "20000" }, months: [], seasons: [], weekdays: [], dates: [] } } }] }], 2));
  await act(async () => view.update(roomEditor([familySetup], { refresh: 1 })));
  await act(async () => answerFirst(published()));
  expect(input().props.value).toBe("200.00");
});
it("does not offer to keep edits after a denial, or when nothing was edited", async () => {
  client.read.mockResolvedValue(published()); await mountRoom();
  await act(async () => input().props.onChange({ target: { value: "123.45" } }));
  client.prepare.mockRejectedValueOnce(new ApiErrorResponse(403, {})); await click("Save and publish");
  expect(JSON.stringify(view.toJSON())).not.toContain("Your changes to this room are kept"); await click("Reload pricing");
  expect(button("Discard and reload")).toBeDefined(); await click("Discard and reload");
  expect(input().props.value).toBe("100.00"); expect(JSON.stringify(view.toJSON())).not.toContain("your changes to this room are kept");
  act(() => view.unmount());
  client.read.mockResolvedValue({ ...published(), stale: true }); await mountRoom();
  client.prepare.mockRejectedValueOnce(new ApiErrorResponse(409, {})); await click("Save and publish");
  await click("Reload pricing"); expect(button("Save and publish").props.disabled).toBe(false);
  expect(JSON.stringify(view.toJSON())).not.toContain("your changes to this room are kept");
});
it("keeps the status, the declaration and Reload beside Save in the sticky bar (VAY-2122, VAY-2125)", async () => {
  client.read.mockResolvedValue(published()); await mountRoom();
  const text = () => JSON.stringify(view.toJSON());
  expect(text()).toContain("All prices saved and live");
  const bar = button("Reload pricing").parent!;
  expect(bar.props.className).toContain("sticky"); expect(button("Save and publish").parent).toBe(bar);
  expect(view.root.findAllByType("button").filter((node) => node.children.includes("Reload pricing"))).toHaveLength(1);
  // Pressing Save is the charges declaration: its text sits in the same bar and describes the button.
  const declaration = view.root.findByProps({ id: button("Save and publish").props["aria-describedby"] });
  expect(declaration.parent!.parent).toBe(bar); expect(declaration.children.join("")).toContain("mandatory taxes and fees");
  await touch(); expect(text()).toContain("Unsaved changes");
  // No heading repeats the room's name; the room page's title shows it.
  expect(view.root.findAll((node) => /^h\d$/.test(String(node.type))).map((node) => node.children.join(""))).not.toContain("Family");
});
it("counts the open nights no price covers in the bar (VAY-2305)", async () => {
  const offer = family.offers[0];
  const calendarOnly = { ...family, offers: [{ ...offer, price: { kind: "independent" as const, calendar: { base: null, months: [], seasons: [], weekdays: [], dates: [] } } }, ...family.offers.slice(1)] };
  client.read.mockResolvedValue(published([snapshot.rooms[0], calendarOnly])); await mountRoom();
  expect(JSON.stringify(view.toJSON())).toMatch(/"\d{3} open nights have no price"/);
});
it("adds a quick-add option with its terms and deletes an option after folding typed prices in (VAY-2125)", async () => {
  const id = "61000000-0000-4000-8000-000000000004",
    revision = "61000000-0000-4000-8000-000000000006";
  const [flex] = snapshot.rooms[0].offers;
  if (flex.price.kind !== "independent") throw new Error("fixture");
  const second = { ...flex, id: "second", price: { ...flex.price, calendar: { ...flex.price.calendar, base: { mode: "flat" as const, amountMinor: "20000" } } } };
  const room = { ...snapshot.rooms[0], roomTypeId: id, offers: [flex, second] };
  client.read.mockResolvedValueOnce({ ...snapshot, rooms: [room], revision: 7, sources, stale: false });
  client.readTerms.mockImplementation(async (roomTypeId, offerId, termsRevision) => ({
    roomTypeId,
    offerId,
    revision: termsRevision,
    cancellation: { kind: "flexible", terms: { type: "free_until_days_before_arrival", freeCancellationDeadlineDays: 7, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount" } },
    payment: { kind: "full", acceptedMethods: ["card"] },
  }));
  const policy = vi.fn().mockResolvedValue({ revision });
  client.termsAction.mockReturnValue(policy);
  await mount(id);
  await act(async () => {});
  const text = () => JSON.stringify(view.toJSON());
  expect(text()).toContain("Breakfast included");
  expect(text()).toContain("Breakfast included 2");
  // VAY-2188: non-refundable is a switch on the card; on adds the option at once, 10% cheaper.
  expect(extraSwitch("Non-refundable").props["aria-checked"]).toBe(false);
  await act(async () => extraSwitch("Non-refundable").props.onClick());
  expect(view.root.findAllByType(Modal)).toHaveLength(0);
  expect(extraSwitch("Non-refundable").props["aria-checked"]).toBe(true);
  // The main option now has an option based on it, so its window explains instead of offering Delete.
  expect(text()).toContain("Other options are based on this one. Delete or change them first: Non-refundable.");
  await act(async () => input().props.onChange({ target: { value: "123" } }));
  await click("Delete option");
  await act(async () => view.root.findByType(ConfirmDialog).props.onConfirm());
  expect(input().props.value).toBe("123.00");
  expect(text()).toContain("Option deleted from this draft.");
  await click("Save and publish");
  expect(policy).toHaveBeenCalledOnce();
  expect(client.termsAction.mock.calls[0][0]).toMatchObject({ roomTypeId: id, expectedRevision: null, cancellation: { kind: "non_refundable" }, payment: { kind: "full", acceptedMethods: ["card"] } });
  const offers = saved.snapshot.rooms[0].offers;
  expect(offers.map((offer) => offer.id)).toEqual(["flex", client.termsAction.mock.calls[0][0].offerId]);
  expect(offers[0].price).toMatchObject({ calendar: { base: { amountMinor: "12300" } } });
  expect(offers[1]).toMatchObject({ termsRevision: revision, price: { kind: "linked", parentId: "flex", adjustment: { kind: "percentage", basisPoints: -1000 } }, restrictions: { kind: "inherit" } });
});
it("retries option names whose terms failed and keeps a window open on a price it can't read (VAY-2125)", async () => {
  const [flex] = snapshot.rooms[0].offers;
  if (flex.price.kind !== "independent") throw new Error("fixture");
  const second = { ...flex, id: "second", price: { ...flex.price, calendar: { ...flex.price.calendar, base: { mode: "flat" as const, amountMinor: "20000" } } } };
  client.read.mockResolvedValueOnce({ ...snapshot, rooms: [{ ...snapshot.rooms[0], offers: [flex, second] }], revision: 1, sources, stale: false });
  client.readTerms.mockRejectedValueOnce(new Error("offline"));
  await mount();
  await act(async () => {});
  const text = () => JSON.stringify(view.toJSON());
  expect(text()).toContain("Some options' cancellation terms couldn't be loaded");
  expect(text()).toContain("Option 1 · breakfast");
  await click("Try again");
  await act(async () => {});
  expect(text()).not.toContain("couldn't be loaded");
  expect(text()).toContain("Breakfast included, non-refundable 2");
  await act(async () => view.root.findByProps({ "aria-label": "Room 1 Offer 2 Per room" }).props.onChange({ target: { value: "12,5" } }));
  // Step 5's child-price window is an OptionWindow too, so the option's window is found by its title.
  const done = () => view.root.findAllByType(OptionWindow).find((node) => node.props.title === "Breakfast included, non-refundable 2")!.findAllByType("button").find((node) => node.children.includes("Done"))!;
  expect(done().props.disabled).toBe(true);
  await act(async () => view.root.findByProps({ "aria-label": "Room 1 Offer 2 Per room" }).props.onChange({ target: { value: "125" } }));
  expect(done().props.disabled).toBe(false);
});
it("shows add and delete errors in the window that asked, and counts the quick-add form as unsaved work (VAY-2125)", async () => {
  const id = "61000000-0000-4000-8000-000000000004";
  const [flex] = snapshot.rooms[0].offers;
  if (flex.price.kind !== "independent") throw new Error("fixture");
  const second = { ...flex, id: "second", price: { ...flex.price, calendar: { ...flex.price.calendar, base: { mode: "flat" as const, amountMinor: "20000" } } } };
  client.read.mockResolvedValueOnce({ ...snapshot, rooms: [{ ...snapshot.rooms[0], roomTypeId: id, offers: [flex, second] }], revision: 2, sources, stale: false });
  client.readTerms.mockImplementation(async (roomTypeId, offerId, revision) => ({
    roomTypeId,
    offerId,
    revision,
    cancellation: { kind: "flexible", terms: { type: "free_until_days_before_arrival", freeCancellationDeadlineDays: 7, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount" } },
    payment: { kind: "full", acceptedMethods: ["card"] },
  }));
  await mount(id);
  await act(async () => {});
  await click("Half board");
  // The open form is unsaved work: Save waits, and leaving asks first.
  expect(button("Save and publish").props.disabled).toBe(true);
  const warn = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === "beforeunload").at(-1)![1] as (event: unknown) => void;
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  warn(event);
  expect(event.preventDefault).toHaveBeenCalled();
  // A price the editor can't read stops the add; the form says why.
  await act(async () => input().props.onChange({ target: { value: "abc" } }));
  await act(async () => view.root.findByType(Modal).findAllByType("button").find((node) => node.children.includes("Add option"))!.props.onClick());
  expect(view.root.findByType(Modal).findAllByProps({ role: "alert" })).toHaveLength(1);
  await act(async () => view.root.findByType(Modal).findAllByType("button").find((node) => node.children.includes("Cancel"))!.props.onClick());
  // The same for a delete: the option's window says why.
  await act(async () => view.root.findAllByType(StepOptions)[0].props.onEdit("second"));
  const edit = () => view.root.findAllByType(OptionWindow).find((node) => node.props.title === "Breakfast included 2")!;
  await act(async () => edit().findAllByType("button").find((node) => node.children.includes("Delete option"))!.props.onClick());
  await act(async () => view.root.findByType(ConfirmDialog).props.onConfirm());
  expect(edit().props.open).toBe(true);
  expect(edit().findAllByProps({ role: "alert" })).toHaveLength(1);
  expect(client.saveDraft).not.toHaveBeenCalled();
});
it("changes the main option's minimum nights in step 5, keeps own stay rules and names what More options holds (VAY-2125)", async () => {
  const room = snapshot.rooms[0],
    [flex] = room.offers;
  if (flex.price.kind !== "independent" || flex.restrictions.kind !== "own") throw new Error("fixture");
  const rules = { ...flex.restrictions.rules, minArrivalNights: 2, maxStayNights: 14 };
  const main = {
    ...flex,
    price: { ...flex.price, calendar: { ...flex.price.calendar, months: [{ month: 8, price: { mode: "flat" as const, amountMinor: "12000" } }], dates: [{ date: "2026-12-25", price: { mode: "flat" as const, amountMinor: "20000" } }] } },
    restrictions: { kind: "own" as const, rules, seasons: [], dates: [{ date: "2026-12-31", rules: { ...rules, closedToArrival: true } }] },
  };
  const early = {
    ...flex,
    id: "early",
    price: { kind: "linked" as const, parentId: "flex", adjustment: { kind: "percentage" as const, basisPoints: -500 }, dateOverrides: [] },
    restrictions: { kind: "own" as const, rules: { ...rules, minArrivalNights: 4 }, seasons: [], dates: [] },
  };
  client.read.mockResolvedValueOnce({ ...snapshot, rooms: [{ ...room, offers: [main, early] }], revision: 3, sources, stale: false });
  await mount();
  await act(async () => {});
  const text = () => JSON.stringify(view.toJSON());
  expect(text()).toContain("1 monthly price · 1 single date · 1 date or season rule · Advanced rules");
  expect(text()).toContain("These options have their own stay rules and keep them: Breakfast included, non-refundable 2.");
  expect(text()).toContain("0–11 €25 per night");
  const more = () => view.root.findByProps({ "aria-label": "One night more" });
  await act(async () => more().props.onClick());
  expect(button("Save and publish").props.disabled).toBe(false);
  await click("Save and publish");
  const [savedMain, savedEarly] = saved.snapshot.rooms[0].offers;
  expect(savedMain.restrictions).toEqual({ ...main.restrictions, rules: { ...rules, minArrivalNights: 3 } });
  expect(savedEarly.restrictions).toEqual(early.restrictions);
  expect(savedMain.price).toEqual(main.price);
});
it("shows what guests pay for the picked stay and the month's nightly prices, from the unsaved edits (VAY-2125)", async () => {
  await mount();
  await act(async () => {});
  await act(async () => view.root.findByType(PriceCalendar).props.onPick("2026-07-18"));
  expect(view.root.findByType(GuestPreview).props.stay).toEqual({ checkIn: "2026-07-18", checkOut: "2026-07-20" });
  const text = () => JSON.stringify(view.toJSON());
  // Breakfast for 2 adults (2 × €12) on top of the €100 room, for 2 nights.
  expect(text()).toContain("2 nights · 18 Jul–20 Jul");
  expect(text()).toContain("Select · €248 for 2 nights");
  expect(view.root.findAllByProps({ "aria-label": "18 July 2026, €124, selected, in the sample stay" })).toHaveLength(1);
  // Only the chosen option of the guest card's radio group is a Tab stop; arrow keys move the choice.
  const radios = () => view.root.findByType(GuestPreview).findAllByProps({ role: "radio" }).filter((node) => node.type === "button");
  expect(radios().map((node) => node.props.tabIndex)).toEqual([0]);
  await act(async () => input().props.onChange({ target: { value: "150" } }));
  expect(text()).toContain("Select · €348 for 2 nights");
  expect(view.root.findAllByProps({ "aria-label": "18 July 2026, €174, selected, in the sample stay" })).toHaveLength(1);
  await act(async () => input().props.onChange({ target: { value: "abc" } }));
  expect(text()).toContain("Finish the open price entry to see guest prices.");
});
it("says in the guest card whether free cancellation is still open for the sample stay (VAY-2125)", async () => {
  const [flex] = snapshot.rooms[0].offers;
  client.read.mockResolvedValueOnce({ ...snapshot, rooms: [{ ...snapshot.rooms[0], offers: [{ ...flex, meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } } }] }], revision: 1, sources, stale: false });
  client.readTerms.mockImplementation(async (roomTypeId, offerId, revision) => ({
    roomTypeId,
    offerId,
    revision,
    cancellation: { kind: "flexible", terms: { type: "free_until_days_before_arrival", freeCancellationDeadlineDays: 7, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount" } },
    payment: { kind: "full", acceptedMethods: ["card"] },
  }));
  await mount();
  await act(async () => {});
  const text = () => JSON.stringify(view.toJSON());
  await act(async () => view.root.findByType(PriceCalendar).props.onPick("2099-07-18"));
  expect(text()).toContain("Free cancellation until 11 Jul");
  await act(async () => view.root.findByType(PriceCalendar).props.onPick("2020-07-18"));
  expect(text()).toContain("No free cancellation for these dates");
});

it("shows a Price group in an option's window only with something to edit, and says each card's meal plan (VAY-2157)", async () => {
  const [flex] = snapshot.rooms[0].offers;
  if (flex.price.kind !== "independent") throw new Error("fixture");
  const price = flex.price;
  const roomOnly = { ...flex, id: "plain", meal: { kind: "room_only" as const, charge: { kind: "room" as const, amountMinor: "0" } },
    price: { kind: "linked" as const, parentId: "flex", adjustment: { kind: "percentage" as const, basisPoints: -1000 }, dateOverrides: [] }, restrictions: { kind: "inherit" as const } };
  const read = (base: typeof price.calendar.base) => ({ ...snapshot, rooms: [{ ...snapshot.rooms[0], offers: [{ ...flex, price: { ...price, calendar: { ...price.calendar, base } } }, roomOnly] }], revision: 1, sources, stale: false });
  // Option windows by offer, in order (step 5's children window has no meal plan).
  const headings = () => view.root.findAllByType(OptionWindow).filter((node) => node.findAllByType(PricingMealPlan).length)
    .map((node) => node.findAllByType("h3").map((heading) => heading.children.join("")));
  client.read.mockResolvedValue(read({ mode: "flat", amountMinor: "10000" }));
  await mount();
  await act(async () => {});
  // A flat main price is step 1, so its window starts with Meals; a linked option edits its link under Price.
  expect(headings()).toEqual([["Meals", "Cancellation and payment"], ["Price", "Meals", "Cancellation and payment", "Stay rules"]]);
  const text = JSON.stringify(view.toJSON());
  // VAY-2188: the main option is the card's price, which says its meal; the list holds the others.
  expect(text).toContain("Includes breakfast: €12 per adult a night");
  expect(text).toContain("per normal night for 2 adults, room only");
  expect(text).not.toContain("meals included");
  act(() => view.unmount());
  // An included-guest main price keeps its other guest counts under Price.
  client.read.mockResolvedValue(read({ mode: "included_guests", baseGuests: 2, baseMinor: "10000", adjustments: [{ kind: "fixed", deltaMinor: "-2000" }, { kind: "fixed", deltaMinor: "0" }] }));
  await mount();
  await act(async () => {});
  expect(headings()[0]).toEqual(["Price", "Meals", "Cancellation and payment"]);
});
it("leaves the stale-prices warning to the room page when the page shows it, and still saves them (VAY-2157)", async () => {
  client.read.mockResolvedValue({ ...published(), stale: true });
  await mountRoom();
  const text = () => JSON.stringify(view.toJSON());
  expect(text()).toContain("Prices need to be saved again");
  act(() => view.unmount());
  await mountRoom(undefined, { staleShown: true });
  expect(text()).not.toContain("Prices need to be saved again");
  expect(button("Save and publish").props.disabled).toBe(false);
});
/** A room-only room with free cancellation until 3 days before arrival, paid by card (VAY-2188 review fixes). Terms
 * need a UUID room. */
const simpleCard = async (payment: Record<string, unknown> = { kind: "full", acceptedMethods: ["card"] }) => {
  const id = "61000000-0000-4000-8000-000000000014";
  const [flex] = snapshot.rooms[0].offers;
  const room = { ...snapshot.rooms[0], roomTypeId: id, offers: [{ ...flex, meal: { kind: "room_only" as const, charge: { kind: "room" as const, amountMinor: "0" } } }] };
  client.read.mockResolvedValueOnce({ ...snapshot, rooms: [room], revision: 7, sources, stale: false });
  client.readTerms.mockImplementation(async (roomTypeId, offerId, termsRevision) => ({
    roomTypeId,
    offerId,
    revision: termsRevision,
    cancellation: { kind: "flexible", terms: { type: "free_until_days_before_arrival", freeCancellationDeadlineDays: 3, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount" } },
    payment,
  }));
  client.termsAction.mockReturnValue(vi.fn().mockResolvedValue({ revision: "61000000-0000-4000-8000-000000000006" }));
  await mount(id);
  await act(async () => {});
};
const field = (label: string) => view.root.findByProps({ "aria-label": label });
const type = async (label: string, value: string) => act(async () => field(label).props.onChange({ target: { value } }));
it("keeps a switch's typed amount as typed, and an empty or wrong amount never locks the card (VAY-2188)", async () => {
  await simpleCard();
  const text = () => JSON.stringify(view.toJSON());
  // Breakfast without a price only says so; the rest of the card stays usable.
  await act(async () => extraSwitch("With breakfast").props.onClick());
  expect(text()).toContain("Enter the breakfast price to offer it.");
  expect(extraSwitch("Non-refundable").props.disabled).toBe(false);
  await type("Breakfast price", "15");
  await act(async () => extraSwitch("With breakfast").props.onClick());
  expect(extraSwitch("With breakfast").props["aria-checked"]).toBe(true);
  // Typing 18 over 15 goes through "1": the field keeps "1", not the saved "1.00".
  await type("Breakfast price", "1");
  expect(field("Breakfast price").props.value).toBe("1");
  await type("Breakfast price", "18");
  expect(field("Breakfast price").props.value).toBe("18");
  // The Non-refundable rate sits beside the Flexible rate, whose cancellation stays free (VAY-2282).
  await act(async () => extraSwitch("Non-refundable").props.onClick());
  expect(extraSwitch("Non-refundable").props["aria-checked"]).toBe(true);
  expect(button("Free cancellation").props["aria-pressed"]).toBe(true);
  // A discount that doesn't parse holds Save, but the switch still turns off.
  await type("How much cheaper, in percent", "abc");
  expect(button("Save and publish").props.disabled).toBe(true);
  await act(async () => extraSwitch("Non-refundable").props.onClick());
  await act(async () => view.root.findByType(ConfirmDialog).props.onConfirm());
  expect(extraSwitch("Non-refundable").props["aria-checked"]).toBe(false);
  await click("Save and publish");
  const offers = saved.snapshot.rooms[0].offers;
  expect(offers).toHaveLength(2);
  expect(offers[1].meal).toEqual({ kind: "breakfast", charge: { kind: "person", adultMinor: "1800", childBandAmountsMinor: ["0"] } });
});
it("names a deposit and counts it as a kept setting, and prices by adult count from the typed price (VAY-2188)", async () => {
  await simpleCard({ kind: "deposit", basisPoints: 3000, balanceDaysBeforeArrival: 14, acceptedMethods: ["card"] });
  const text = () => JSON.stringify(view.toJSON());
  // The Flexible rate's "Paid when booking" names the deposit (VAY-2282).
  expect(text()).toContain("Deposit: 30% of the final total. Balance due 14 days before arrival.");
  expect(text()).toContain("This room has more settings than the simple view shows.");
  await act(async () => input().props.onChange({ target: { value: "120" } }));
  // "Prices and seasons" switches to a price per number of adults from the typed price (VAY-2280).
  await act(async () => view.root.findByProps({ role: "switch", "aria-label": "Price depends on number of guests" }).props.onClick());
  expect(text()).toContain("On: a price for each number of adults, 1 to 2");
  await click("Save and publish");
  expect(saved.snapshot.rooms[0].offers[0].price).toMatchObject({ calendar: { base: { mode: "occupancy", amountsMinor: ["12000", "12000"] } } });
  expect(client.termsAction).not.toHaveBeenCalled();
});
