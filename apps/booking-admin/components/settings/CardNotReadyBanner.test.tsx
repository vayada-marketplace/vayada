import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n", async () => {
  const en = (await import("../../messages/en.json")).default as Record<string, string>;
  return { useTranslation: () => ({ t: (key: string) => en[key] ?? key, locale: "en" }) };
});

import { CardNotReadyBanner, type CardNotReadyReason } from "./CardNotReadyBanner";

function render(reason: CardNotReadyReason) {
  let view!: ReactTestRenderer;
  act(() => {
    view = create(<CardNotReadyBanner reason={reason} providerSectionId="payment-provider" />);
  });
  return view;
}

const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

describe("Payments card banner (VAY-2424)", () => {
  it("says guests can't pay by card and why, linking to the provider when the account is missing or unfinished", () => {
    const missing = render("not_connected");
    expect(text(missing)).toContain("Guests can't pay by card yet.");
    expect(text(missing)).toContain("No account for card payments is connected.");
    expect(missing.root.findByType("a").props.href).toBe("#payment-provider");

    const unfinished = render("setup_incomplete");
    expect(text(unfinished)).toContain("The account for card payments isn't fully set up yet.");
    expect(unfinished.root.findByType("a").props.children).toBe("Finish setup");

    for (const [reason, why] of [
      ["account_not_ready", "The connected account can't take card payments yet."],
      ["currency", "Card payments can't be taken in your hotel's current currency yet."],
      ["not_approved", "Vayada still has to approve card payments for your hotel."],
      ["switch_off", "Vayada hasn't switched on card payments for guests yet."],
    ] as const) {
      const view = render(reason);
      expect(text(view)).toContain(why);
      expect(view.root.findAllByType("a")).toHaveLength(0);
    }
  });
});
