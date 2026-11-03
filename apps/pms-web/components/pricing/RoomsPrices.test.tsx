import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";
import type { PricingDraft, PricingSnapshot } from "@/services/api/replacementPricingClient";
import {
  listPrice,
  RoomPriceSummary,
  RoomPricesLink,
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
  children: {
    adultFromAge: 12,
    bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
  },
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
    notSelling: [],
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

it("shows nothing on the Rooms list while prices are current: the subtitle names the currency (VAY-2338)", async () => {
  await mount(props(false));
  expect(view.toJSON()).toBeNull();
});
it("tells the Rooms list how to start when nothing is published yet", async () => {
  await mount({ prices: { ...props(false).prices!, publication: null }, error: null, reload });
  expect(text()).toContain("No prices yet. Open a room's Prices tab");
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
  const denied = { code: "denied", reason: "payments_disabled" };
  client.prepare.mockRejectedValueOnce(new ApiErrorResponse(403, denied));
  await act(async () => button("Save prices again")!.props.onClick());
  expect(text()).toContain("payments are switched off for this property");
  expect(reload).not.toHaveBeenCalled();
  expect(button("Save prices again")!.props.disabled).toBe(false);
});
it("keeps the Rooms list usable when prices cannot be read", async () => {
  await mount({ prices: null, error: new Error("offline"), reload });
  expect(text()).toContain("Prices could not be loaded.");
  await act(async () => button("Retry")!.props.onClick());
  expect(reload).toHaveBeenCalledOnce();
});
it("summarises a room's published rates from the lowest night guests can book and links to its Prices tab", async () => {
  const id = room.roomTypeId.toLowerCase();
  await act(async () => {
    view = create(
      <>
        <RoomPriceSummary roomTypeId={id} publication={publication(false)} />
        <RoomPricesLink roomTypeId={id} publication={publication(false)} />
      </>,
    );
  });
  // VAY-2466: 1 adult's €90 at the saver rate's 10% off, as the Prices tab's "Guests from" counts it.
  expect(text()).toContain(`from ${listPrice("8100", "EUR", "en")}`);
  expect(text()).toContain("2 rates · per night");
  expect(view.root.findByType("a").props.href).toBe(`/rooms/${id}?tab=prices`);
  // A rate guests can't book now (VAY-2304) doesn't count: the flexible rate's €90.
  act(() =>
    view.update(
      <>
        <RoomPriceSummary
          roomTypeId={id}
          publication={publication(false)}
          notSelling={[
            { roomTypeId: room.roomTypeId, offerId: "saver", reason: "card_off", fixes: [] },
          ]}
        />
        <RoomPricesLink roomTypeId={id} publication={publication(false)} />
      </>,
    ),
  );
  expect(text()).toContain(`from ${listPrice("9000", "EUR", "en")}`);
  expect(view.root.findByType("a").children.join("")).toBe("Edit prices");
  act(() =>
    view.update(
      <>
        <RoomPriceSummary roomTypeId="other" publication={null} />
        <RoomPricesLink roomTypeId="other" publication={null} />
      </>,
    ),
  );
  expect(text()).toContain("No prices yet");
  expect(text()).toContain("Guests can't book it yet");
  expect(view.root.findByType("a").children.join("")).toBe("Set prices");
});
it("counts seasons and single dates from today on in the list's from price (VAY-2466)", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 3, 12));
  const flex = room.offers[0]!;
  const calendar = flex.price.kind === "independent" ? flex.price.calendar : null;
  const seasonal = {
    ...room,
    offers: [
      {
        ...flex,
        price: {
          kind: "independent" as const,
          calendar: {
            ...calendar!,
            seasons: [
              {
                name: "Low",
                tier: "",
                from: "11-01",
                through: "12-31",
                price: { mode: "occupancy" as const, amountsMinor: ["7000", "8000"] },
              },
            ],
            // Yesterday's €40 is past; the 20th's €60 counts.
            dates: [
              { date: "2026-11-02", price: { mode: "flat" as const, amountMinor: "4000" } },
              { date: "2026-11-20", price: { mode: "flat" as const, amountMinor: "6000" } },
            ],
          },
        },
      },
      room.offers[1]!,
    ],
  };
  try {
    await act(async () => {
      view = create(
        <RoomPriceSummary
          roomTypeId={room.roomTypeId}
          publication={{ ...publication(false), rooms: [seasonal] }}
        />,
      );
    });
    // The 20th at the saver rate's 10% off.
    expect(text()).toContain(`from ${listPrice("5400", "EUR", "en")}`);
  } finally {
    vi.useRealTimers();
  }
});
it("writes list prices with the currency code and grouped digits, without .00 on whole amounts (VAY-2338)", () => {
  const plain = (value: string) => value.replace(/\s/g, " ");
  expect(plain(listPrice("87500000", "IDR", "en"))).toBe("IDR 875,000");
  expect(plain(listPrice("12050", "EUR", "en"))).toBe("EUR 120.50");
  expect(plain(listPrice("12000", "EUR", "en"))).toBe("EUR 120");
  expect(plain(listPrice("87500000", "IDR", "de"))).toBe("875.000 IDR");
  expect(plain(listPrice("12000", "JPY", "en"))).toBe("JPY 12,000");
  expect(plain(listPrice("1250", "KWD", "en"))).toBe("KWD 1.250");
});
it("on a room page shows only a stale publication's republish, or that prices could not be checked", async () => {
  const onSaved = vi.fn();
  await act(async () => {
    view = create(<RoomsPricesStrip {...props(false)} staleOnly onSaved={onSaved} />);
  });
  expect(view.toJSON()).toBeNull();
  act(() =>
    view.update(
      <RoomsPricesStrip prices={null} error={new Error("offline")} reload={reload} staleOnly />,
    ),
  );
  expect(text()).toContain("Prices could not be loaded.");
  act(() => view.update(<RoomsPricesStrip {...props()} staleOnly onSaved={onSaved} />));
  expect(text()).toContain("Prices need to be saved again");
  expect(text()).not.toContain("All prices are in EUR");
  await act(async () => button("Save prices again")!.props.onClick());
  expect(publish).toHaveBeenCalledOnce();
  expect(onSaved).toHaveBeenCalledOnce();
  act(() => view.update(<RoomsPricesStrip {...props(false)} staleOnly onSaved={onSaved} />));
  expect(text()).toContain("Prices saved.");
});
