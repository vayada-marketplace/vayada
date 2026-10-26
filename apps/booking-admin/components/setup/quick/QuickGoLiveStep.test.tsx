import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  QUICK_GO_LIVE_DEFAULTS,
  QuickGoLiveStep,
  type QuickGoLiveStepProps,
} from "./QuickGoLiveStep";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

function props(overrides: Partial<QuickGoLiveStepProps> = {}): QuickGoLiveStepProps {
  return {
    hotel: {
      name: "Hotel Alpenrose",
      place: "Sendlinger Straße 12, Munich",
      url: "hotel-alpenrose.booking.vayada.com",
    },
    currency: { code: "EUR", symbol: "€" },
    rooms: [
      {
        name: "Classic Double",
        details: "Up to 2 guests · Free cancellation until 3 days before",
        price: "€145",
      },
    ],
    status: { kind: "ready" },
    onPublish: vi.fn(),
    onRetry: vi.fn(),
    onDashboard: vi.fn(),
    onReview: vi.fn(),
    onSaveAndExit: vi.fn(),
    ...overrides,
  };
}

const buttons = (markup: string, label: string) =>
  (markup.match(/<button[^>]*>.*?<\/button>/g) ?? []).filter((button) => button.includes(label));

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const buttonsNamed = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll((node) => node.type === "button" && textOf(node).includes(label));

describe("QuickGoLiveStep (VAY-2247 step 5)", () => {
  it("shows the booking page, what the first run filled in and the publish choice", () => {
    const markup = renderToStaticMarkup(<QuickGoLiveStep {...props()} />);
    expect(markup).toContain("Step 7 of 7");
    expect(markup).toContain("Does this look right?");
    expect(markup).toContain(
      "This is your booking page. Publish it now — you can change everything later.",
    );
    expect(markup).toContain("hotel-alpenrose.booking.vayada.com");
    expect(markup).toContain("Classic Double");
    expect(markup).toContain("We filled in the rest for you");
    expect(markup).toContain(QUICK_GO_LIVE_DEFAULTS);
    expect(markup).toContain("Not yet — go to my dashboard");
    for (const button of buttons(markup, "Publish booking page"))
      expect(button).not.toContain('disabled=""');
    expect(markup).not.toContain("We couldn&#x27;t publish yet");
  });

  it("waits for the check before publishing can start", () => {
    const markup = renderToStaticMarkup(
      <QuickGoLiveStep {...props({ status: { kind: "loading" } })} />,
    );
    const publish = buttons(markup, "Publish booking page");
    expect(publish).toHaveLength(2);
    for (const button of publish) expect(button).toContain('disabled=""');
  });

  it("says it is publishing, and the host may still leave (the request is saved)", () => {
    const markup = renderToStaticMarkup(
      <QuickGoLiveStep {...props({ status: { kind: "publishing" } })} />,
    );
    expect(markup).toContain("Publishing your booking page. This takes about 10 seconds.");
    expect(markup).not.toContain("Publish booking page");
    for (const button of buttons(markup, "Publishing…")) expect(button).toContain('disabled=""');
    const exits = [
      ...buttons(markup, "Not yet — go to my dashboard"),
      ...buttons(markup, "Save &amp; exit"),
    ];
    expect(exits).toHaveLength(3);
    for (const button of exits) expect(button).not.toContain('disabled=""');
  });

  it("explains why it couldn't publish and offers Try again", async () => {
    const onRetry = vi.fn();
    const message =
      "Room availability isn't prepared yet. This usually sorts itself out within a minute.";
    const renderer = create(
      <QuickGoLiveStep {...props({ status: { kind: "failed", message }, onRetry })} />,
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("We couldn't publish yet");
    expect(text).toContain(message);
    const retry = buttonsNamed(renderer, "Try again");
    expect(retry).toHaveLength(1);
    await act(async () => retry[0]!.props.onClick());
    expect(onRetry).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("publishes, opens the dashboard and the review from their buttons", async () => {
    const step = props();
    const renderer = create(<QuickGoLiveStep {...step} />);
    const click = async (label: string) => {
      const button = buttonsNamed(renderer, label)[0]!;
      await act(async () => button.props.onClick());
    };
    await click("Publish booking page");
    await click("Not yet — go to my dashboard");
    await click("Review");
    expect(step.onPublish).toHaveBeenCalledTimes(1);
    expect(step.onDashboard).toHaveBeenCalledTimes(1);
    expect(step.onReview).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });
});
