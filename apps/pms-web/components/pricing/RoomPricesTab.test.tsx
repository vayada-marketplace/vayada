import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pmsOperationsRoomsReadService, type PmsOperationsRoomType } from "@/services/rooms";
import { PricingEditor } from "./PricingEditor";
import { RoomPricesTab } from "./RoomPricesTab";

vi.mock("@/lib/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const propertyId = "61000000-0000-4000-8000-000000000001";
vi.mock("@/services/api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: async () => propertyId,
}));
vi.mock("./PricingEditor", () => ({ PricingEditor: () => null }));

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
