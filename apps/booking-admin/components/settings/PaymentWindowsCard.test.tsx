import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import { FinancePaymentSettingsClientError } from "@/services/api/financePaymentSettingsClient";
import {
  draftOf,
  leadText,
  methodRange,
  noWayToPay,
  paymentWindowsPlan,
  paymentWindowsSaveError,
  windowOf,
} from "./PaymentWindowsCard";

const t = (key: string, params: Record<string, string | number> = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    (en as Record<string, string>)[key] ?? key,
  );
const off = { card: false, pay_at_property: false, bank_transfer: false, paypalHours: null };

describe("Booking Admin payment windows (VAY-2348)", () => {
  it("turns a row into a window, refusing what the API refuses", () => {
    expect(windowOf("card", { kind: "any", amount: "", unit: "days" })).toEqual({ window: null });
    expect(windowOf("pay_at_property", { kind: "within", amount: "48", unit: "hours" })).toEqual({
      window: { kind: "within", amount: 48, unit: "hours" },
    });
    // "At least" always counts days, whatever unit the row last showed.
    expect(windowOf("card", { kind: "at_least", amount: "7", unit: "hours" })).toEqual({
      window: { kind: "at_least", amount: 7, unit: "days" },
    });
    for (const amount of ["", "0", "1.5", "-2", "abc", "366"])
      expect(windowOf("card", { kind: "at_least", amount, unit: "days" })).toEqual({
        problem: "amount",
      });
    // D7: a bank transfer window must be longer than its 48-hour payment deadline.
    expect(windowOf("bank_transfer", { kind: "at_least", amount: "2", unit: "days" })).toEqual({
      problem: "bank_at_least",
    });
    expect(windowOf("bank_transfer", { kind: "within", amount: "2", unit: "days" })).toEqual({
      problem: "bank_within",
    });
    expect(windowOf("bank_transfer", { kind: "at_least", amount: "3", unit: "days" })).toEqual({
      window: { kind: "at_least", amount: 3, unit: "days" },
    });
    expect(draftOf({ kind: "within", amount: 2, unit: "days" })).toEqual({
      kind: "within",
      amount: "2",
      unit: "days",
    });
  });

  it("draws each way to pay over the lead times it covers", () => {
    expect(methodRange("card", undefined)).toEqual({ fromHours: 0, toHours: null });
    expect(methodRange("bank_transfer", undefined)).toEqual({ fromHours: 48, toHours: null });
    expect(methodRange("bank_transfer", { kind: "at_least", amount: 7, unit: "days" })).toEqual({
      fromHours: 168,
      toHours: null,
    });
    expect(methodRange("pay_at_property", { kind: "within", amount: 48, unit: "hours" })).toEqual({
      fromHours: 0,
      toHours: 48,
    });
  });

  it("finds the lead times with no way to pay, PayPal included", () => {
    const windows = {
      bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
      pay_at_property: { kind: "within", amount: 48, unit: "hours" },
    } as const;
    // The ticket's example: card any time closes every gap.
    expect(
      noWayToPay({ ...off, card: true, pay_at_property: true, bank_transfer: true }, windows),
    ).toEqual([]);
    // Card off: guests booking 2-7 days ahead have no way to pay.
    const gap = noWayToPay({ ...off, pay_at_property: true, bank_transfer: true }, windows);
    expect(gap).toEqual([{ fromHours: 48, toHours: 168 }]);
    expect(
      t("settings.paymentWindows.gapBetween", { from: leadText(48, t), to: leadText(168, t) }),
    ).toBe("Guests booking between 48 hours and 7 days before arrival have no way to pay.");
    // PayPal is offered when check-in is further away than its own window (24 h here).
    expect(
      noWayToPay({ ...off, pay_at_property: true, bank_transfer: true, paypalHours: 24 }, windows),
    ).toEqual([]);
    expect(noWayToPay({ ...off, bank_transfer: true, paypalHours: 72 }, {})).toEqual([
      { fromHours: 0, toHours: 48 },
    ]);
    expect(noWayToPay(off, {})).toEqual([{ fromHours: 0, toHours: null }]);
  });

  it("says lead times in hours below three days, in days from there", () => {
    expect(leadText(1, t)).toBe("1 hour");
    expect(leadText(48, t)).toBe("48 hours");
    expect(leadText(72, t)).toBe("3 days");
    expect(leadText(100, t)).toBe("100 hours");
  });

  it("plans what the page's one save sends for the windows (VAY-2424)", () => {
    const saved = {
      card: { kind: "within", amount: 2, unit: "days" },
      bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
    } as const;
    const drafts = {
      card: draftOf(undefined),
      pay_at_property: { kind: "within", amount: "48", unit: "hours" },
      bank_transfer: draftOf(saved.bank_transfer),
    } as const;
    const methods = { ...off, pay_at_property: true, bank_transfer: true };
    // Card isn't offered: it keeps its saved window, whatever its row says.
    expect(paymentWindowsPlan(methods, saved, drafts)).toMatchObject({
      next: {
        card: saved.card,
        pay_at_property: { kind: "within", amount: 48, unit: "hours" },
        bank_transfer: saved.bank_transfer,
      },
      invalid: false,
      changed: true,
    });
    const unchanged = { ...drafts, pay_at_property: draftOf(undefined) };
    expect(paymentWindowsPlan(methods, saved, unchanged).changed).toBe(false);
    const tooShort = {
      ...unchanged,
      bank_transfer: { kind: "at_least", amount: "2", unit: "days" },
    } as const;
    expect(paymentWindowsPlan(methods, saved, tooShort).invalid).toBe(true);
    // A row guests aren't offered can't block the save.
    expect(paymentWindowsPlan({ ...methods, bank_transfer: false }, saved, tooShort).invalid).toBe(
      false,
    );
  });

  it("names the bank transfer rule when the API refuses the windows", () => {
    const refused = new FinancePaymentSettingsClientError({
      statusCode: 400,
      code: "bank_transfer_window_too_short",
      category: "validation",
      detail: "too short",
    });
    expect(
      paymentWindowsSaveError(refused, {
        bank_transfer: { kind: "within", amount: 2, unit: "days" },
      }),
    ).toBe("settings.paymentWindows.bankWithin");
    expect(paymentWindowsSaveError(refused, {})).toBe("settings.paymentWindows.bankAtLeast");
    expect(paymentWindowsSaveError(new Error("down"), {})).toBeNull();
  });
});
