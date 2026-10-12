import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NewRoomPage from "./page";

const mocks = vi.hoisted(() => ({
  form: {} as Record<string, any>,
  tab: null as Record<string, any> | null,
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
  create: vi.fn(),
  publish: vi.fn(),
  keep: vi.fn(),
  client: vi.fn((propertyId: string) => ({ propertyId })),
}));
vi.mock("@/lib/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@/services/rooms", () => ({
  roomsService: { getPropertyPlan: async () => null, create: mocks.create },
}));
vi.mock("@/services/api/replacementPricingClient", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createReplacementPricingClient: mocks.client,
}));
vi.mock("@/components/rooms/RoomTypeForm", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.form = props;
    return null;
  },
}));
vi.mock("@/components/pricing/NewRoomPricesTab", () => ({
  NewRoomPricesTab: (props: Record<string, unknown>) => {
    mocks.tab = props;
    return null;
  },
}));
vi.mock("@/components/pricing/newRoomPrices", () => ({
  // The created room's id and guest numbers; prices per guest number that do not fit are refused.
  pricesForRoom: (prices: any, roomTypeId: string, capacity: any) => {
    if (prices.room.perGuest && capacity.adults !== prices.room.capacity.adults)
      throw new Error("guest numbers changed");
    return {
      room: { ...prices.room, roomTypeId, capacity },
      terms: prices.terms.map((terms: any) => ({ ...terms, roomTypeId })),
    };
  },
  publishNewRoomPrices: mocks.publish,
}));
vi.mock("@/components/pricing/keptNewRoomPrices", () => ({ keepNewRoomPrices: mocks.keep }));

const typed = {
  room: {
    roomTypeId: "temporary",
    currency: "EUR",
    capacity: { total: 2, adults: 2, children: 2 },
  },
  terms: [{ roomTypeId: "temporary", offerId: "offer" }],
};
const createdRoom = { id: "created", hotelId: "property" };
let view: ReactTestRenderer;
beforeEach(() => {
  mocks.form = {};
  mocks.tab = null;
  mocks.search = "";
  for (const mock of [
    mocks.push,
    mocks.replace,
    mocks.create,
    mocks.publish,
    mocks.keep,
    mocks.client,
  ])
    mock.mockClear();
  mocks.create.mockReset().mockResolvedValue(createdRoom);
  mocks.publish.mockReset().mockResolvedValue({});
});
afterEach(() => act(() => view?.unmount()));
const mount = async () => {
  await act(async () => {
    view = create(createElement(NewRoomPage));
  });
  await act(async () => mocks.form.onChange({ ...mocks.form.form, name: "Castrop Suite" }));
};
const openPrices = async (take: () => unknown) => {
  await act(async () => mocks.form.onTabChange("prices"));
  mocks.tab!.take.current = take;
};
const submit = () => act(async () => mocks.form.onSubmit({ preventDefault: () => undefined }));
const text = () => JSON.stringify(view.toJSON());

it("creates the room as before when no prices are typed (VAY-2147)", async () => {
  await mount();
  expect(mocks.tab).toBeNull();
  expect(mocks.form.actionNote).toBeUndefined();
  await submit();
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Castrop Suite" }));
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.push).toHaveBeenCalledWith("/rooms");
});

it("creates the room, then saves its typed prices for the created room, saying which step is running", async () => {
  await mount();
  await openPrices(() => typed);
  expect(mocks.form.tab).toBe("prices");
  expect(mocks.tab).toMatchObject({
    room: { name: "Castrop Suite", capacity: { total: 2, adults: 2, children: 2 } },
    locked: false,
  });
  // A leave confirmation waiting in the hidden tab brings the tab to the front.
  await act(async () => mocks.form.onTabChange("details"));
  await act(async () => mocks.tab!.onAttention());
  expect(mocks.form.tab).toBe("prices");
  // Pressing "Create Room Type" declares the typed prices' mandatory charges, on every tab.
  await act(async () => mocks.tab!.onPrices(true));
  expect(mocks.form.actionNote).toBe("pricing.newRoom.declaration");

  let created!: (room: unknown) => void, published!: () => void;
  mocks.create.mockReturnValue(new Promise((resolve) => (created = resolve)));
  mocks.publish.mockReturnValue(new Promise<void>((resolve) => (published = resolve)));
  let pressed!: Promise<void>;
  await act(async () => {
    pressed = mocks.form.onSubmit({ preventDefault: () => undefined });
  });
  expect(mocks.form).toMatchObject({ saving: true, savingLabel: "rooms.new.creatingRoom" });
  expect(mocks.tab!.locked).toBe(true);
  await act(async () => created(createdRoom));
  expect(mocks.form.savingLabel).toBe("rooms.new.savingPrices");
  expect(mocks.client).toHaveBeenCalledWith("property");
  expect(mocks.publish).toHaveBeenCalledWith(
    { propertyId: "property" },
    {
      room: { ...typed.room, roomTypeId: "created" },
      terms: [{ roomTypeId: "created", offerId: "offer" }],
    },
  );
  await act(async () => published());
  await pressed;
  expect(mocks.push).toHaveBeenCalledWith("/rooms");
  expect(mocks.keep).not.toHaveBeenCalled();
});

it("creates one room for a double press", async () => {
  await mount();
  await openPrices(() => typed);
  await act(async () => {
    void mocks.form.onSubmit({ preventDefault: () => undefined });
    void mocks.form.onSubmit({ preventDefault: () => undefined });
  });
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(mocks.publish).toHaveBeenCalledOnce();
});

it("opens the created room's Prices tab with the typed prices when their save fails", async () => {
  await mount();
  await openPrices(() => typed);
  const refused = new Error("refused");
  mocks.publish.mockRejectedValue(refused);
  await submit();
  expect(mocks.keep).toHaveBeenCalledWith(
    expect.objectContaining({ room: expect.objectContaining({ roomTypeId: "created" }) }),
    refused,
  );
  expect(mocks.replace).toHaveBeenCalledWith("/rooms/created?tab=prices");
  expect(mocks.push).not.toHaveBeenCalled();
});

it("saves no prices when the room could not be created, and lets the hotel try again", async () => {
  await mount();
  await openPrices(() => typed);
  mocks.create.mockRejectedValue(new Error("Room facts refused"));
  await submit();
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.form).toMatchObject({ saving: false, error: "Room facts refused" });
  expect(text()).toContain("Room facts refused");
});

it("creates nothing while the prices cannot be saved: an open change, or guest numbers they no longer fit", async () => {
  await mount();
  await openPrices(() => {
    throw new Error("open change");
  });
  await act(async () => mocks.form.onTabChange("details"));
  await submit();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.form).toMatchObject({
    tab: "prices",
    error: "open change rooms.new.removePricesHint",
  });
  mocks.tab!.take.current = () => ({ ...typed, room: { ...typed.room, perGuest: true } });
  await act(async () => mocks.form.onChange({ ...mocks.form.form, maxAdults: 1 }));
  await submit();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.form.error).toBe("guest numbers changed rooms.new.removePricesHint");
  // The Prices tab keeps the last valid guest numbers while they are being typed.
  await act(async () => mocks.form.onChange({ ...mocks.form.form, maxAdults: 5 }));
  expect(mocks.tab!.room.capacity).toEqual({ total: 2, adults: 1, children: 2 });
});

it("finishes onboarding with the room and its prices saved, and starts the next room with empty prices", async () => {
  mocks.search = "onboarding=pms-activation";
  await mount();
  expect(mocks.form.submitLabel).toBe("rooms.new.finishSetup");
  await openPrices(() => typed);
  await act(async () => mocks.tab!.onPrices(true));
  await submit();
  expect(mocks.publish).toHaveBeenCalledOnce();
  expect(text()).toContain("rooms.new.firstRoomPricedDescription");
  expect(text()).toContain("rooms.new.editPrices");
  expect(text()).not.toContain("rooms.new.setPrices");
  const another = view.root
    .findAllByType("button")
    .find((node) => node.children.includes("rooms.new.addAnotherRoomType"))!;
  await act(async () => another.props.onClick());
  expect(mocks.form).toMatchObject({ tab: "details", actionNote: undefined });
  expect(mocks.form.form.name).toBe("");
  expect(view.root.findAll((node) => node.type === "div" && "hidden" in node.props)).toHaveLength(
    0,
  );
});
