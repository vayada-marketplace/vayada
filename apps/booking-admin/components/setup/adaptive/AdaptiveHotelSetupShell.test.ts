import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import { AdaptiveHotelSetupShell } from "./AdaptiveHotelSetupShell";

describe("AdaptiveHotelSetupShell", () => {
  it.each([
    { routeError: "The draft service is unavailable.", staleDraftMessage: null },
    { routeError: null, staleDraftMessage: "The setup draft changed." },
  ])("keeps the active form mounted while showing recovery", async (recovery) => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        AdaptiveHotelSetupShell({
          brandMark: createElement("span", null, "Vayada"),
          currentStep: 1,
          totalSteps: 3,
          title: "Present your hotel",
          subtitle: "Give guests a clear first impression.",
          onExit: () => undefined,
          routeError: recovery.routeError,
          staleDraftMessage: recovery.staleDraftMessage,
          onRetry: () => undefined,
          onRefresh: () => undefined,
          children: createElement("textarea", {
            "aria-label": "Short hotel summary",
            defaultValue: "local",
          }),
        }),
      );
    });

    expect(renderer?.root.findByType("textarea").props.defaultValue).toBe("local");
    expect(renderer?.root.findByProps({ role: "alert" })).toBeDefined();
    renderer?.unmount();
  });

  it.each([
    { bookingPage: true, text: "You can still finish setup and publish your booking page." },
    { bookingPage: false, text: "You can still finish setup. To ask" },
  ])(
    "announces a suspended Marketplace profile with what the hotel can still do (VAY-2177)",
    async ({ bookingPage, text }) => {
      let renderer: ReactTestRenderer | undefined;
      await act(async () => {
        renderer = create(
          AdaptiveHotelSetupShell({
            brandMark: createElement("span", null, "Vayada"),
            currentStep: 1,
            totalSteps: 9,
            title: "Present your hotel",
            subtitle: "Give guests a clear first impression.",
            onExit: () => undefined,
            marketplaceSuspended: { bookingPage },
            children: null,
          }),
        );
      });
      const notice = renderer!.root.findByProps({ role: "note" });
      const content = JSON.stringify(notice.children.map((child) => renderToText(child)));
      expect(content).toContain("Your Creator Marketplace profile is suspended");
      expect(content.replace(/","/g, "")).toContain(text);
      expect(renderer!.root.findByType("a").props.href).toBe("mailto:support@vayada.com");
      renderer?.unmount();
    },
  );
});

function renderToText(node: unknown): string {
  if (typeof node === "string") return node;
  const instance = node as { children?: unknown[] };
  return (instance.children ?? []).map(renderToText).join("");
}
