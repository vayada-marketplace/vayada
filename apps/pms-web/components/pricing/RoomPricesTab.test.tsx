import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pmsOperationsRoomsReadService, type PmsOperationsRoomType } from "@/services/rooms";
import { forgetKeptNewRoomPrices, readKeptNewRoomPrices } from "./keptNewRoomPrices";
import { PricingEditor } from "./PricingEditor";
import { RoomPricesTab } from "./RoomPricesTab";

vi.mock("@/lib/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const propertyId = "61000000-0000-4000-8000-000000000001";
vi.mock("@/services/api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: async () => propertyId,
}));
vi.mock("./PricingEditor", () => ({ PricingEditor: () => null }));
vi.mock("./keptNewRoomPrices", () => ({
  readKeptNewRoomPrices: vi.fn(() => null),
  forgetKeptNewRoomPrices: vi.fn(),
}));

let view: ReactTestRenderer;
const roomType = (roomTypeId: string, name: string, extra: Partial<PmsOperationsRoomType> = {}) =>
  ({
    roomTypeId,
    name,
    active: true,
    occupancyLimits: { total: 3, adults: 2, children: 1 },
    ...extra,
  }) as PmsOperationsRoomType;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => view?.unmount());
  vi.restoreAllMocks();
});
const mount = async () => {
  await act(async () => {
    view = create(createElement(RoomPricesTab, { roomTypeId: "suite" }));
  });
};

it("edits this room with the property's rooms: names for all, setup only for rooms that can have prices (VAY-2093)", async () => {
  vi.spyOn(pmsOperationsRoomsReadService, "listRoomTypes").mockResolvedValue({
    propertyId,
    items: [
      roomType("suite", "Suite"),
      roomType("closed", "Closed", { active: false }),
      roomType("odd", "Odd", { occupancyLimits: { total: 1, adults: 2, children: 0 } }),
    ],
  } as Awaited<ReturnType<typeof pmsOperationsRoomsReadService.listRoomTypes>>);
  await mount();
  const props = view.root.findByType(PricingEditor).props;
  expect(props.roomTypeId).toBe("suite");
  expect(props.roomNames).toEqual({ suite: "Suite", closed: "Closed", odd: "Odd" });
  expect(props.setup).toEqual({
    propertyId,
    rooms: [{ roomTypeId: "suite", name: "Suite", capacity: { total: 3, adults: 2, children: 1 } }],
  });
});
it("refuses room information from another property", async () => {
  vi.spyOn(pmsOperationsRoomsReadService, "listRoomTypes").mockResolvedValue({
    propertyId: "other",
    items: [],
  } as unknown as Awaited<ReturnType<typeof pmsOperationsRoomsReadService.listRoomTypes>>);
  await mount();
  expect(view.root.findAllByType(PricingEditor)).toHaveLength(0);
  expect(JSON.stringify(view.toJSON())).toContain("pricing.page.roomMismatch");
});
it("hands this room's editor the prices the New room page could not save, for this property only, until saved (VAY-2147)", async () => {
  vi.spyOn(pmsOperationsRoomsReadService, "listRoomTypes").mockResolvedValue({
    propertyId,
    items: [roomType("suite", "Suite")],
  } as Awaited<ReturnType<typeof pmsOperationsRoomsReadService.listRoomTypes>>);
  const kept = {
    room: { propertyId, roomTypeId: "suite" },
    terms: [],
    error: null,
    outcomeUnknown: false,
  };
  vi.mocked(readKeptNewRoomPrices).mockReturnValue(kept as never);
  await mount();
  const editor = () => view.root.findByType(PricingEditor).props;
  expect(editor().kept).toBe(kept);
  expect(readKeptNewRoomPrices).toHaveBeenCalledWith("suite");
  // Kept for a reload until they are saved, or forgotten when they no longer apply.
  expect(forgetKeptNewRoomPrices).not.toHaveBeenCalled();
  act(() => editor().onHandover(true));
  expect(forgetKeptNewRoomPrices).not.toHaveBeenCalled();
  act(() => editor().onPublished());
  expect(forgetKeptNewRoomPrices).toHaveBeenCalledWith("suite");
  vi.mocked(forgetKeptNewRoomPrices).mockClear();
  act(() => editor().onHandover(false));
  expect(forgetKeptNewRoomPrices).toHaveBeenCalledWith("suite");
  act(() => view.unmount());
  vi.mocked(readKeptNewRoomPrices).mockReturnValue({
    ...kept,
    room: { propertyId: "other", roomTypeId: "suite" },
  } as never);
  await mount();
  expect(editor().kept).toBeUndefined();
});
