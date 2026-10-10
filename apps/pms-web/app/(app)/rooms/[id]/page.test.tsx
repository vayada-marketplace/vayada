import { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import EditRoomPage from "./page";

const mocks = vi.hoisted(() => ({
  form: {} as Record<string, any>,
  tab: {} as Record<string, any>,
  mounts: 0,
  update: vi.fn(),
  reload: vi.fn(),
  stale: false,
}));
vi.mock("@/lib/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/services/rooms", () => ({
  roomsService: {
    get: async () => ({ id: "room-1", name: "Suite" }),
    getPropertyPlan: async () => null,
    update: mocks.update,
    delete: vi.fn(),
  },
  roomTypeUpdateForm: (room: unknown) => ({ ...(room as object) }),
}));
vi.mock("@/components/rooms/RoomTypeForm", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.form = props;
    return null;
  },
}));
vi.mock("@/components/pricing/RoomPricesTab", () => ({
  RoomPricesTab: (props: Record<string, unknown>) => {
    mocks.tab = props;
    useEffect(() => {
      mocks.mounts += 1;
    }, []);
    return null;
  },
}));
vi.mock("@/components/pricing/RoomsPrices", () => ({
  RoomsPricesStrip: () => createElement("section", { "aria-label": "strip" }),
  usePropertyPrices: () => ({
    prices: { publication: { stale: mocks.stale } },
    error: null,
    reload: mocks.reload,
  }),
}));
vi.mock("@/components/ConfirmDialog", () => ({ default: () => null }));

let view: ReactTestRenderer;
beforeEach(() => {
  mocks.mounts = 0;
  mocks.stale = false;
  mocks.update.mockReset();
  mocks.reload.mockReset();
});
afterEach(() => act(() => view?.unmount()));
const pricesPanel = () =>
  view.root.findAll((node) => node.type === "div" && "hidden" in node.props)[0];
const strip = () => view.root.findAllByProps({ "aria-label": "strip" });

it("keeps the Prices tab mounted across tab switches and room-details saves, refreshing it after a save (VAY-2093)", async () => {
  await act(async () => {
    view = create(createElement(EditRoomPage, { params: Promise.resolve({ id: "room-1" }) }));
  });
  expect(mocks.form.tab).toBe("details");
  expect(mocks.mounts).toBe(0);
  await act(async () => mocks.form.onTabChange("prices"));
  expect(mocks.mounts).toBe(1);
  expect(pricesPanel().props.hidden).toBe(false);
  await act(async () => mocks.form.onTabChange("details"));
  expect(pricesPanel().props.hidden).toBe(true);
  expect(mocks.tab.refresh).toBe(0);

  // The save flags stale prices; the form remounts, the Prices tab does not.
  mocks.update.mockResolvedValue({
    roomType: { id: "room-1", name: "Lake Suite" },
    pricesNeedPublishing: true,
  });
  expect(strip()).toHaveLength(0);
  await act(async () => mocks.form.onSubmit({ preventDefault: () => undefined }));
  expect(mocks.mounts).toBe(1);
  expect(mocks.tab.refresh).toBeGreaterThan(0);
  expect(mocks.reload).toHaveBeenCalled();
  expect(strip()).toHaveLength(1);

  // A leave confirmation waiting in the hidden tab brings the tab to the front.
  await act(async () => mocks.tab.onAttention());
  expect(mocks.form.tab).toBe("prices");
  expect(pricesPanel().props.hidden).toBe(false);
});

it("shows the one-click republish when the room page opens on stale prices", async () => {
  mocks.stale = true;
  await act(async () => {
    view = create(createElement(EditRoomPage, { params: Promise.resolve({ id: "room-1" }) }));
  });
  expect(strip()).toHaveLength(1);
});
