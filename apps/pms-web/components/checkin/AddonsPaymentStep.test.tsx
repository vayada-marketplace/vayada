import { createElement } from "react";
import { create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { AddonsPaymentStep } from "./AddonsPaymentStep";
import type { Booking } from "@/services/bookings";
import type { CheckinSettings } from "@/services/settings";

it("lists a booked per-night extra once, with its days (VAY-2409)", () => {
  const booking = {
    currency: "EUR",
    addonNames: ["Breakfast", "Welcome bottle"],
    addonSelections: [
      {
        selectionIds: ["night-1", "night-2"],
        addonId: "breakfast",
        name: "Breakfast",
        quantity: 2,
        dates: ["2026-11-06", "2026-11-07"],
      },
      {
        selectionIds: ["bottle"],
        addonId: "bottle",
        name: "Welcome bottle",
        quantity: 1,
        dates: [],
      },
    ],
  } as unknown as Booking;
  const view = create(
    createElement(AddonsPaymentStep, {
      booking,
      settings: { offerAddons: false, settlementOptions: [] } as unknown as CheckinSettings,
      offers: [],
      quantities: {},
      onQuantity: vi.fn(),
      locked: false,
      lines: [],
      dueNow: 0,
      choice: null,
      onChoice: vi.fn(),
      recorded: null,
      settledElsewhere: false,
    }),
  );
  const names = view.root
    .findAll((node) => node.type === "p" && node.props.className?.includes("font-bold"))
    .map((node) => node.children.join(""));
  expect(names).toEqual(["Breakfast × 2", "Welcome bottle"]);
  expect(JSON.stringify(view.toJSON())).toContain("Nov 6 – Nov 7");
  view.unmount();
});
