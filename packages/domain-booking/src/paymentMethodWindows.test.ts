import { describe, expect, it } from "vitest";
import {
  parsePaymentMethodBookingWindows,
  paymentMethodGaps,
  paymentWindowAllows,
} from "./paymentMethodWindows.js";

const hour = 3_600_000;

describe("payment method booking windows (VAY-2348)", () => {
  it("parses the three window shapes and treats null as no limit", () => {
    expect(
      parsePaymentMethodBookingWindows({
        card: null,
        bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
        pay_at_property: { kind: "within", amount: 48, unit: "hours" },
      }),
    ).toEqual({
      ok: true,
      windows: {
        bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
        pay_at_property: { kind: "within", amount: 48, unit: "hours" },
      },
    });
    expect(
      parsePaymentMethodBookingWindows({ card: { kind: "within", amount: 2, unit: "days" } }),
    ).toEqual({ ok: true, windows: { card: { kind: "within", amount: 2, unit: "days" } } });
    expect(parsePaymentMethodBookingWindows({})).toEqual({ ok: true, windows: {} });
  });

  it.each([
    ["not an object", []],
    ["PayPal", { paypal: { kind: "at_least", amount: 3, unit: "days" } }],
    ["unknown method", { cash: null }],
    ["hours for at least", { card: { kind: "at_least", amount: 72, unit: "hours" } }],
    ["zero", { card: { kind: "within", amount: 0, unit: "hours" } }],
    ["fraction", { card: { kind: "within", amount: 1.5, unit: "days" } }],
    ["over a year", { card: { kind: "at_least", amount: 366, unit: "days" } }],
    ["extra field", { card: { kind: "within", amount: 2, unit: "days", note: "x" } }],
    ["unknown kind", { card: { kind: "before", amount: 2, unit: "days" } }],
  ])("refuses %s", (_name, value) => {
    expect(parsePaymentMethodBookingWindows(value)).toMatchObject({
      ok: false,
      problem: "invalid",
    });
  });

  it("keeps a bank transfer window longer than its 48-hour payment deadline (D7)", () => {
    const bank = (window: object) => parsePaymentMethodBookingWindows({ bank_transfer: window });
    expect(bank({ kind: "at_least", amount: 3, unit: "days" })).toMatchObject({ ok: true });
    expect(bank({ kind: "at_least", amount: 2, unit: "days" })).toEqual({
      ok: false,
      problem: "bank_transfer_window_too_short",
      method: "bank_transfer",
    });
    expect(bank({ kind: "at_least", amount: 1, unit: "days" })).toMatchObject({ ok: false });
    expect(bank({ kind: "within", amount: 49, unit: "hours" })).toMatchObject({ ok: true });
    expect(bank({ kind: "within", amount: 48, unit: "hours" })).toMatchObject({
      ok: false,
      problem: "bank_transfer_window_too_short",
    });
    expect(bank({ kind: "within", amount: 2, unit: "days" })).toMatchObject({ ok: false });
    expect(bank({ kind: "within", amount: 3, unit: "days" })).toMatchObject({ ok: true });
  });

  it("allows a booking on the window's own boundary, in hours to check-in", () => {
    const atLeast = { kind: "at_least", amount: 7, unit: "days" } as const;
    expect(paymentWindowAllows(atLeast, 168 * hour)).toBe(true);
    expect(paymentWindowAllows(atLeast, 168 * hour - 1)).toBe(false);
    const within = { kind: "within", amount: 48, unit: "hours" } as const;
    expect(paymentWindowAllows(within, 48 * hour)).toBe(true);
    expect(paymentWindowAllows(within, 48 * hour + 1)).toBe(false);
    // After check-in time on the arrival day the lead is negative: still "within".
    expect(paymentWindowAllows(within, -hour)).toBe(true);
    expect(paymentWindowAllows(null, -hour)).toBe(true);
  });

  it("finds the lead times no method covers", () => {
    // The ticket's example: card always, bank transfer from 7 days, pay at property within 48 h.
    const example = {
      bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
      pay_at_property: { kind: "within", amount: 48, unit: "hours" },
    } as const;
    expect(paymentMethodGaps(["card", "bank_transfer", "pay_at_property"], example)).toEqual([]);
    expect(paymentMethodGaps(["bank_transfer", "pay_at_property"], example)).toEqual([
      { fromHours: 48, toHours: 168 },
    ]);
    // Bank transfer alone always leaves the last 48 hours open.
    expect(paymentMethodGaps(["bank_transfer"], {})).toEqual([{ fromHours: 0, toHours: 48 }]);
    // Only last-minute bookings can pay.
    expect(paymentMethodGaps(["pay_at_property"], example)).toEqual([
      { fromHours: 48, toHours: null },
    ]);
    // Touching windows leave no gap.
    expect(
      paymentMethodGaps(["card", "pay_at_property"], {
        card: { kind: "at_least", amount: 3, unit: "days" },
        pay_at_property: { kind: "within", amount: 72, unit: "hours" },
      }),
    ).toEqual([]);
    expect(paymentMethodGaps([], {})).toEqual([{ fromHours: 0, toHours: null }]);
  });
});
