import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";
import type { PricingDraft, PricingSnapshot } from "@/services/api/replacementPricingClient";
import {
  lowestBaseMinor,
  RoomPriceSummary,
  RoomsPricesStrip,
  type PropertyPrices,
} from "./RoomsPrices";

const room: PricingSnapshot["rooms"][number] = {
  version: "pricing.v2",
  propertyId: "property",
  roomTypeId: "61000000-0000-4000-8000-00000000000A",
  revision: 4,
  currency: "EUR",
  capacity: { total: 2, adults: 2, children: 0 },
  children: { adultFromAge: 12, bands: [] },
  offers: [
    {
      id: "flex",
      termsRevision: "terms",
      meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: {
        kind: "independent",
        calendar: {
          base: { mode: "occupancy", amountsMinor: ["9000", "12000"] },
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
    {
      id: "saver",
      termsRevision: "terms",
      meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: {
        kind: "linked",
        parentId: "flex",
        adjustment: { kind: "percentage", basisPoints: -1000 },
        dateOverrides: [],
      },
      restrictions: { kind: "inherit" },
    },
  ],
};
const sources = { room: "room", terms: "terms", finance: "finance" };
const publication = (stale: boolean) => ({
  currency: "EUR",
  ownerReferences: { finance: "finance", charges: "61000000-0000-4000-8000-00000000000B" },
  rooms: [room],
  revision: 4,
  sources,
  stale,
});
let view: ReactTestRenderer, saved: PricingDraft;
const confirm = vi.fn(),
  publish = vi.fn(),
  reload = vi.fn();
const client = {
  termsAction: vi.fn(),
  readTerms: vi.fn(),
  read: vi.fn(),
  prepare: vi.fn(),
  saveDraft: vi.fn(),
  reviewCharges: vi.fn(),
  confirmationAction: vi.fn(() => confirm),
  publicationAction: vi.fn(() => publish),
  readDraft: vi.fn(),
};
const props = (stale = true, error: unknown = null): PropertyPrices => ({
  prices: {
    client: client as unknown as NonNullable<PropertyPrices["prices"]>["client"],
    publication: publication(stale),
  },
  error,
  reload,
});
const button = (label: string) =>
  view.root.findAllByType("button").find((node) => node.children.join("") === label);
const text = () => JSON.stringify(view.toJSON());
const mount = async (value: PropertyPrices) => {
  await act(async () => {
    view = create(<RoomsPricesStrip {...value} />);
  });
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("React", React);
  client.prepare.mockImplementation(async (value) => ({
    sources,
    snapshot: { ...value, ownerReferences: { finance: "finance" } },
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
  publish.mockResolvedValue({ revision: 5, replayed: false });
  reload.mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => view?.unmount());
  vi.unstubAllGlobals();
});

it("shows the property currency and offers no republish while prices are current", async () => {
  await mount(props(false));
  expect(text()).toContain("All prices are in EUR");
  expect(button("Save prices again")).toBeUndefined();
});
it("republishes a stale publication with every room unchanged; the press declares mandatory charges (VAY-2093)", async () => {
  await mount(props());
  expect(text()).toContain("Prices need to be saved again");
  expect(text()).toContain(
    "By saving, you confirm these prices include all mandatory taxes and fees.",
  );
  await act(async () => button("Save prices again")!.props.onClick());
  expect(client.termsAction).not.toHaveBeenCalled();
  expect(client.prepare).toHaveBeenCalledWith(
    { currency: "EUR", rooms: [{ ...room, revision: 5 }] },
    expect.objectContaining({ baseRevision: 4 }),
  );
  expect(client.confirmationAction).toHaveBeenCalledWith(
    expect.objectContaining({ fingerprint: "fingerprint" }),
    "save_prices",
  );
  expect(client.publicationAction).toHaveBeenCalledWith(
    expect.objectContaining({
      baseRevision: 4,
      snapshot: expect.objectContaining({
        ownerReferences: { finance: "finance", charges: "declaration" },
      }),
    }),
  );
  expect(publish).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
  act(() => view.update(<RoomsPricesStrip {...props(false)} />));
  expect(text()).toContain("Prices saved.");
});
it("resumes an uncertain republish with the same steps, and reloads after a refused one", async () => {
  await mount(props());
  publish.mockRejectedValueOnce(new Error("lost response"));
  await act(async () => button("Save prices again")!.props.onClick());
  expect(text()).toContain("Keep this page open and retry the same action");
  expect(reload).not.toHaveBeenCalled();
  await act(async () => button("Retry last action")!.props.onClick());
  expect(client.prepare).toHaveBeenCalledOnce();
  expect(confirm).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledTimes(2);
  expect(reload).toHaveBeenCalledOnce();
  publish.mockRejectedValueOnce(new ApiErrorResponse(409, { code: "stale" }));
  await act(async () => button("Save prices again")!.props.onClick());
  expect(text()).toContain("Prices changed in the meantime");
  expect(reload).toHaveBeenCalledTimes(2);
  expect(button("Retry last action")).toBeUndefined();
});
it("explains a Finance denial without reloading so it can be saved again after fixing payments", async () => {
  await mount(props());
  client.prepare.mockRejectedValueOnce(
    new ApiErrorResponse(403, { code: "denied", reason: "payments_disabled" }),
  );
  await act(async () => button("Save prices again")!.props.onClick());
  expect(text()).toContain("Payments are switched off for this property");
  expect(reload).not.toHaveBeenCalled();
  expect(button("Save prices again")!.props.disabled).toBe(false);
});
it("keeps the Rooms list usable when prices cannot be read", async () => {
  await mount({ prices: null, error: new Error("offline"), reload });
  expect(text()).toContain("Prices could not be loaded.");
  await act(async () => button("Retry")!.props.onClick());
  expect(reload).toHaveBeenCalledOnce();
});
it("summarises a room's published rates from its lowest base price and links to its Prices tab", async () => {
  expect(lowestBaseMinor(room)).toBe("9000");
  expect(lowestBaseMinor({ ...room, offers: [room.offers[1]] })).toBeNull();
  await act(async () => {
    view = create(
      <RoomPriceSummary
        roomTypeId={room.roomTypeId.toLowerCase()}
        publication={publication(false)}
      />,
    );
  });
  expect(text()).toContain("2 rates · from 90.00 EUR");
  expect(view.root.findByType("a").props.href).toBe(
    `/rooms/${room.roomTypeId.toLowerCase()}?tab=prices`,
  );
  act(() => view.update(<RoomPriceSummary roomTypeId="other" publication={null} />));
  expect(text()).toContain("No prices yet");
  expect(view.root.findByType("a").children.join("")).toBe("Set prices");
});
