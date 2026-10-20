import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { QuickLiveScreen, quickLiveHost, type QuickLiveScreenProps } from "./QuickLiveScreen";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

const URL_EN = "https://hotel-alpenrose.booking.vayada.com/en";

function props(overrides: Partial<QuickLiveScreenProps> = {}): QuickLiveScreenProps {
  return {
    hotel: { name: "Hotel Alpenrose", place: "Sendlinger Straße 12, Munich" },
    currency: { code: "EUR", symbol: "€" },
    rooms: [
      {
        name: "Classic Double",
        details: "Up to 2 guests · Free cancellation until 3 days before",
        price: "€145",
      },
    ],
    url: URL_EN,
    previewHost: "hotel-alpenrose.booking.vayada.com",
    copy: vi.fn(async () => undefined),
    onRoomsAndRates: vi.fn(),
    onDesignStudio: vi.fn(),
    onPaymentSettings: vi.fn(),
    onDashboard: vi.fn(),
    ...overrides,
  };
}

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const button = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll((node) => node.type === "button" && textOf(node).includes(label))[0]!;

describe("QuickLiveScreen (VAY-2247 You're live)", () => {
  it("says the hotel is open, with its link, the next steps and the live page, and no step count", () => {
    const markup = renderToStaticMarkup(<QuickLiveScreen {...props()} />);
    expect(markup).toContain("Live now");
    expect(markup).toContain("Hotel Alpenrose is open for bookings");
    expect(markup).toContain(
      "Share your link, put it on your website, or send it to your last guests.",
    );
    expect(markup).toContain(`href="${URL_EN}"`);
    expect(markup).toContain(">hotel-alpenrose.booking.vayada.com<");
    for (const text of [
      "Make it even better",
      "Add photos",
      "Rooms &amp; Rates",
      "Logo and colours",
      "Design Studio",
      "Online cards",
      "Payment settings",
      "Go to my dashboard",
      "Your booking page is live",
    ])
      expect(markup).toContain(text);
    expect(markup).not.toContain("Step ");
    expect(markup).not.toContain("Save &amp; exit");
  });

  it("copies the link and says so", async () => {
    const copy = vi.fn(async () => undefined);
    const renderer = create(<QuickLiveScreen {...props({ copy })} />);
    await act(async () => button(renderer, "Copy link").props.onClick());
    expect(copy).toHaveBeenCalledWith(URL_EN);
    expect(textOf(button(renderer, "Copied"))).toBe("Copied");
    renderer.unmount();
  });

  it("tells the host when the link couldn't be copied", async () => {
    const copy = vi.fn(async () => {
      throw new Error("denied");
    });
    const renderer = create(<QuickLiveScreen {...props({ copy })} />);
    await act(async () => button(renderer, "Copy link").props.onClick());
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Couldn't copy the link. Select it and copy it instead.",
    );
    renderer.unmount();
  });

  it("opens each next step and the dashboard", async () => {
    const screen = props();
    const renderer = create(<QuickLiveScreen {...screen} />);
    for (const label of [
      "Rooms & Rates",
      "Design Studio",
      "Payment settings",
      "Go to my dashboard",
    ])
      await act(async () => button(renderer, label).props.onClick());
    expect(screen.onRoomsAndRates).toHaveBeenCalledTimes(1);
    expect(screen.onDesignStudio).toHaveBeenCalledTimes(1);
    expect(screen.onPaymentSettings).toHaveBeenCalledTimes(1);
    expect(screen.onDashboard).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("says when guests can open the page, without a link, while the booking site switches over", () => {
    const markup = renderToStaticMarkup(<QuickLiveScreen {...props({ url: null })} />);
    expect(markup).toContain("Guests can open it once we finish switching the booking site over");
    expect(markup).not.toContain("Copy link");
    expect(markup).toContain(">hotel-alpenrose.booking.vayada.com<");
  });

  it("shows the host of the published address", () => {
    expect(quickLiveHost(URL_EN)).toBe("hotel-alpenrose.booking.vayada.com");
    expect(quickLiveHost("not a url")).toBe("not a url");
  });
});
