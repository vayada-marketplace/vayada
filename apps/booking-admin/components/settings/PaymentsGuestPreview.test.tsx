import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { PaymentMethodBookingWindows } from "@vayada/domain-booking";

vi.mock("@/lib/i18n", async () => {
  const en = (await import("../../messages/en.json")).default as Record<string, string>;
  const t = (key: string, params: Record<string, string | number> = {}) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      en[key] ?? key,
    );
  return { useTranslation: () => ({ t, locale: "en" }) };
});

import {
  axisPercent,
  bookingGaps,
  checkoutMethods,
  PaymentsGuestPreview,
  rangeBox,
  type PreviewMethods,
} from "./PaymentsGuestPreview";
import type { PaymentWindowsState } from "./paymentWindows";

const all: PreviewMethods = {
  card: true,
  pay_at_property: true,
  bank_transfer: true,
  paypal: true,
  paypalHours: 24,
  cardReady: true,
  bankReady: true,
};
const windows: PaymentMethodBookingWindows = {
  pay_at_property: { kind: "at_least", amount: 14, unit: "days" },
  bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
};

describe("Payments: what guests will see (VAY-2424)", () => {
  it("places lead times on the mockup's axis", () => {
    expect([0, 48, 168, 336, 720, 2000].map(axisPercent)).toEqual([0, 25, 50, 75, 100, 100]);
    expect(axisPercent(24)).toBe(12.5);
    expect(axisPercent(null)).toBe(100);
    // From 30 days on, a range keeps a visible tail ("30 days+ before arrival").
    expect(rangeBox({ fromHours: 720, toHours: null })).toEqual({ left: 96, width: 4 });
    expect(rangeBox({ fromHours: 48, toHours: 168 })).toEqual({ left: 25, width: 25 });
  });

  it("lists what checkout offers a guest booking a given time ahead", () => {
    expect(checkoutMethods(all, windows, 0)).toEqual(["card"]);
    expect(checkoutMethods(all, windows, 72)).toEqual(["card", "paypal"]);
    expect(checkoutMethods(all, windows, 14 * 24)).toEqual([
      "card",
      "pay_at_property",
      "bank_transfer",
      "paypal",
    ]);
    // Credit card without a payment account isn't offered; a way switched off neither.
    expect(checkoutMethods({ ...all, cardReady: false, paypal: false }, windows, 72)).toEqual([]);
    // Bank transfer without bank details to give guests isn't offered either.
    expect(checkoutMethods({ ...all, bankReady: false }, windows, 14 * 24)).toEqual([
      "card",
      "pay_at_property",
      "paypal",
    ]);
    // PayPal needs check-in further away than its own payment window.
    expect(checkoutMethods({ ...all, paypalHours: 72 }, windows, 72)).toEqual(["card"]);
    // "Within" windows end: pay at the hotel only for last-minute bookings.
    expect(
      checkoutMethods(
        { ...all, card: false, paypal: false, bank_transfer: false },
        { pay_at_property: { kind: "within", amount: 48, unit: "hours" } },
        72,
      ),
    ).toEqual([]);
  });

  it("finds the stretches with no way to pay, Credit card counted only when ready", () => {
    expect(bookingGaps({ ...all, cardReady: false, paypal: false }, windows)).toEqual({
      gaps: [{ fromHours: 0, toHours: 168 }],
      bookable: [{ fromHours: 168, toHours: null }],
    });
    expect(bookingGaps(all, windows).gaps).toEqual([]);
    expect(
      bookingGaps({ ...all, cardReady: false, paypal: false, bankReady: false }, windows).gaps,
    ).toEqual([{ fromHours: 0, toHours: 336 }]);
  });

  it("draws Credit card striped while no account can take it, and says when guests can't pay", () => {
    const state = {
      saved: windows,
      drafts: null,
      deadlineHours: 48,
      loadError: false,
      reload: vi.fn(),
      update: vi.fn(),
      apply: vi.fn(),
      discard: vi.fn(),
    } as unknown as PaymentWindowsState;
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <PaymentsGuestPreview
          methods={{ ...all, cardReady: false, paypal: false }}
          windows={state}
          next={windows}
        />,
      );
    });
    const text = JSON.stringify(view.toJSON());
    expect(text).toContain("repeating-linear-gradient(135deg, #C7CDF9");
    expect(text).toContain("Guests booking less than 7 days before arrival have no way to pay.");
    // Booking 3 days ahead (the mockup's default): nothing to pay with.
    expect(text).toContain("No way to pay: these guests can't complete a booking.");
    const twoWeeks = view.root.find(
      (node) => node.type === "button" && node.props.children === "2 weeks before",
    );
    act(() => twoWeeks.props.onClick());
    const items = view.root.findAllByType("li").map((item) => item.props.children);
    expect(items).toEqual(["Pay at hotel", "Bank transfer"]);
  });
});
