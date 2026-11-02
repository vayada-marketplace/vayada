"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BANK_TRANSFER_PAYMENT_DEADLINE_HOURS,
  WINDOWED_PAYMENT_METHODS,
  parsePaymentMethodBookingWindows,
  paymentMethodGaps,
  paymentWindowHours,
  type PaymentMethodBookingWindow,
  type PaymentMethodBookingWindows,
  type PaymentMethodGap,
  type WindowedPaymentMethod,
} from "@vayada/domain-booking";
import {
  FinancePaymentSettingsClientError,
  getPaymentMethodWindows,
} from "@/services/api/financePaymentSettingsClient";

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** One row of the form: the amount stays text while the hotel types it. */
export type WindowDraft = {
  kind: "any" | "at_least" | "within";
  amount: string;
  unit: "hours" | "days";
};
export type WindowProblem = "amount" | "bank_at_least" | "bank_within";
/** The ways to pay a booking-windows plan covers (Step 1's switches), and PayPal's own
 * payment window. */
export type PaymentWindowMethods = Record<WindowedPaymentMethod, boolean> & {
  paypalHours: number | null;
};

export function draftOf(window: PaymentMethodBookingWindow | undefined): WindowDraft {
  return window
    ? { kind: window.kind, amount: String(window.amount), unit: window.unit }
    : { kind: "any", amount: "7", unit: "days" };
}

/** The saved window for a row, or why it can't be saved (D7: bank transfer needs more than 48 h). */
export function windowOf(
  method: WindowedPaymentMethod,
  draft: WindowDraft,
): { window: PaymentMethodBookingWindow | null } | { problem: WindowProblem } {
  if (draft.kind === "any") return { window: null };
  const amount = /^\d+$/.test(draft.amount.trim()) ? Number(draft.amount) : NaN;
  const window = {
    kind: draft.kind,
    amount,
    unit: draft.kind === "at_least" ? "days" : draft.unit,
  };
  const parsed = parsePaymentMethodBookingWindows({ [method]: window });
  if (parsed.ok) return { window: parsed.windows[method] ?? null };
  if (parsed.problem === "bank_transfer_window_too_short")
    return { problem: draft.kind === "at_least" ? "bank_at_least" : "bank_within" };
  return { problem: "amount" };
}

/** Lead times (hours before check-in) a way to pay covers; `to` null means "and further out". */
export function methodRange(
  method: WindowedPaymentMethod,
  window: PaymentMethodBookingWindow | undefined,
): PaymentMethodGap {
  const from = method === "bank_transfer" ? BANK_TRANSFER_PAYMENT_DEADLINE_HOURS : 0;
  if (window?.kind === "at_least")
    return { fromHours: Math.max(from, paymentWindowHours(window)), toHours: null };
  return { fromHours: from, toHours: window ? paymentWindowHours(window) : null };
}

/** Lead times with no way to pay. PayPal is offered when check-in is further away than its own
 * payment window (VAY-2145), so it covers everything beyond that. */
export function noWayToPay(
  methods: PaymentWindowMethods,
  windows: PaymentMethodBookingWindows,
): PaymentMethodGap[] {
  const on = WINDOWED_PAYMENT_METHODS.filter((method) => methods[method]);
  const gaps = paymentMethodGaps(on, windows);
  const paypal = methods.paypalHours;
  if (paypal === null) return gaps;
  return gaps
    .filter((gap) => gap.fromHours < paypal)
    .map((gap) => ({
      fromHours: gap.fromHours,
      toHours: gap.toHours === null ? paypal : Math.min(gap.toHours, paypal),
    }));
}

/** "48 hours" stays in hours below 3 days, "7 days" from there. */
export function leadText(hours: number, t: Translate): string {
  if (hours % 24 === 0 && hours >= 72)
    return t("settings.paymentWindows.days", { count: hours / 24 });
  return t(hours === 1 ? "settings.paymentWindows.hour" : "settings.paymentWindows.hours", {
    count: hours,
  });
}

export type WindowDrafts = Record<WindowedPaymentMethod, WindowDraft>;

/** The booking windows as saved and as edited. Payments saves them with the rest of the page
 * (VAY-2424), so the page holds this state and the card only shows it. */
export type PaymentWindowsState = {
  saved: PaymentMethodBookingWindows | null;
  drafts: WindowDrafts | null;
  deadlineHours: number;
  loadError: boolean;
  reload: () => void;
  update: (method: WindowedPaymentMethod, patch: Partial<WindowDraft>) => void;
  /** After a save: what the API stored becomes the saved state. */
  apply: (windows: PaymentMethodBookingWindows) => void;
  discard: () => void;
};

const draftsOf = (windows: PaymentMethodBookingWindows): WindowDrafts => ({
  card: draftOf(windows.card),
  pay_at_property: draftOf(windows.pay_at_property),
  bank_transfer: draftOf(windows.bank_transfer),
});

export function usePaymentWindows(propertyId: string | null): PaymentWindowsState {
  const [saved, setSaved] = useState<PaymentMethodBookingWindows | null>(null);
  const [drafts, setDrafts] = useState<WindowDrafts | null>(null);
  const [deadlineHours, setDeadlineHours] = useState(BANK_TRANSFER_PAYMENT_DEADLINE_HOURS);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const apply = useCallback((windows: PaymentMethodBookingWindows) => {
    setSaved(windows);
    setDrafts(draftsOf(windows));
  }, []);

  useEffect(() => {
    let current = true;
    setLoadError(false);
    setSaved(null);
    setDrafts(null);
    if (!propertyId) return;
    getPaymentMethodWindows({ propertyId }).then(
      (response) => {
        if (!current) return;
        setDeadlineHours(response.paymentDeadlineHours);
        apply(response.windows);
      },
      () => {
        if (current) setLoadError(true);
      },
    );
    return () => {
      current = false;
    };
  }, [apply, attempt, propertyId]);

  const update = useCallback((method: WindowedPaymentMethod, patch: Partial<WindowDraft>) => {
    setDrafts((previous) =>
      previous ? { ...previous, [method]: { ...previous[method], ...patch } } : previous,
    );
  }, []);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const discard = useCallback(() => {
    if (saved) setDrafts(draftsOf(saved));
  }, [saved]);
  return { saved, drafts, deadlineHours, loadError, reload, update, apply, discard };
}

/** What a save would send: the drafts of the ways guests are offered, the saved window for the
 * rest (the save replaces every window), and whether that is valid and differs from saved. */
export function paymentWindowsPlan(
  methods: PaymentWindowMethods,
  saved: PaymentMethodBookingWindows,
  drafts: WindowDrafts,
) {
  const results = Object.fromEntries(
    WINDOWED_PAYMENT_METHODS.map((method) => [method, windowOf(method, drafts[method])]),
  ) as Record<WindowedPaymentMethod, ReturnType<typeof windowOf>>;
  const next: PaymentMethodBookingWindows = {};
  for (const method of WINDOWED_PAYMENT_METHODS) {
    const result = results[method];
    const window = methods[method] && "window" in result ? result.window : saved[method];
    if (window) next[method] = window;
  }
  const invalid = WINDOWED_PAYMENT_METHODS.some(
    (method) => methods[method] && "problem" in results[method],
  );
  const changed = WINDOWED_PAYMENT_METHODS.some((method) => {
    const [before, after] = [saved[method], next[method]];
    return (
      before?.kind !== after?.kind ||
      before?.amount !== after?.amount ||
      before?.unit !== after?.unit
    );
  });
  return { results, next, invalid, changed };
}

/** Why the API refused the windows, as Payments says it (D7: bank transfer's own rule). */
export function paymentWindowsSaveError(
  error: unknown,
  next: PaymentMethodBookingWindows,
): string | null {
  if (
    !(error instanceof FinancePaymentSettingsClientError) ||
    error.code !== "bank_transfer_window_too_short"
  )
    return null;
  return next.bank_transfer?.kind === "within"
    ? "settings.paymentWindows.bankWithin"
    : "settings.paymentWindows.bankAtLeast";
}
