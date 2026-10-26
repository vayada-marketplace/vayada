import React, { createRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ConfirmDialog from "@/components/ConfirmDialog";
import { ApiErrorResponse } from "@/services/api/client";
import type {
  createReplacementPricingClient,
  PricingSnapshot,
} from "@/services/api/replacementPricingClient";
import { AcceptedPaymentMethods } from "./AcceptedPaymentMethods";
import { firstPricingInput } from "./FirstPricingSetup";
import type { KeptNewRoomPrices } from "./keptNewRoomPrices";
import type { NewRoomPrices } from "./newRoomPrices";
import { english, PricingError } from "./pricingAmounts";
import * as ui from "./pricingStyles";
import { PricingEditor } from "./PricingEditor";
import { StepFirstPrices } from "./StepFirstPrices";
import { AddOptionButton } from "./StepOptions";

// VAY-2147: the New room page's Prices tab, for a room that does not exist yet.
const temporary = "61000000-0000-4000-8000-0000000000aa";
const capacity = { total: 2, adults: 2, children: 2 };
const setupRoom = { roomTypeId: temporary, name: "Castrop Suite", capacity };
const existingId = "61000000-0000-4000-8000-000000000001";
const existing = {
  ...firstPricingInput(
    "property",
    { ...setupRoom, roomTypeId: existingId },
    "61000000-0000-4000-8000-00000000000f",
    {
      mode: "flat",
      occupancy: [],
      included: { adults: "", adjustments: [] },
      methods: ["card"], // Non-refundable is paid in advance (VAY-2280).
      room: existingId,
      currency: "EUR",
      base: "100",
      adultAge: "12",
      childPrice: "0",
      countChildren: "yes",
      minimum: "1",
      maximum: "",
      cancellation: "non_refundable",
      freeDays: "",
      payment: "full",
    },
  ).configuration,
  revision: 3,
};
const published: PricingSnapshot & {
  revision: number;
  sources: Record<string, string>;
  stale: boolean;
} = {
  currency: "EUR",
  ownerReferences: { finance: "finance" },
  rooms: [existing],
  revision: 3,
  sources: { room: "room", terms: "terms", finance: "finance" },
  stale: false,
};
const client = {
  read: vi.fn(),
  readTerms: vi.fn(),
  termsAction: vi.fn(),
  prepare: vi.fn(),
  saveDraft: vi.fn(),
  reviewCharges: vi.fn(),
  confirmationAction: vi.fn(),
  publicationAction: vi.fn(),
  paymentMethods: vi.fn(),
  cardReadiness: vi.fn(),
};

let view: ReactTestRenderer;
const take = createRef<(() => NewRoomPrices | null) | null>() as React.MutableRefObject<
  (() => NewRoomPrices | null) | null
>;
const onPrices = vi.fn();
const editor = (locked = false) => (
  <PricingEditor
    client={client as unknown as ReturnType<typeof createReplacementPricingClient>}
    roomNames={{ [existingId]: "Existing", [temporary]: "Castrop Suite" }}
    setup={{ propertyId: "property", rooms: [setupRoom] }}
    roomTypeId={temporary}
    newRoom={{ take, locked, onPrices, actions: <button type="button">Create Room Type</button> }}
  />
);
const mount = async () => {
  await act(async () => {
    view = create(editor());
  });
};
const button = (label: string) =>
  view.root.findAllByType("button").find(
    (node) =>
      node.children
        .filter((child) => typeof child === "string")
        .join("")
        .trim() === label,
  );
const click = async (label: string) => act(async () => button(label)!.props.onClick());
const field = (label: string) => view.root.findByProps({ "aria-label": label });
const fill = async (label: string, value: string) =>
  act(async () => field(label).props.onChange({ target: { value } }));
const text = () => JSON.stringify(view.toJSON());
/** The first-price form's answers for a €120 non-refundable room paid by card (Payment settings can't be read here, so
 * the form asks how guests pay; non-refundable stays are paid in advance, VAY-2280). */
const answer = async () => {
  await fill("Room price per night", "120");
  await click("Non-refundable");
  await act(async () => view.root.findByType(AcceptedPaymentMethods).props.onChange(["card"]));
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("React", React);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  client.read.mockResolvedValue(published);
  // Bank-transfer and PayPal acceptance off (VAY-2139).
  client.paymentMethods.mockResolvedValue([]);
  // Card not ready on the booking page (VAY-2205).
  client.cardReadiness.mockResolvedValue({
    card: { ready: false, reason: "switch_off", charge: "at_booking" },
    deposits: { ready: false },
  });
  take.current = null;
});
afterEach(() => {
  if (view) act(() => view.unmount());
  vi.unstubAllGlobals();
});

it("starts empty and optional, with the page's button in place of Save prices (VAY-2147)", async () => {
  await mount();
  expect(text()).toContain("Prices are optional here.");
  expect(text()).toContain("it is saved together with the room when you press Create Room Type.");
  expect(text()).not.toContain("press Save prices");
  expect(view.root.findByType(StepFirstPrices).props).toMatchObject({
    rooms: [setupRoom],
    fixedCurrency: "EUR",
  });
  expect(button("Create Room Type")).toBeDefined();
  for (const label of ["Save and publish", "Reload pricing", "Remove prices"])
    expect(button(label)).toBeUndefined();
  expect(text()).not.toContain("By creating the room type");
  expect(take.current!()).toBeNull();
  expect(onPrices).toHaveBeenLastCalledWith(false);
});

it("lets go of the page's handle when the tab goes away", async () => {
  await mount();
  expect(take.current).not.toBeNull();
  await act(async () => view.update(<></>));
  expect(take.current).toBeNull();
});

it("takes first answers given without Continue, and shows what is missing", async () => {
  await mount();
  await fill("Room price per night", "120");
  expect(onPrices).toHaveBeenLastCalledWith(true);
  expect(text()).toContain(
    "By creating the room type, you confirm these prices include all mandatory taxes and fees.",
  );
  // The form shows what is missing (here: how guests pay).
  await act(async () => expect(() => take.current!()).toThrow("Fill in what is still missing:"));
  expect(view.root.findAllByProps({ role: "alert" }).length).toBeGreaterThan(0);
  await answer();
  const prices = take.current!()!;
  expect(prices.room).toMatchObject({
    roomTypeId: temporary,
    revision: 4,
    currency: "EUR",
    capacity,
  });
  expect(prices.room.offers[0].price).toMatchObject({
    calendar: { base: { mode: "flat", amountMinor: "12000" } },
  });
  expect(prices.terms).toEqual([
    expect.objectContaining({
      roomTypeId: temporary,
      expectedRevision: null,
      cancellation: { kind: "non_refundable" },
    }),
  ]);
  expect(client.termsAction).not.toHaveBeenCalled();
});

it("after Enter adds them, takes the edited room and its options' terms; an open window or a bad amount stops it", async () => {
  await mount();
  await answer();
  await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(text()).toContain("Prices added. They are saved when the room is created.");
  // A new room has no saved terms to read.
  expect(client.readTerms).not.toHaveBeenCalled();
  const price = () =>
    view.root.findAllByType("input").find((node) => node.props.inputMode === "decimal")!;
  await act(async () => price().props.onChange({ target: { value: "130" } }));
  const prices = take.current!()!;
  expect(prices.room.offers[0].price).toMatchObject({
    calendar: { base: { amountMinor: "13000" } },
  });
  expect(prices.terms).toHaveLength(1);
  await act(async () => price().props.onChange({ target: { value: "13x" } }));
  expect(() => take.current!()).toThrow();
  await act(async () => price().props.onChange({ target: { value: "130" } }));
  await act(async () => view.root.findAllByType(AddOptionButton)[0].props.onClick());
  expect(() => take.current!()).toThrow(
    "Apply or cancel the open price change on the Prices tab first.",
  );
});

it("removes typed prices after asking, and holds every input while the page saves", async () => {
  await mount();
  await answer();
  await act(async () => view.update(editor(true)));
  expect(field("Room price per night").props.disabled).toBe(true);
  expect(button("Remove prices")!.props.disabled).toBe(true);
  await act(async () => view.update(editor()));
  await click("Remove prices");
  // Until pricing is read again, the removed prices are gone: a Create in between saves none.
  let reread!: (value: unknown) => void;
  client.read.mockReturnValueOnce(new Promise((resolve) => (reread = resolve)));
  await act(async () => view.root.findByType(ConfirmDialog).props.onConfirm());
  expect(take.current!()).toBeNull();
  await act(async () => reread(published));
  expect(client.read).toHaveBeenCalledTimes(2);
  expect(take.current!()).toBeNull();
  expect(field("Room price per night").props.value).toBe("");
  expect(onPrices).toHaveBeenLastCalledWith(false);
});

// After "Create Room Type" created the room but could not save its prices, its Prices tab starts from them.
const created = "61000000-0000-4000-8000-0000000000bb";
const createdSetup = { ...setupRoom, roomTypeId: created };
const handedOver = (error: unknown, outcomeUnknown = false): KeptNewRoomPrices => {
  const input = firstPricingInput(
    "property",
    createdSetup,
    "61000000-0000-4000-8000-0000000000dd",
    {
      mode: "flat",
      occupancy: [],
      included: { adults: "", adjustments: [] },
      methods: ["card"], // Non-refundable is paid in advance (VAY-2280).
      room: created,
      currency: "EUR",
      base: "120",
      adultAge: "12",
      childPrice: "0",
      countChildren: "yes",
      minimum: "1",
      maximum: "",
      cancellation: "non_refundable",
      freeDays: "",
      payment: "full",
    },
  );
  return {
    room: { ...input.configuration, revision: 4 },
    terms: [input.terms],
    error,
    outcomeUnknown,
  };
};
const onHandover = vi.fn();
const mountRoom = async (kept: KeptNewRoomPrices) => {
  await act(async () => {
    view = create(
      <PricingEditor
        client={client as unknown as ReturnType<typeof createReplacementPricingClient>}
        roomNames={{ [existingId]: "Existing", [created]: "Castrop Suite" }}
        setup={{ propertyId: "property", rooms: [createdSetup] }}
        roomTypeId={created}
        kept={kept}
        onHandover={onHandover}
      />,
    );
  });
};
const shownPrice = () =>
  view.root.findAllByType("input").find((node) => node.props.inputMode === "decimal")!.props.value;

it("opens the created room's Prices tab on the prices that were not saved, with why, and saves them there", async () => {
  let draft: Record<string, unknown> = {};
  const stage = vi.fn().mockResolvedValue({ revision: "61000000-0000-4000-8000-0000000000ee" });
  client.termsAction.mockReturnValue(stage);
  client.prepare.mockImplementation(async (value) => ({
    sources: published.sources,
    snapshot: { ...value, ownerReferences: { finance: "finance" } },
  }));
  client.saveDraft.mockImplementation(async ({ draftId, expectedDraftRevision, ...rest }) => {
    draft = {
      ...rest,
      draftId,
      revision: expectedDraftRevision + 1,
      sources: published.sources,
      stale: false,
    };
    return draft.revision;
  });
  client.reviewCharges.mockImplementation(async () => ({
    ...draft,
    fingerprint: "f",
    declaration: "all_mandatory_charges_included",
  }));
  client.confirmationAction.mockReturnValue(vi.fn().mockResolvedValue({ id: "declaration" }));
  client.publicationAction.mockReturnValue(
    vi.fn().mockResolvedValue({ revision: 4, replayed: false }),
  );
  await mountRoom(
    handedOver(new ApiErrorResponse(403, { code: "denied", reason: "payments_disabled" } as never)),
  );
  // Unsaved work to finish: a warning, not a success.
  expect(view.root.findByProps({ role: "status", className: ui.warningBanner }).children).toEqual([
    english("pricing.newRoom.noticeKept"),
  ]);
  expect(text()).toContain(english("pricing.editor.financePaymentsDisabled"));
  expect(onHandover).toHaveBeenCalledWith(true);
  expect(shownPrice()).toBe("120.00");
  expect(button("Save and publish")!.props.disabled).toBe(false);
  await click("Save and publish");
  expect(stage).toHaveBeenCalledOnce();
  expect(client.termsAction.mock.calls[0][0]).toMatchObject({
    roomTypeId: created,
    expectedRevision: null,
  });
  expect(
    client.prepare.mock.calls[0][0].rooms.map((room: { roomTypeId: string; revision: number }) => [
      room.roomTypeId,
      room.revision,
    ]),
  ).toEqual([
    [existingId, 4],
    [created, 4],
  ]);
  expect(text()).toContain("Prices saved.");
});

it("says the prices were saved when a save that broke off had published them after all", async () => {
  const saved = { ...handedOver(null).room, revision: 4 };
  client.read.mockResolvedValue({
    ...published,
    rooms: [{ ...existing, revision: 4 }, saved],
    revision: 4,
  });
  await mountRoom(handedOver(new Error("Failed to fetch"), true));
  expect(text()).toContain(english("pricing.newRoom.noticeSavedAfterAll"));
  expect(text()).not.toContain("Failed to fetch");
  expect(button("Save and publish")!.props.disabled).toBe(true);
  expect(onHandover).toHaveBeenCalledWith(false);
});

it("does not claim them saved when the room was published with other prices meanwhile", async () => {
  // The same room at €130 instead of €120.
  const typedRoom = JSON.stringify(handedOver(null).room);
  expect(typedRoom.split('"12000"')).toHaveLength(2);
  const changed = { ...JSON.parse(typedRoom.replace('"12000"', '"13000"')), revision: 4 };
  client.read.mockResolvedValue({
    ...published,
    rooms: [{ ...existing, revision: 4 }, changed],
    revision: 4,
  });
  await mountRoom(handedOver(new Error("Failed to fetch"), true));
  expect(text()).not.toContain(english("pricing.newRoom.noticeSavedAfterAll"));
  expect(text()).toContain(english("pricing.room.noticeDropped"));
  expect(text()).toContain("Failed to fetch");
  expect(onHandover).toHaveBeenCalledWith(false);
});

it("says why when the kept prices no longer apply (another currency was published meanwhile)", async () => {
  client.read.mockResolvedValue({ ...published, currency: "USD", rooms: [], revision: 4 });
  await mountRoom(handedOver(new PricingError("pricing.newRoom.errorChanged")));
  expect(text()).toContain(english("pricing.room.noticeDropped"));
  expect(text()).toContain(english("pricing.newRoom.errorChanged"));
  expect(onHandover).toHaveBeenCalledWith(false);
});

it("keeps them until pricing could be read", async () => {
  client.read.mockRejectedValueOnce(new Error("offline"));
  await mountRoom(handedOver(new ApiErrorResponse(409, { code: "stale" })));
  expect(text()).toContain("offline");
  await click("Reload pricing");
  expect(text()).toContain(english("pricing.newRoom.noticeKept"));
  expect(shownPrice()).toBe("120.00");
});
