import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { HotelFirstRunError } from "@/services/api/hotelFirstRunClient";
import type { CanonicalRoomAuthoringState } from "../adaptive/rooms/roomAuthoringState";
import { FourStepHotelSteps, type FourStepHotelStepsProps } from "./FourStepHotelSteps";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const ROOM_TYPE = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";

const firstRunState = (done: readonly string[]) => ({
  contractVersion: "hotel-first-run.v1" as const,
  propertyId: PROPERTY,
  steps: ["currency", "rooms", "payments", "pricing", "calendar", "guest_rules", "plan"].map(
    (id) => ({ id, state: done.includes(id) ? "done" : "todo" }),
  ),
  nextStep: null,
});

const SAVED: CanonicalRoomAuthoringState = {
  draftRoomId: "first-run-room-1",
  roomTypeId: ROOM_TYPE,
  roomFactsRevision: 1,
  roomUnitsRevision: 2,
  roomMediaRevision: 0,
  roomAmenitiesRevision: 1,
  facts: {
    name: "Pool Villa",
    description: "",
    category: "villa",
    occupancy: { maxGuests: 4, maxAdults: 4, maxChildren: 2 },
    beds: [{ type: "king", quantity: 1 }],
    bedrooms: 2,
    bathrooms: 2,
    bathroomType: "private",
    size: { value: 85, unit: "sqm" },
  } as unknown as CanonicalRoomAuthoringState["facts"],
  activeUnitCount: 2,
  photos: [],
  amenityKeys: [],
  amenitiesReviewed: true,
};

function props(overrides: Partial<FourStepHotelStepsProps> = {}) {
  const firstRun = {
    read: vi.fn(async () => firstRunState(["currency"])),
    run: vi.fn(async () => ({ state: firstRunState([]), ran: [], checkoutUrl: null })),
  };
  const rooms = {
    loadWorkspace: vi.fn(async () => [] as CanonicalRoomAuthoringState[]),
    saveRoom: vi.fn(async (input: { room: { photos: { mediaObjectId: string }[] } }) => ({
      ...SAVED,
      photos: input.room.photos.map(({ mediaObjectId }) => ({ mediaObjectId, publicUrl: null })),
    })),
    uploadRoomPhotos: vi.fn(async (input: { files: readonly File[] }) =>
      input.files.map((_file, index) => ({ mediaObjectId: `media-${index + 1}` })),
    ),
    loadPhotoPlan: vi.fn(async () => ({ plan: "commission" as const, maxRoomPhotosPerType: 10 })),
  };
  const value: FourStepHotelStepsProps = {
    propertyId: PROPERTY,
    setup: {
      getPropertyProfile: vi.fn(async () => ({
        propertyId: PROPERTY,
        profileRevision: 2,
        profile: { displayName: "Lumansa Hiriketiya" },
      })),
    } as never,
    firstRun: firstRun as never,
    rooms: rooms as never,
    saveRoomLocation: vi.fn(async () => undefined),
    readCurrency: vi.fn(async () => "LKR"),
    onSaveAndExit: vi.fn(),
    onFinished: vi.fn(),
    ...overrides,
  };
  return { value, firstRun, rooms };
}

async function mount(value: FourStepHotelStepsProps) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<FourStepHotelSteps {...value} />);
  });
  await act(async () => undefined);
  return renderer!;
}

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const button = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.find((node) => node.type === "button" && textOf(node) === label);
const click = (renderer: ReactTestRenderer, label: string) =>
  act(async () => button(renderer, label).props.onClick());
const type = (renderer: ReactTestRenderer, id: string, value: string) =>
  act(async () => renderer.root.findByProps({ id }).props.onChange({ target: { value } }));

describe("FourStepHotelSteps (VAY-2451)", () => {
  it("offers the room or skipping it, with the placeholder price in the hotel's currency", async () => {
    const { value, firstRun } = props();
    const renderer = await mount(value);
    const text = textOf(renderer.root);
    expect(text).toContain("Your first room type");
    expect(text).toContain("Step 3 of 4");
    expect(text).toContain("Rs 100 a night as a placeholder");
    expect(text).toContain("Setting upLumansa Hiriketiya");
    // Steps 1 and 2 aren't reopened from here yet.
    const rail = renderer.root.findByProps({ "aria-label": "Setup steps" }).findAllByType("button");
    expect(rail.map((step) => step.props.disabled)).toEqual([true, true, true, true]);

    await act(async () =>
      renderer.root.findAll((node) => node.props.role === "radio")[1]!.props.onClick(),
    );
    await click(renderer, "Continue");
    expect(textOf(renderer.root)).toContain("How guests pay");
    // Pay at the property is what setup turns on; the others come after setup and aren't choices here.
    expect(textOf(renderer.root)).toContain("On:Pay at the property");
    expect(renderer.root.findAll((node) => node.props.role === "checkbox")).toHaveLength(0);
    await click(renderer, "Finish setup");
    expect(firstRun.run).toHaveBeenCalledWith(PROPERTY, { guestPayment: "pay_at_property" });
    expect(value.onFinished).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it("saves the room basics under the first run's draft id once they have a name and size", async () => {
    const { value, rooms } = props();
    const renderer = await mount(value);
    await click(renderer, "Continue");
    expect(textOf(renderer.root)).toContain("Room basics");
    expect(textOf(renderer.root)).toContain("Step 3 of 4 · Room basics, 1 of 3");
    expect(button(renderer, "Continue").props.disabled).toBe(true);
    expect(textOf(renderer.root)).toContain("Add a room name and size to continue");
    await type(renderer, "setup-room-name", "Pool Villa");
    await type(renderer, "setup-room-size", "85");
    // Two villas of this type, for up to 4 guests: adults follow the total.
    await act(async () =>
      renderer.root.findByProps({ "aria-label": "More rooms" }).props.onClick(),
    );
    for (let guest = 0; guest < 2; guest += 1)
      await act(async () =>
        renderer.root.findByProps({ "aria-label": "More guests" }).props.onClick(),
      );
    await click(renderer, "Continue");
    expect(rooms.saveRoom).toHaveBeenCalledOnce();
    const [{ propertyId, room }] = rooms.saveRoom.mock.calls[0] as unknown as [
      { propertyId: string; room: Record<string, unknown> },
    ];
    expect(propertyId).toBe(PROPERTY);
    expect(room).toMatchObject({
      draftRoomId: "first-run-room-1",
      name: "Pool Villa",
      sizeSquareMetres: "85",
      unitCount: "2",
      maxGuests: "4",
      maxAdults: "4",
      maxChildren: "0",
      bathroomType: "private",
      beds: [{ type: "double", quantity: "1" }],
    });
    // The photos come next: a room can't be sold without one.
    expect(textOf(renderer.root)).toContain("Photos, description & location");
    expect(textOf(renderer.root)).toContain("Step 3 of 4 · Photos & location, 2 of 3");
    renderer.unmount();
  });

  it("takes photos, the description and a separate location, then the amenities", async () => {
    const { value, rooms } = props({ initialStep: "room" });
    rooms.loadWorkspace.mockResolvedValue([SAVED]);
    const renderer = await mount(value);
    await click(renderer, "Continue");
    expect(textOf(renderer.root)).toContain("Photos, description & location");
    expect(button(renderer, "Continue").props.disabled).toBe(true);
    expect(textOf(renderer.root)).toContain("Add at least one photo to continue");
    const URL_ = globalThis.URL as unknown as { createObjectURL?: unknown };
    URL_.createObjectURL = vi.fn(() => "blob:villa");
    const photo = new File(["x"], "villa.jpg", { type: "image/jpeg" });
    const tooBig = { name: "huge.png", type: "image/png", size: 11 * 1024 * 1024 } as File;
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Add room photos" })
        .props.onChange({ target: { files: [photo, tooBig], value: "" } }),
    );
    await act(async () => undefined);
    expect(rooms.uploadRoomPhotos).toHaveBeenCalledWith({
      propertyId: PROPERTY,
      roomTypeId: ROOM_TYPE,
      draftRoomId: "first-run-room-1",
      files: [photo],
    });
    expect(textOf(renderer.root)).toContain("Use JPG, PNG or WebP photos of up to 10 MB.");
    expect(textOf(renderer.root)).toContain("Cover");
    await act(async () =>
      renderer.root
        .findByProps({ id: "setup-room-description" })
        .props.onChange({ target: { value: "A pool villa by the beach." } }),
    );
    await act(async () =>
      renderer.root
        .findAll((node) => node.props.role === "radio")
        .find((node) => textOf(node).startsWith("Separate location"))!
        .props.onClick(),
    );
    expect(button(renderer, "Continue").props.disabled).toBe(true);
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Address of this room" })
        .props.onChange({ target: { value: "Beach Road 7, Hiriketiya" } }),
    );
    await click(renderer, "Continue");
    expect(rooms.saveRoom).toHaveBeenLastCalledWith({
      propertyId: PROPERTY,
      room: expect.objectContaining({
        description: "A pool villa by the beach.",
        photos: [expect.objectContaining({ mediaObjectId: "media-1", uploadState: "ready" })],
      }),
    });
    expect(value.saveRoomLocation).toHaveBeenCalledWith(PROPERTY, ROOM_TYPE, {
      source: "custom",
      address: "Beach Road 7, Hiriketiya",
      showMap: true,
    });

    expect(textOf(renderer.root)).toContain("Step 3 of 4 · Amenities, 3 of 3");
    await act(async () =>
      renderer.root
        .find((node) => node.type === "button" && textOf(node).startsWith("Internet & Tech"))
        .props.onClick(),
    );
    await act(async () =>
      renderer.root
        .find((node) => node.props.role === "checkbox" && textOf(node) === "Free WiFi")
        .props.onClick(),
    );
    expect(textOf(renderer.root)).toContain("1 selected");
    await click(renderer, "Continue");
    expect(rooms.saveRoom).toHaveBeenLastCalledWith({
      propertyId: PROPERTY,
      room: expect.objectContaining({ amenityKeys: ["wifi"], reviewedEmptyAmenities: true }),
    });
    expect(textOf(renderer.root)).toContain("How guests pay");
    renderer.unmount();
  });

  it("shows a room that couldn't be saved, and keeps what was typed", async () => {
    const { value, rooms } = props();
    rooms.saveRoom.mockRejectedValueOnce(new Error("Room type names must be unique."));
    const renderer = await mount(value);
    await click(renderer, "Continue");
    await type(renderer, "setup-room-name", "Pool Villa");
    await type(renderer, "setup-room-size", "85");
    await click(renderer, "Continue");
    expect(textOf(renderer.root)).toContain("Room type names must be unique.");
    expect(renderer.root.findByProps({ id: "setup-room-name" }).props.value).toBe("Pool Villa");
    renderer.unmount();
  });

  it("resumes at the photos of a room without one, at guest payments once it has one, and leaves a finished setup for the dashboard", async () => {
    const noPhoto = props();
    noPhoto.rooms.loadWorkspace.mockResolvedValue([SAVED]);
    const atPhotos = await mount(noPhoto.value);
    expect(textOf(atPhotos.root)).toContain("Photos, description & location");
    atPhotos.unmount();

    const withRoom = props();
    withRoom.rooms.loadWorkspace.mockResolvedValue([
      { ...SAVED, photos: [{ mediaObjectId: "media-1", publicUrl: null }] },
    ]);
    const resumed = await mount(withRoom.value);
    expect(textOf(resumed.root)).toContain("How guests pay");
    expect(withRoom.rooms.loadWorkspace).toHaveBeenCalledWith(
      PROPERTY,
      ["first-run-room-1"],
      expect.anything(),
    );
    resumed.unmount();

    const done = props();
    done.firstRun.read.mockResolvedValue(firstRunState(["payments", "guest_rules", "plan"]));
    await mount(done.value);
    expect(done.value.onSaveAndExit).toHaveBeenCalledOnce();

    // An old link to a step (?step=payments from "Fix in setup") never runs a finished first run again.
    const old = props({ initialStep: "payments" });
    old.firstRun.read.mockResolvedValue(firstRunState(["payments", "guest_rules", "plan"]));
    await mount(old.value);
    expect(old.value.onSaveAndExit).toHaveBeenCalledOnce();
    expect(old.firstRun.run).not.toHaveBeenCalled();

    // A dashboard tile opens the room of a setup that isn't finished.
    const tile = props({ initialStep: "room" });
    tile.rooms.loadWorkspace.mockResolvedValue([SAVED]);
    const opened = await mount(tile.value);
    expect(textOf(opened.root)).toContain("Room basics");
    expect(opened.root.findByProps({ id: "setup-room-name" }).props.value).toBe("Pool Villa");
    opened.unmount();
  });

  it("edits only the room setup made, never another room type of the hotel", async () => {
    const other = {
      ...SAVED,
      draftRoomId: "room:other",
      roomTypeId: "11111111-2222-4333-8444-555555555555",
    };
    const tile = props({ initialStep: "room" });
    tile.rooms.loadWorkspace.mockResolvedValue([other, SAVED]);
    const opened = await mount(tile.value);
    await click(opened, "Continue");
    const [{ room }] = tile.rooms.saveRoom.mock.calls[0] as unknown as [
      { room: Record<string, unknown> },
    ];
    expect(room).toMatchObject({ roomTypeId: ROOM_TYPE });
    opened.unmount();

    // Rooms made elsewhere (Rooms & Rates, an import): no first room needed, and a tile offers a new one.
    const elsewhere = props();
    elsewhere.rooms.loadWorkspace.mockResolvedValue([other]);
    const resumed = await mount(elsewhere.value);
    expect(textOf(resumed.root)).toContain("How guests pay");
    resumed.unmount();
    const fresh = props({ initialStep: "room" });
    fresh.rooms.loadWorkspace.mockResolvedValue([other]);
    const choice = await mount(fresh.value);
    expect(textOf(choice.root)).toContain("Your first room type");
    choice.unmount();
  });

  it("keeps the room on Save & exit once its basics are complete, and Skip leaves an unsaved room alone", async () => {
    const { value, rooms } = props();
    const renderer = await mount(value);
    await click(renderer, "Continue");
    // Not complete yet: nothing to save.
    await type(renderer, "setup-room-name", "Pool Villa");
    await click(renderer, "Skip for now");
    expect(rooms.saveRoom).not.toHaveBeenCalled();
    expect(textOf(renderer.root)).toContain("How guests pay");
    await click(renderer, "Back");
    await click(renderer, "Continue");
    await type(renderer, "setup-room-size", "85");
    await click(renderer, "Save & exit");
    expect(rooms.saveRoom).toHaveBeenCalledOnce();
    expect(value.onSaveAndExit).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it("holds the screen while photos upload, then Save & exit attaches them to the room", async () => {
    const { value, rooms } = props({ initialStep: "room" });
    rooms.loadWorkspace.mockResolvedValue([SAVED]);
    let finishUpload: (value: { mediaObjectId: string }[]) => void = () => undefined;
    rooms.uploadRoomPhotos.mockImplementationOnce(
      () => new Promise((resolve) => (finishUpload = resolve)),
    );
    const renderer = await mount(value);
    await click(renderer, "Continue");
    const URL_ = globalThis.URL as unknown as { createObjectURL?: unknown };
    URL_.createObjectURL = vi.fn(() => "blob:villa");
    await act(async () =>
      renderer.root.findByProps({ "aria-label": "Add room photos" }).props.onChange({
        target: { files: [new File(["x"], "villa.jpg", { type: "image/jpeg" })], value: "" },
      }),
    );
    expect(button(renderer, "Save & exit").props.disabled).toBe(true);
    expect(button(renderer, "Skip for now").props.disabled).toBe(true);
    expect(button(renderer, "Back").props.disabled).toBe(true);
    await act(async () => finishUpload([{ mediaObjectId: "media-7" }]));
    await click(renderer, "Save & exit");
    expect(rooms.saveRoom).toHaveBeenLastCalledWith({
      propertyId: PROPERTY,
      room: expect.objectContaining({
        photos: [expect.objectContaining({ mediaObjectId: "media-7", uploadState: "ready" })],
      }),
    });
    expect(value.onSaveAndExit).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it("says when Finish setup couldn't run, and lets the owner try again", async () => {
    const { value, firstRun } = props({ initialStep: "payments" });
    firstRun.run.mockRejectedValueOnce(new HotelFirstRunError("first_run_in_progress", null, null));
    const renderer = await mount(value);
    await click(renderer, "Finish setup");
    expect(textOf(renderer.root)).toContain("Setup is still finishing from a moment ago");
    expect(value.onFinished).not.toHaveBeenCalled();
    await click(renderer, "Finish setup");
    expect(value.onFinished).toHaveBeenCalledOnce();
    renderer.unmount();
  });
});
