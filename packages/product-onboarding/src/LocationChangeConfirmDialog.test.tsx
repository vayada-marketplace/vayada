import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { PropertyLocationChanges } from "@vayada/domain-hotels";

import {
  LocationChangeConfirmDialog,
  locationChangeConfirmEnglish,
  type LocationChangeConfirmTranslate,
} from "./LocationChangeConfirmDialog";

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");

async function render(
  changes: PropertyLocationChanges,
  options: {
    translate?: LocationChangeConfirmTranslate;
    locale?: string;
    confirming?: boolean;
  } = {},
) {
  const onKeep = vi.fn();
  const onConfirm = vi.fn();
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(
      createElement(LocationChangeConfirmDialog, {
        changes,
        currentTimeZone: "Asia/Colombo",
        confirming: options.confirming ?? false,
        onKeep,
        onConfirm,
        translate: options.translate,
        locale: options.locale,
      }),
    );
  });
  const dialog = view.root.findByProps({ role: "alertdialog" });
  return { view, dialog, text: text(dialog), buttons: dialog.findAllByType("button").map(text) };
}

// VAY-2586: the PMS question, shared with Booking Admin › Settings › Location.
describe("shared live hotel location question", () => {
  it("asks in the approved English without a catalog", async () => {
    const shown = await render({
      countryCode: { from: "LK", to: "GB" },
      timezone: { from: "Asia/Colombo", to: "Europe/London" },
    });
    expect(text(shown.dialog.findByType("h2"))).toBe("Change your hotel's country and time zone?");
    expect(shown.text).toContain("Guests can book your hotel now.");
    expect(shown.buttons).toEqual(["Keep current", "Change country and time zone"]);
    shown.view.unmount();
  });

  it("takes every word from the app's catalog and names countries in its language", async () => {
    const translate = vi.fn<LocationChangeConfirmTranslate>(
      (key, params) => `[${key}${params ? ` ${Object.values(params).join(",")}` : ""}]`,
    );
    const shown = await render(
      { countryCode: { from: "LK", to: "GB" } },
      { translate, locale: "de" },
    );
    // Nothing English is left over: every piece of text is a key.
    expect(
      shown.text.replace(/\[[^\]]*\]/g, "").replace(/Sri Lanka|Vereinigtes Königreich|→/g, ""),
    ).toBe("");
    expect(shown.text).toContain("Vereinigtes Königreich");
    expect(shown.buttons).toEqual([
      "[locationConfirm.keep Sri Lanka]",
      "[locationConfirm.changeCountry]",
    ]);
    expect(shown.text).toContain("[locationConfirm.countryKeepsTimeZone Asia/Colombo]");
    for (const [key] of translate.mock.calls)
      expect(locationChangeConfirmEnglish).toHaveProperty([key]);
    shown.view.unmount();

    const saving = await render(
      { timezone: { from: "Asia/Colombo", to: "Europe/London" } },
      { translate, confirming: true },
    );
    expect(saving.buttons[1]).toBe("[locationConfirm.saving]");
    saving.view.unmount();
  });
});
