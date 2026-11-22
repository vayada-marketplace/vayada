import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { PropertyLocationChanges } from "@vayada/domain-hotels";
import { ApiErrorResponse } from "@/services/api/client";

import {
  LocationChangeConfirmDialog,
  locationChangeToConfirm,
} from "./LocationChangeConfirmDialog";

// The copy Flamur approved on the Paper page "VAY-2582 Live hotel: confirm time zone / country change".
const timeZonePoints = [
  "recalculates your calendar in the new time zone",
  "pauses your booking page until you save your calendar again in Settings › Calendar",
  "needs your channel manager to use the same time zone, or its sync stops",
];

async function render(changes: PropertyLocationChanges, confirming = false) {
  const onKeep = vi.fn();
  const onConfirm = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      createElement(LocationChangeConfirmDialog, {
        changes,
        currentTimeZone: "Asia/Colombo",
        confirming,
        onKeep,
        onConfirm,
      }),
    );
  });
  const dialog = view.root.findByProps({ role: "alertdialog" });
  const text = (node: ReactTestInstance | string): string =>
    typeof node === "string" ? node : node.children.map(text).join("");
  const buttons = dialog.findAllByType("button");
  return {
    view,
    onKeep,
    onConfirm,
    title: text(dialog.findByType("h2")),
    text: text(dialog),
    points: dialog.findAllByType("li").map(text),
    rows: dialog
      .findAllByType("dt")
      .map((label, index) => `${text(label)}: ${text(dialog.findAllByType("dd")[index])}`),
    buttons: buttons.map(text),
    keep: buttons[0],
    change: buttons[1],
  };
}

describe("live hotel location change question (VAY-2582)", () => {
  it("asks before a time zone change and names what it does", async () => {
    const shown = await render({ timezone: { from: "Asia/Colombo", to: "Europe/London" } });
    expect(shown.title).toBe("Change your hotel's time zone?");
    expect(shown.text).toContain("Guests can book your hotel now.");
    expect(shown.rows).toEqual(["Time zone: Asia/Colombo→toEurope/London"]);
    expect(shown.text).toContain("What this does:");
    expect(shown.points).toEqual(timeZonePoints);
    expect(shown.buttons).toEqual(["Keep Asia/Colombo", "Change time zone"]);
    expect(shown.text).not.toContain("currency");
    shown.view.unmount();
  });

  it("asks before a country change and says the time zone stays", async () => {
    const shown = await render({ countryCode: { from: "LK", to: "GB" } });
    expect(shown.title).toBe("Change your hotel's country?");
    expect(shown.rows).toEqual(["Country: Sri Lanka→toUnited Kingdom"]);
    expect(shown.text).toContain(
      "The time zone stays Asia/Colombo, so your calendar and booking page keep working. Check that your currency and channel manager still match the new country.",
    );
    expect(shown.points).toEqual([]);
    expect(shown.buttons).toEqual(["Keep Sri Lanka", "Change country"]);
    shown.view.unmount();
  });

  it("asks once for both, the time zone's consequences and the country check together", async () => {
    const shown = await render({
      countryCode: { from: "LK", to: "GB" },
      timezone: { from: "Asia/Colombo", to: "Europe/London" },
    });
    expect(shown.title).toBe("Change your hotel's country and time zone?");
    expect(shown.rows).toEqual([
      "Country: Sri Lanka→toUnited Kingdom",
      "Time zone: Asia/Colombo→toEurope/London",
    ]);
    expect(shown.text).toContain("Changing the time zone:");
    expect(shown.points).toEqual(timeZonePoints);
    expect(shown.text).toContain(
      "Check that your currency and channel manager still match the new country.",
    );
    expect(shown.text).not.toContain("The time zone stays");
    expect(shown.buttons).toEqual(["Keep current", "Change country and time zone"]);
    shown.view.unmount();
  });

  it("keeps or changes on the person's answer, and holds both while the change saves", async () => {
    const shown = await render({ timezone: { from: "America/Sao_Paulo", to: "Europe/London" } });
    // Time zones read as in the Settings list.
    expect(shown.buttons[0]).toBe("Keep America/Sao Paulo");
    act(() => shown.keep.props.onClick());
    expect(shown.onKeep).toHaveBeenCalledTimes(1);
    act(() => shown.change.props.onClick());
    expect(shown.onConfirm).toHaveBeenCalledTimes(1);
    shown.view.unmount();

    const saving = await render({ timezone: { from: "Asia/Colombo", to: "Europe/London" } }, true);
    expect(saving.keep.props.disabled).toBe(true);
    expect(saving.change.props.disabled).toBe(true);
    expect(saving.buttons[1]).toBe("Saving...");
    // The backdrop and Escape can't drop the question mid-save either.
    act(() => saving.keep.props.onClick());
    expect(saving.onKeep).not.toHaveBeenCalled();
    saving.view.unmount();
  });

  it("reads the question from the server's answer, and only from that one", () => {
    const changes = { countryCode: { from: "LK", to: "GB" } };
    expect(
      locationChangeToConfirm(
        new ApiErrorResponse(409, {
          code: "location_change_needs_confirmation",
          detail: "This changes your live hotel's country from LK to GB.",
          changes,
        } as never),
      ),
    ).toEqual(changes);
    expect(
      locationChangeToConfirm(
        new ApiErrorResponse(409, {
          code: "channex_time_zone_mismatch",
          detail: "This hotel is connected to Channex, which uses the time zone Asia/Colombo.",
          channexTimeZone: "Asia/Colombo",
        } as never),
      ),
    ).toBeNull();
    expect(locationChangeToConfirm(new Error("offline"))).toBeNull();
    expect(locationChangeToConfirm(undefined)).toBeNull();
  });
});
