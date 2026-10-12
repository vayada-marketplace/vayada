import React, { createRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ConfirmDialog from "@/components/ConfirmDialog";
import type {
  createReplacementPricingClient,
  PricingSnapshot,
} from "@/services/api/replacementPricingClient";
import { AcceptedPaymentMethods } from "./AcceptedPaymentMethods";
import { firstPricingInput } from "./FirstPricingSetup";
import type { NewRoomPrices } from "./newRoomPrices";
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
      methods: ["pay_at_property"],
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
/** Step 1-3's answers for a €120 non-refundable room, without pressing Continue. */
const answer = async () => {
  await fill("Room price per night", "120");
  await click("No, non-refundable");
  await act(async () =>
    view.root.findByType(AcceptedPaymentMethods).props.onChange(["pay_at_property"]),
  );
  await fill("Adult pricing starts at age (1–18)", "12");
  await fill("Price per child per night (0 is allowed)", "0");
  await click("Yes");
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("React", React);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  client.read.mockResolvedValue(published);
  take.current = null;
});
afterEach(() => {
  if (view) act(() => view.unmount());
  vi.unstubAllGlobals();
});

it("starts empty and optional, with the page's button in place of Save prices (VAY-2147)", async () => {
  await mount();
  expect(text()).toContain("Optional: you can also set prices later");
  expect(text()).toContain("the prices are saved when the room is created.");
  expect(text()).not.toContain("then press Save prices");
  expect(view.root.findByType(StepFirstPrices).props).toMatchObject({
    rooms: [setupRoom],
    fixedCurrency: "EUR",
  });
  expect(button("Create Room Type")).toBeDefined();
  for (const label of ["Save prices", "Reload pricing", "Remove prices"])
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
  // The step shows what is missing, as Continue would.
  await act(async () =>
    expect(() => take.current!()).toThrow("Complete every required pricing and policy setting."),
  );
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

it("after Continue, takes the edited room and its options' terms; an open window or a bad amount stops it", async () => {
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
