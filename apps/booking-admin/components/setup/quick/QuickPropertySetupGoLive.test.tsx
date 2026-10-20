import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BookingPublicationReview } from "@/services/api/bookingPublicationReviewClient";

import { QuickPropertySetup, quickRoomStorageKey } from "./QuickPropertySetup";
import type { QuickPublicationClient } from "./useQuickPublication";

type Load = QuickPublicationClient["load"];

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const ORGANIZATION = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f99887766";
const HASH = (digit: string) => `sha256:${digit.repeat(64)}`;
const ROOM = {
  name: "Classic Double",
  numberOfRooms: "8",
  maxGuests: "2",
  pricePerNight: "145",
  pricesIncludeMandatoryCharges: true,
};

const READY = {
  contractVersion: "booking-publication-review.v1",
  propertyId: PROPERTY,
  activeContentRevisionId: null,
  publishedUrl: null,
  latestOperation: null,
  recoveredOperation: null,
  readiness: {
    outcome: "evaluated",
    status: "ready",
    readinessHash: HASH("a"),
    sourceManifestHash: HASH("b"),
    groups: [],
  },
} as unknown as BookingPublicationReview;
const LIVE = {
  ...READY,
  activeContentRevisionId: "11111111-2222-4333-8444-555555555555",
  publishedUrl: "https://hotel-alpenrose.booking.vayada.com/en",
} as BookingPublicationReview;

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const text = (renderer: ReactTestRenderer) => textOf(renderer.root);
const click = async (renderer: ReactTestRenderer, label: string) => {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && textOf(node).includes(label),
  )[0]!;
  await act(async () => button.props.onClick());
};

beforeEach(() => {
  vi.stubGlobal("navigator", {
    locks: { request: (_key: string, action: () => unknown) => Promise.resolve(action()) },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("QuickPropertySetup step 5 and You're live (VAY-2247)", () => {
  async function mount(load: Load) {
    const publish = vi.fn(async () => ({}));
    const openPage = vi.fn();
    const onSaveAndExit = vi.fn();
    const copyLink = vi.fn(async () => undefined);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <QuickPropertySetup
          propertyId={PROPERTY}
          initialStep={5}
          setup={
            {
              getPropertyProfile: vi.fn(async () => ({
                profile: {
                  displayName: "Hotel Alpenrose",
                  location: {
                    streetAddress: "Sendlinger Straße 12",
                    city: "Munich",
                    countryCode: "DE",
                  },
                },
              })),
            } as never
          }
          readCurrency={async () => "EUR"}
          firstRun={{ run: vi.fn() } as never}
          readCheckoutPending={async () => false}
          openCheckout={vi.fn()}
          storage={memoryStorage({ [quickRoomStorageKey(PROPERTY)]: JSON.stringify(ROOM) })}
          onSaveAndExit={onSaveAndExit}
          publication={{ load, publish }}
          organizationId={ORGANIZATION}
          publicationStorage={memoryStorage()}
          openPage={openPage}
          copyLink={copyLink}
        />,
      );
    });
    await act(async () => undefined);
    return { renderer: renderer!, publish, openPage, onSaveAndExit, copyLink };
  }

  it("publishes the booking page, then says the hotel is open with its link and next steps", async () => {
    const load = vi.fn<Load>().mockResolvedValueOnce(READY).mockResolvedValue(LIVE);
    const { renderer, publish, openPage, onSaveAndExit, copyLink } = await mount(load);
    expect(text(renderer)).toContain("Does this look right?");
    expect(text(renderer)).toContain("Classic Double");

    await click(renderer, "Review");
    expect(openPage).toHaveBeenLastCalledWith("review");

    await click(renderer, "Publish booking page");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(text(renderer)).toContain("Hotel Alpenrose is open for bookings");
    expect(text(renderer)).toContain("hotel-alpenrose.booking.vayada.com");

    await click(renderer, "Copy link");
    expect(copyLink).toHaveBeenCalledWith("https://hotel-alpenrose.booking.vayada.com/en");
    await click(renderer, "Rooms & Rates");
    await click(renderer, "Design Studio");
    await click(renderer, "Payment settings");
    expect(openPage.mock.calls.slice(1)).toEqual([
      ["rooms_and_rates"],
      ["design_studio"],
      ["payment_settings"],
    ]);
    await click(renderer, "Go to my dashboard");
    expect(onSaveAndExit).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("goes to the dashboard without publishing on Not yet", async () => {
    const { renderer, publish, onSaveAndExit } = await mount(
      vi.fn<Load>().mockResolvedValue(READY),
    );
    await click(renderer, "Not yet — go to my dashboard");
    expect(onSaveAndExit).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("opens on You're live when the page is already published", async () => {
    const { renderer } = await mount(vi.fn<Load>().mockResolvedValue(LIVE));
    expect(text(renderer)).toContain("Hotel Alpenrose is open for bookings");
    renderer.unmount();
  });
});
