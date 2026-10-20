import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { QuickPropertySetup, quickRoomStorageKey } from "./QuickPropertySetup";
import { QuickRoomStep, type QuickRoomStepProps } from "./QuickRoomStep";
import {
  EMPTY_QUICK_ROOM_DRAFT,
  quickRoomErrors,
  quickRoomLabelsHint,
  quickRoomRequest,
  type QuickRoomDraft,
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
  pricesIncludeMandatoryCharges: true,
};

function props(overrides: Partial<QuickRoomStepProps> = {}): QuickRoomStepProps {
  return {
    draft: FILLED,
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
async function submit(renderer: ReactTestRenderer) {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

describe("QuickRoomStep (VAY-2247 step 3)", () => {
  it("shows the room, its price in the hotel's currency and the defaults, with the room in the preview", () => {
    const markup = renderToStaticMarkup(<QuickRoomStep {...props()} />);
    expect(markup).toContain("Step 3 of 5");
    expect(markup).toContain("Your first room and price");
    expect(markup).toContain("We create Room 1–8 in the PMS. Rename them later.");
    expect(markup).toContain(">EUR<");
    expect(markup).toContain("My prices include all mandatory taxes and fees");
    expect(markup).toContain("Free cancellation until 3 days before arrival");
    expect(markup).toContain("One double bed per room");
    expect(markup).toContain("Up to 2 guests · Free cancellation until 3 days before");
    expect(markup).toContain("€145");
    // Until the first run takes them (follow-up), no Change links and no second room type.
    expect(markup).not.toContain(">Change<");
    expect(markup).not.toContain("Add another room type");
  });

  it("shows the Change links and Add another room type once they are passed", () => {
    const markup = renderToStaticMarkup(
      <QuickRoomStep
        {...props({ onAddRoomType: vi.fn(), onChangeCancellation: vi.fn(), onChangeBed: vi.fn() })}
      />,
    );
    expect(markup.match(/>Change</g)).toHaveLength(2);
    expect(markup).toContain("Add another room type");
  });

  it("asks for what is missing, including the taxes tick, before going on", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const renderer = create(
      <QuickRoomStep
        {...props({
          draft: {
            ...FILLED,
            numberOfRooms: "0",
            pricePerNight: "",
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
    expect(onSubmit).toHaveBeenCalledWith(FILLED);
    renderer.unmount();
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
      taxes: "Confirm that your prices include taxes and fees.",
    });
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
      [quickRoomStorageKey(PROPERTY)]: JSON.stringify({ ...FILLED, name: "Garden Suite" }),
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
    expect(JSON.parse(kept.values.get(quickRoomStorageKey(PROPERTY))!)).toMatchObject({
      name: "Garden Suite Deluxe",
    });
    await submit(renderer!);
    // On to step 4 (How guests pay), with the room in its preview.
    expect(text(renderer!)).toContain("How guests pay");
    expect(text(renderer!)).toContain("Garden Suite Deluxe");
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
