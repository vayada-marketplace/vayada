import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreparedHotelImportPanel } from "@vayada/product-onboarding/PreparedHotelImportPanel";
import {
  roomsService,
  individualRoomsService,
  linkedInventoryGroupsService,
  type RoomType,
} from "@/services/rooms";
import RoomsPage from "./page";

vi.mock("@/lib/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/services/api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: async () => "test-property",
}));
vi.mock("@vayada/product-onboarding/PreparedHotelImportPanel", () => ({
  PreparedHotelImportPanel: () => null,
}));

let view: ReactTestRenderer;
const room = { id: "room-1", name: "Existing suite" } as RoomType;
beforeEach(() => {
  vi.spyOn(individualRoomsService, "list").mockResolvedValue([]);
  vi.spyOn(linkedInventoryGroupsService, "list").mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => view?.unmount());
  vi.restoreAllMocks();
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
