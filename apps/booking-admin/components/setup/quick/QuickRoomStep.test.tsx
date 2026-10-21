import { renderToStaticMarkup } from "react-dom/server";
import { useState } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { QuickPropertySetup, quickRoomStorageKey } from "./QuickPropertySetup";
import { QuickRoomStep, type QuickRoomStepProps } from "./QuickRoomStep";
import {
  EMPTY_QUICK_ROOM_DRAFT,
  parseQuickRoomsDraft,
  quickRoomErrors,
  quickRoomFirstNumbers,
  quickRoomLabelsHint,
  quickRoomRequest,
  quickRoomsFirstError,
  type QuickRoomDraft,
  type QuickRoomsDraft,
} from "./quickRoomDraft";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const FILLED: QuickRoomDraft = {
  name: "Classic Double",
  numberOfRooms: "8",
  maxGuests: "2",
  pricePerNight: "145",
};
const DRAFT: QuickRoomsDraft = { rooms: [FILLED], pricesIncludeMandatoryCharges: true };

function props(overrides: Partial<QuickRoomStepProps> = {}): QuickRoomStepProps {
  return {
    draft: DRAFT,
    onChange: vi.fn(),
    currency: { code: "EUR", symbol: "€" },
    hotel: {
      name: "Hotel Alpenrose",
      place: "Sendlinger Straße 12, Munich",
      url: "hotel-alpenrose.booking.vayada.com",
    },
    onSubmit: vi.fn(async () => undefined),
    onSaveAndExit: vi.fn(),
    ...overrides,
  };
}

const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
const nodeText = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : nodeText(child))).join("");
async function submit(renderer: ReactTestRenderer) {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

describe("QuickRoomStep (VAY-2247 step 3)", () => {
  it("shows the room, its price in the hotel's currency and the defaults, with the room in the preview", () => {
    const markup = renderToStaticMarkup(<QuickRoomStep {...props()} />);
    expect(markup).toContain("Step 5 of 7");
    expect(markup).toContain("Your first room and price");
    expect(markup).toContain("We create Room 1–8 in the PMS. Rename them later.");
    expect(markup).toContain(">EUR<");
    expect(markup).toContain("My prices include all mandatory taxes and fees");
    expect(markup).toContain("Free cancellation until 3 days before arrival");
    expect(markup).toContain("One double bed per room");
    expect(markup).toContain("Up to 2 guests · Free cancellation until 3 days before");
    expect(markup).toContain("€145");
    expect(markup).toContain("Add another room type");
    // The first run takes both choices (1.12b): each default has its Change link.
    expect(markup.match(/>Change</g)).toHaveLength(2);
    expect(markup).toContain("Our default. After that, the full stay is charged.");
  });

  it("changes the free cancellation for every room type; Non-refundable shows but can't be picked (1.12b)", async () => {
    let current: QuickRoomsDraft = DRAFT;
    const onChange = vi.fn((next: QuickRoomsDraft) => {
      current = next;
    });
    function Harness() {
      const [draft, setDraft] = useState(DRAFT);
      return (
        <QuickRoomStep
          {...props({
            draft,
            onChange: (next) => {
              onChange(next);
              setDraft(next);
            },
          })}
        />
      );
    }
    const renderer = create(<Harness />);
    const change = () =>
      renderer.root.findAll((node) => node.type === "button" && nodeText(node) === "Change");
    await act(async () => change()[0]!.props.onClick());
    const radios = renderer.root.findAll(
      (node) => node.type === "input" && node.props.name === "quick-cancellation",
    );
    expect(radios.map((radio) => nodeText(radio.parent!))).toEqual([
      "Free until 1 day before arrival",
      "Free until 3 days before arrival",
      "Free until 7 days before arrival",
      "Free until 14 days before arrival",
      "Non-refundableNeeds online card payments. Set it later in Rooms & Rates once cards are on.",
    ]);
    expect(radios.map((radio) => radio.props.checked)).toEqual([false, true, false, false, false]);
    expect(radios[4]!.props.disabled).toBe(true);
    await act(async () => radios[2]!.props.onChange());
    expect(current.freeCancellationDays).toBe(7);
    expect(nodeText(renderer.root)).toContain("Free cancellation until 7 days before arrival");
    expect(nodeText(renderer.root)).toContain(
      "Up to 2 guests · Free cancellation until 7 days before",
    );
    // Done closes it; the line no longer says it is our default.
    const done = renderer.root.findAll(
      (node) => node.type === "button" && nodeText(node) === "Done",
    );
    expect(done[0]!.props["aria-expanded"]).toBe(true);
    await act(async () => done[0]!.props.onClick());
    expect(
      renderer.root.findAll(
        (node) => node.type === "input" && node.props.name === "quick-cancellation",
      ),
    ).toHaveLength(0);
    expect(nodeText(renderer.root)).not.toContain("Our default. After that");
    renderer.unmount();
  });

  it("changes the beds for every room type, two twin beds for a twin room (1.12b)", async () => {
    const onChange = vi.fn();
    const renderer = create(<QuickRoomStep {...props({ onChange })} />);
    const change = renderer.root.findAll(
      (node) => node.type === "button" && nodeText(node) === "Change",
    );
    await act(async () => change[1]!.props.onClick());
    const radios = renderer.root.findAll(
      (node) => node.type === "input" && node.props.name === "quick-bed",
    );
    expect(radios.map((radio) => nodeText(radio.parent!))).toEqual([
      "One double bed",
      "One queen bed",
      "One king bed",
      "Two twin beds",
      "One single bed",
    ]);
    await act(async () => radios[3]!.props.onChange());
    expect(onChange).toHaveBeenLastCalledWith({ ...DRAFT, bed: "twin" });
    renderer.unmount();
    const twin = renderToStaticMarkup(
      <QuickRoomStep {...props({ draft: { ...DRAFT, bed: "twin" } })} />,
    );
    expect(twin).toContain("Two twin beds per room");
  });

  it("keeps saved choices the first run still takes and drops the others", () => {
    expect(
      parseQuickRoomsDraft({ rooms: [FILLED], freeCancellationDays: 14, bed: "king" }),
    ).toMatchObject({ freeCancellationDays: 14, bed: "king" });
    const dropped = parseQuickRoomsDraft({
      rooms: [FILLED],
      freeCancellationDays: 5,
      bed: "bunk_bed",
    });
    expect(dropped).not.toHaveProperty("freeCancellationDays");
    expect(dropped).not.toHaveProperty("bed");
  });

  it("asks for what is missing, including the taxes tick, before going on", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const renderer = create(
      <QuickRoomStep
        {...props({
          draft: {
            rooms: [{ ...FILLED, numberOfRooms: "0", pricePerNight: "" }],
            pricesIncludeMandatoryCharges: false,
          },
          onSubmit,
        })}
      />,
    );
    await submit(renderer);
    expect(onSubmit).not.toHaveBeenCalled();
    for (const message of [
      "Enter at least 1 room.",
      "Enter a price per night.",
      "Confirm that your prices include taxes and fees.",
    ])
      expect(text(renderer)).toContain(message);
    renderer.unmount();
  });

  it("goes on with a complete room", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const renderer = create(<QuickRoomStep {...props({ onSubmit })} />);
    await submit(renderer);
    expect(onSubmit).toHaveBeenCalledWith(DRAFT);
    renderer.unmount();
  });
});

describe("QuickRoomStep room types (VAY-2247 1.12, Paper rev 4 a05-1)", () => {
  const textOf = (node: ReactTestInstance): string =>
    node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
  const SUITE: QuickRoomDraft = {
    name: "Alpine Suite",
    numberOfRooms: "4",
    maxGuests: "3",
    pricePerNight: "210",
  };

  /** The step with its draft kept in state, as QuickPropertySetup keeps it. */
  async function mountSteps(initial: QuickRoomsDraft) {
    const seen: { draft: QuickRoomsDraft } = { draft: initial };
    const onSubmit = vi.fn(async () => undefined);
    function Harness() {
      const [draft, setDraft] = useState(initial);
      seen.draft = draft;
      return <QuickRoomStep {...props({ draft, onChange: setDraft, onSubmit })} />;
    }
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness />);
    });
    const r = renderer!;
    const click = async (label: string) => {
      const button = r.root.findAll(
        (node) => node.type === "button" && textOf(node).includes(label),
      )[0]!;
      await act(async () => button.props.onClick());
    };
    const type = async (index: number, value: string) => {
      await act(async () =>
        r.root.findAllByType("input")[index]!.props.onChange({ target: { value } }),
      );
    };
    return { r, seen, click, type, onSubmit, text: () => textOf(r.root) };
  }

  it("adds a room type once the current one is complete, numbering its rooms on", async () => {
    const step = await mountSteps({
      rooms: [{ ...FILLED, pricePerNight: "" }],
      pricesIncludeMandatoryCharges: true,
    });
    await step.click("Add another room type");
    expect(step.seen.draft.rooms).toHaveLength(1);
    expect(step.text()).toContain("Enter a price per night.");

    await step.type(3, "145");
    await step.click("Add another room type");
    expect(step.seen.draft.rooms).toHaveLength(2);
    // The first room type is one line with Edit; the new one is the form.
    expect(step.text()).toContain("Classic Double8 rooms · up to 2 guests · €145 / nightEdit");
    expect(step.text()).toContain("New room type");
    const values = ["Alpine Suite", "4", "3", "210"];
    for (let index = 0; index < values.length; index += 1) await step.type(index, values[index]!);
    expect(step.text()).toContain("We create Room 9–12 in the PMS. Rename them later.");
    await submit(step.r);
    expect(step.onSubmit).toHaveBeenCalledWith({
      rooms: [FILLED, SUITE],
      pricesIncludeMandatoryCharges: true,
    });
    step.r.unmount();
  });

  it("refuses a second room type with the same name", async () => {
    const step = await mountSteps({
      rooms: [FILLED, { ...SUITE, name: "classic double" }],
      pricesIncludeMandatoryCharges: true,
    });
    await submit(step.r);
    expect(step.onSubmit).not.toHaveBeenCalled();
    expect(step.text()).toContain("You already have a room type with this name.");
    step.r.unmount();
  });

  it("edits an earlier room type, drops an empty new one, and removes one", async () => {
    const step = await mountSteps({ rooms: [FILLED, SUITE], pricesIncludeMandatoryCharges: true });
    // Editing Classic Double: Alpine Suite becomes the line.
    await step.click("Edit");
    expect(step.text()).toContain("Alpine Suite4 rooms · up to 3 guests · €210 / nightEdit");
    await step.type(0, "Classic Queen");
    expect(step.seen.draft.rooms[0]!.name).toBe("Classic Queen");

    // A room type added and left empty goes away when another one is opened.
    await step.click("Add another room type");
    expect(step.seen.draft.rooms).toHaveLength(3);
    await step.click("Edit");
    expect(step.seen.draft.rooms).toHaveLength(2);

    // Remove takes the room type being edited away (never the first).
    await step.click("Edit");
    expect(step.text()).toContain("Remove");
    await step.click("Remove");
    expect(step.seen.draft.rooms.map((room) => room.name)).toEqual(["Classic Queen"]);
    expect(step.text()).not.toContain("Remove");
    step.r.unmount();
  });

  it("opens the first room type that still needs something when Continue is pressed", async () => {
    const step = await mountSteps({
      rooms: [{ ...FILLED, numberOfRooms: "" }, SUITE],
      pricesIncludeMandatoryCharges: true,
    });
    await submit(step.r);
    expect(step.onSubmit).not.toHaveBeenCalled();
    expect(step.text()).toContain("Enter at least 1 room.");
    expect(step.text()).toContain("Alpine Suite4 rooms · up to 3 guests · €210 / nightEdit");
    step.r.unmount();
  });

  it("stops at ten room types", () => {
    const markup = renderToStaticMarkup(
      <QuickRoomStep
        {...props({
          draft: {
            rooms: Array.from({ length: 10 }, (_, index) => ({ ...FILLED, name: `Type ${index}` })),
            pricesIncludeMandatoryCharges: true,
          },
        })}
      />,
    );
    expect(markup).not.toContain("Add another room type");
  });
});

describe("quickRoomDraft", () => {
  it("uses the server's rules for rooms, guests and the price", () => {
    expect(quickRoomErrors(FILLED, "EUR")).toEqual({});
    expect(quickRoomErrors({ ...FILLED, numberOfRooms: "201" }, "EUR")).toEqual({
      numberOfRooms: "Enter up to 200 rooms; add more later in Rooms & Rates.",
    });
    expect(quickRoomErrors({ ...FILLED, pricePerNight: "145.555" }, "EUR")).toEqual({
      pricePerNight: "Enter a price like 145 or 145.50.",
    });
    expect(quickRoomErrors({ ...FILLED, pricePerNight: "0" }, "EUR")).toHaveProperty(
      "pricePerNight",
    );
    expect(quickRoomErrors({ ...FILLED, maxGuests: "" }, "EUR")).toHaveProperty("maxGuests");
    expect(quickRoomErrors(EMPTY_QUICK_ROOM_DRAFT, "EUR")).toMatchObject({
      name: "Enter a name for this room type.",
    });
    // Room type names are unique in a hotel (the PMS ignores case).
    expect(quickRoomErrors(FILLED, "EUR", ["Garden Suite", " classic double "])).toEqual({
      name: "You already have a room type with this name.",
    });
    expect(
      quickRoomsFirstError(
        {
          rooms: [FILLED, { ...FILLED, name: "Garden Suite", pricePerNight: "" }],
          pricesIncludeMandatoryCharges: true,
        },
        "EUR",
      ),
    ).toEqual({ index: 1, errors: { pricePerNight: "Enter a price per night." } });
  });

  it("builds the first-run room and the rooms hint", () => {
    expect(quickRoomRequest({ ...FILLED, name: " Classic Double " })).toEqual({
      name: "Classic Double",
      numberOfRooms: 8,
      maxGuests: 2,
      pricePerNight: "145",
    });
    expect(quickRoomLabelsHint("1")).toBe("We create Room 1 in the PMS. Rename it later.");
    expect(quickRoomLabelsHint("")).toBeNull();
    // Names count on across room types, as the first run names them.
    expect(quickRoomFirstNumbers([FILLED, { ...FILLED, numberOfRooms: "x" }, FILLED])).toEqual([
      1, 9, 9,
    ]);
    expect(quickRoomLabelsHint("4", 9)).toBe("We create Room 9–12 in the PMS. Rename them later.");
  });

  it("reads a saved draft in this version's shape or the first version's single room", () => {
    expect(parseQuickRoomsDraft({ ...FILLED, pricesIncludeMandatoryCharges: true })).toEqual(DRAFT);
    expect(parseQuickRoomsDraft(DRAFT)).toEqual(DRAFT);
    expect(parseQuickRoomsDraft({ rooms: [], pricesIncludeMandatoryCharges: false })).toEqual({
      rooms: [EMPTY_QUICK_ROOM_DRAFT],
      pricesIncludeMandatoryCharges: false,
    });
    expect(parseQuickRoomsDraft(null)).toBeNull();
  });
});

describe("QuickPropertySetup (VAY-2247 steps 3–5)", () => {
  function storage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
  }
  const setup = {
    getPropertyProfile: vi.fn(async () => ({
      profile: {
        displayName: "Hotel Alpenrose",
        location: { streetAddress: "Sendlinger Straße 12", city: "Munich", countryCode: "DE" },
      },
    })),
  } as never;

  it("loads the hotel for the preview, keeps the room on this device and goes on to step 4", async () => {
    const kept = storage({
      // Saved by the first version: one room with its tick.
      [quickRoomStorageKey(PROPERTY)]: JSON.stringify({
        ...FILLED,
        name: "Garden Suite",
        pricesIncludeMandatoryCharges: true,
      }),
    });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <QuickPropertySetup
          propertyId={PROPERTY}
          initialStep={3}
          setup={setup}
          readCurrency={async () => "CHF"}
          firstRun={{ run: vi.fn() } as never}
          readCheckoutPending={async () => false}
          openCheckout={vi.fn()}
          storage={kept}
          onSaveAndExit={vi.fn()}
          publication={{ load: vi.fn(), publish: vi.fn() }}
          organizationId="9a8b7c6d-5e4f-4a3b-8c2d-1e0f99887766"
          publicationStorage={storage()}
          openPage={vi.fn()}
        />,
      );
    });
    expect(text(renderer!)).toContain("Garden Suite");
    expect(text(renderer!)).toContain("hotel-alpenrose.booking.vayada.com");
    expect(text(renderer!)).toContain("CHF");
    await act(async () =>
      renderer!.root
        .findAllByType("input")[0]!
        .props.onChange({ target: { value: "Garden Suite Deluxe" } }),
    );
    expect(JSON.parse(kept.values.get(quickRoomStorageKey(PROPERTY))!)).toEqual({
      rooms: [{ ...FILLED, name: "Garden Suite Deluxe" }],
      pricesIncludeMandatoryCharges: true,
    });
    await submit(renderer!);
    // On to step 4 (How guests pay), with the room in its preview.
    expect(text(renderer!)).toContain("How guests pay");
    expect(text(renderer!)).toContain("Garden Suite Deluxe");
    renderer!.unmount();
  });

  it("goes back to Your hotel for this hotel from step 3", async () => {
    const onEditHotel = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <QuickPropertySetup
          propertyId={PROPERTY}
          initialStep={3}
          setup={setup}
          readCurrency={async () => "EUR"}
          firstRun={{ run: vi.fn() } as never}
          readCheckoutPending={async () => false}
          openCheckout={vi.fn()}
          storage={storage()}
          onSaveAndExit={vi.fn()}
          publication={{ load: vi.fn(), publish: vi.fn() }}
          organizationId="9a8b7c6d-5e4f-4a3b-8c2d-1e0f99887766"
          publicationStorage={storage()}
          openPage={vi.fn()}
          onEditHotel={onEditHotel}
        />,
      );
    });
    const back = renderer!.root.findAll(
      (node) => node.type === "button" && node.props.children === "Back",
    );
    expect(back.length).toBeGreaterThan(0);
    await act(async () => back[0]!.props.onClick());
    expect(onEditHotel).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it("uses the country's currency until the first run saved one", async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <QuickPropertySetup
          propertyId={PROPERTY}
          initialStep={3}
          setup={setup}
          readCurrency={async () => null}
          firstRun={{ run: vi.fn() } as never}
          readCheckoutPending={async () => false}
          openCheckout={vi.fn()}
          storage={storage()}
          onSaveAndExit={vi.fn()}
          publication={{ load: vi.fn(), publish: vi.fn() }}
          organizationId="9a8b7c6d-5e4f-4a3b-8c2d-1e0f99887766"
          publicationStorage={storage()}
          openPage={vi.fn()}
        />,
      );
    });
    expect(text(renderer!)).toContain("EUR");
    renderer!.unmount();
  });
});
