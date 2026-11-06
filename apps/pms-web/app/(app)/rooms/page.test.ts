import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreparedHotelImportPanel } from "@vayada/product-onboarding/PreparedHotelImportPanel";
import {
  roomsService,
  individualRoomsService,
  linkedInventoryGroupsService,
  type RoomType,
} from "@/services/rooms";
import LinkedInventoryGroupsPanel from "./LinkedInventoryGroupsPanel";
import RoomsPage from "./page";

vi.mock("@/lib/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/services/api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: async () => "test-property",
}));
const { pricingRead, notSellingRates } = vi.hoisted(() => ({
  pricingRead: vi.fn(),
  notSellingRates: vi.fn(),
}));
vi.mock("@/services/api/replacementPricingClient", () => ({
  createReplacementPricingClient: () => ({ read: pricingRead, notSellingRates }),
}));
const { routerPush, copiedRoomPrices, publishNewRoomPrices, keepNewRoomPrices } = vi.hoisted(
  () => ({
    routerPush: vi.fn(),
    copiedRoomPrices: vi.fn(),
    publishNewRoomPrices: vi.fn(),
    keepNewRoomPrices: vi.fn(),
  }),
);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock("@/components/pricing/newRoomPrices", () => ({ copiedRoomPrices, publishNewRoomPrices }));
vi.mock("@/components/pricing/keptNewRoomPrices", () => ({ keepNewRoomPrices }));
vi.mock("@vayada/product-onboarding/PreparedHotelImportPanel", () => ({
  PreparedHotelImportPanel: () => null,
}));
vi.mock("@/components/settings/airbnbImportHref", () => ({
  airbnbImportHref: (propertyId: string) => `https://admin.test/import/${propertyId}`,
}));

let view: ReactTestRenderer;
const room = { id: "room-1", name: "Existing suite" } as RoomType;
beforeEach(() => {
  pricingRead.mockReset().mockResolvedValue(null);
  notSellingRates.mockReset().mockResolvedValue([]);
  for (const mock of [routerPush, copiedRoomPrices, publishNewRoomPrices, keepNewRoomPrices])
    mock.mockReset();
  vi.spyOn(individualRoomsService, "list").mockResolvedValue([]);
  vi.spyOn(linkedInventoryGroupsService, "list").mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => view?.unmount());
  vi.restoreAllMocks();
  // After the unmount: the menu and drawer remove their document listeners then.
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    view = create(createElement(RoomsPage));
  });
}
async function imported() {
  await act(async () => {
    view.root.findByType(PreparedHotelImportPanel).props.onSaved();
  });
}
const text = () => JSON.stringify(view.toJSON());
const retry = () =>
  view.root.findAllByType("button").find((button) => button.children.includes("common.retry"))!;

it("keeps existing rooms after an import refresh failure and retries reads only", async () => {
  const list = vi.spyOn(roomsService, "list").mockResolvedValue([room]);
  const createRoom = vi.spyOn(roomsService, "create");
  await mount();
  list.mockRejectedValueOnce(new Error("offline"));
  await imported();
  expect(text()).toContain("Existing suite");
  expect(text()).toContain("rooms.loadFailed");
  list.mockResolvedValue([room, { ...room, id: "room-2", name: "Imported loft" }]);
  await act(async () => {
    retry().props.onClick();
  });
  expect(text()).toContain("Imported loft");
  expect(text()).not.toContain("rooms.loadFailed");
  expect(createRoom).not.toHaveBeenCalled();
  expect(list).toHaveBeenCalledTimes(3);
});

it("does not present a failed initial load as an empty hotel", async () => {
  vi.spyOn(roomsService, "list").mockRejectedValue(new Error("offline"));
  await mount();
  expect(text()).toContain("rooms.loadFailed");
  expect(text()).not.toContain("rooms.noRoomTypes");
});

it("ignores a late failed read after a newer import refresh succeeds", async () => {
  let rejectOld!: (cause: Error) => void;
  const list = vi.spyOn(roomsService, "list").mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectOld = reject;
      }),
  );
  await mount();
  list.mockResolvedValue([room]);
  await imported();
  await act(async () => {
    rejectOld(new Error("old failure"));
  });
  expect(text()).toContain("Existing suite");
  expect(text()).not.toContain("rooms.loadFailed");
});

it("shows each room's published prices with a link to its Prices tab (VAY-2093)", async () => {
  // An unreadable list of rates that aren't selling leaves them all counted, as on the Prices tab (VAY-2466).
  notSellingRates.mockRejectedValue(new Error("offline"));
  pricingRead.mockResolvedValue({
    currency: "EUR",
    revision: 2,
    stale: false,
    ownerReferences: { finance: "finance" },
    rooms: [
      {
        version: "pricing.v2",
        propertyId: "test-property",
        roomTypeId: "ROOM-1",
        revision: 2,
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
                base: { mode: "flat", amountMinor: "12000" },
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
  });
  vi.spyOn(roomsService, "list").mockResolvedValue([room, { ...room, id: "room-2", name: "Loft" }]);
  await mount();
  // The subtitle carries the currency; each row shows "from …" over its rates (VAY-2338).
  expect(text()).toContain("rooms.roomTypeCount.other · rooms.roomCount.other · rooms.pricesIn");
  expect(text()).toContain("pricing.list.from");
  expect(text()).not.toContain("pricing.list.loadFailed");
  expect(text()).toContain("pricing.list.rates.one · pricing.list.perNight");
  const links = view.root
    .findAllByType("a")
    .filter((node) => String(node.props.href).endsWith("?tab=prices"));
  expect(links.map((node) => [node.props.href, node.children.join("")])).toEqual([
    ["/rooms/room-1?tab=prices", "pricing.list.editPrices"],
    ["/rooms/room-2?tab=prices", "pricing.list.setPrices"],
  ]);
});

it("keeps the setup tools in the ☰ menu and opens Linked inventory in a drawer (VAY-2338)", async () => {
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(roomsService, "list").mockResolvedValue([room]);
  vi.spyOn(individualRoomsService, "list").mockResolvedValue([
    { id: "unit-1", roomTypeId: "room-1" },
    { id: "unit-2", roomTypeId: "room-1" },
  ] as Awaited<ReturnType<typeof individualRoomsService.list>>);
  await mount();
  // No search box and no setup cards above the list.
  expect(view.root.findAllByType("input")).toHaveLength(0);
  expect(text()).not.toContain("rooms.menu.importAirbnb");
  expect(view.root.findAllByType(LinkedInventoryGroupsPanel)).toHaveLength(0);

  await act(async () =>
    view.root.findByProps({ "aria-label": "rooms.menu.label" }).props.onClick(),
  );
  const airbnb = view.root.findByProps({ href: "https://admin.test/import/test-property" });
  expect(airbnb.props.target).toBe("_blank");
  expect(view.root.findAllByProps({ href: "/calendar?reorder=1" })).toHaveLength(1);
  const linked = view.root
    .findAllByType("button")
    .find(
      (button) => button.findAll((node) => node.children.includes("rooms.linkedInventory")).length,
    )!;
  await act(async () => linked.props.onClick());
  expect(text()).not.toContain("rooms.menu.importAirbnb");
  expect(view.root.findByProps({ role: "dialog" }).props["aria-labelledby"]).toBe(
    "linked-inventory-title",
  );
  expect(view.root.findAllByType(LinkedInventoryGroupsPanel)).toHaveLength(1);
});

it("offers no room reordering with a single room", async () => {
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(roomsService, "list").mockResolvedValue([room]);
  vi.spyOn(individualRoomsService, "list").mockResolvedValue([
    { id: "unit-1", roomTypeId: "room-1" },
  ] as Awaited<ReturnType<typeof individualRoomsService.list>>);
  await mount();
  await act(async () =>
    view.root.findByProps({ "aria-label": "rooms.menu.label" }).props.onClick(),
  );
  expect(view.root.findAllByProps({ href: "/calendar?reorder=1" })).toHaveLength(0);
});

describe("Duplicate (VAY-2487)", () => {
  const copy = { ...room, id: "room-copy", hotelId: "test-property", name: "Existing suite Copy" };
  const read = { currency: "EUR", revision: 3, rooms: [], stale: false };
  const prices = { room: { roomTypeId: "room-copy" }, terms: [] };
  // The original's button: the first row.
  const duplicateButton = () =>
    view.root.findAllByProps({ "aria-label": "rooms.duplicateRoomType" })[0];
  async function duplicate() {
    await act(async () => duplicateButton().props.onClick({ stopPropagation: () => undefined }));
  }
  const list = () => vi.mocked(roomsService.list);
  beforeEach(() => {
    vi.spyOn(roomsService, "list").mockResolvedValue([room]);
    vi.spyOn(roomsService, "duplicate").mockResolvedValue(copy as RoomType);
    copiedRoomPrices.mockResolvedValue(prices);
    publishNewRoomPrices.mockResolvedValue(undefined);
  });

  it("saves the original's prices for the copy from one read, then shows both rooms with their prices", async () => {
    await mount();
    pricingRead.mockClear();
    pricingRead.mockResolvedValueOnce(read);
    list().mockResolvedValue([room, copy as RoomType]);
    await duplicate();
    expect(roomsService.duplicate).toHaveBeenCalledWith("room-1");
    const client = copiedRoomPrices.mock.calls[0][0];
    expect(copiedRoomPrices).toHaveBeenCalledWith(client, read, "room-1", "room-copy");
    expect(publishNewRoomPrices).toHaveBeenCalledWith(client, prices, read);
    // The list and its prices are read again after the save.
    expect(pricingRead).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Existing suite Copy");
    expect(text()).not.toContain("rooms.duplicatePricesNotCopied");
    expect(keepNewRoomPrices).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(duplicateButton().props.disabled).toBe(false);
  });

  it("copies no prices when the original has none", async () => {
    copiedRoomPrices.mockResolvedValue(null);
    await mount();
    await duplicate();
    expect(publishNewRoomPrices).not.toHaveBeenCalled();
    expect(text()).not.toContain("rooms.duplicatePricesNotCopied");
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("opens the copy's Prices tab on the copied prices when their save fails", async () => {
    const refused = new Error("refused");
    publishNewRoomPrices.mockRejectedValue(refused);
    await mount();
    await duplicate();
    expect(keepNewRoomPrices).toHaveBeenCalledWith(prices, refused);
    expect(routerPush).toHaveBeenCalledWith("/rooms/room-copy?tab=prices");
  });

  it("keeps the copied prices for the copy's Prices tab without opening it once the list is left", async () => {
    let refuse!: (cause: Error) => void;
    publishNewRoomPrices.mockReturnValue(
      new Promise((_, reject) => {
        refuse = reject;
      }),
    );
    await mount();
    await duplicate();
    // The host leaves the Rooms list while the prices are still saving.
    act(() => view.update(createElement("div")));
    await act(async () => refuse(new Error("refused")));
    expect(keepNewRoomPrices).toHaveBeenCalledWith(prices, expect.any(Error));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("says the prices weren't copied when the original's prices can't be read", async () => {
    copiedRoomPrices.mockRejectedValue(new Error("offline"));
    await mount();
    list().mockResolvedValue([room, copy as RoomType]);
    await duplicate();
    expect(publishNewRoomPrices).not.toHaveBeenCalled();
    expect(keepNewRoomPrices).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(text()).toContain("rooms.duplicatePricesNotCopied");
    // The copy exists: the list shows it.
    expect(text()).toContain("Existing suite Copy");
  });

  it("keeps the old message when the room type itself can't be duplicated", async () => {
    vi.mocked(roomsService.duplicate).mockRejectedValue(new Error(""));
    await mount();
    await duplicate();
    expect(copiedRoomPrices).not.toHaveBeenCalled();
    expect(text()).toContain("rooms.failedToDuplicate");
  });
});
