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

it("offers only cash or card when the owner confirms the booking's transfer (VAY-2575)", () => {
  const render = (ownerConfirmsPayment: boolean) => {
    const view = create(
      createElement(AddonsPaymentStep, {
        booking: { currency: "EUR", addonNames: [], addonSelections: [] } as unknown as Booking,
        settings: {
          offerAddons: false,
          settlementOptions: ["card", "cash", "bank_transfer", "at_checkout", "already_paid"],
        } as unknown as CheckinSettings,
        offers: [],
        quantities: {},
        onQuantity: vi.fn(),
        locked: false,
        lines: [],
        dueNow: 400,
        choice: null,
        onChoice: vi.fn(),
        recorded: null,
        settledElsewhere: false,
        ownerConfirmsPayment,
      }),
    );
    const methods = view.root
      .findAll((node) => node.type === "button" && "aria-pressed" in node.props)
      .map((node) => node.children.join(""));
    const text = JSON.stringify(view.toJSON());
    view.unmount();
    return { methods, text };
  };

  const desk = render(true);
  expect(desk.methods).toEqual(["Card · own terminal", "Cash"]);
  expect(desk.text).toContain("At check-out");
  expect(desk.text).not.toContain("Already paid");
  expect(desk.text).toContain("Only the account owner can confirm this payment.");

  const owner = render(false);
  expect(owner.methods).toEqual(["Card · own terminal", "Cash", "Bank transfer"]);
  expect(owner.text).toContain("Already paid");
  expect(owner.text).not.toContain("Only the account owner");
});
