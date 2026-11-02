"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
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
import { useTranslation } from "@/lib/i18n";
import {
  FinancePaymentSettingsClientError,
  getPaymentMethodWindows,
} from "@/services/api/financePaymentSettingsClient";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** One row of the form: the amount stays text while the hotel types it. */
export type WindowDraft = {
  kind: "any" | "at_least" | "within";
  amount: string;
  unit: "hours" | "days";
};
export type WindowProblem = "amount" | "bank_at_least" | "bank_within";
/** The ways to pay guests are offered now: saved, and ready (Stripe connected, bank details
 * saved). PayPal keeps its own payment window. */
export type PaymentWindowMethods = Record<WindowedPaymentMethod, boolean> & {
  paypalHours: number | null;
};

const METHOD_LABEL: Record<WindowedPaymentMethod, string> = {
  card: "settings.billing.onlineCard",
  pay_at_property: "settings.billing.payAtHotel",
  bank_transfer: "settings.billing.bankTransfer",
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

function gapText(gap: PaymentMethodGap, t: Translate): string {
  if (gap.toHours === null)
    return gap.fromHours === 0
      ? t("settings.paymentWindows.gapAlways")
      : t("settings.paymentWindows.gapBeyond", { from: leadText(gap.fromHours, t) });
  if (gap.fromHours === 0)
    return t("settings.paymentWindows.gapUnder", { to: leadText(gap.toHours, t) });
  return t("settings.paymentWindows.gapBetween", {
    from: leadText(gap.fromHours, t),
    to: leadText(gap.toHours, t),
  });
}

// The strip's axis: hours before check-in on a stretched scale, so the first days stay readable.
const AXIS: [number, number][] = [
  [0, 0],
  [48, 0.22],
  [168, 0.48],
  [336, 0.68],
  [720, 0.88],
  [8760, 1],
];
const TICKS = [0, 48, 168, 336, 720];

function axisPercent(hours: number | null): number {
  if (hours === null) return 100;
  for (let i = 1; i < AXIS.length; i += 1) {
    const [h0, p0] = AXIS[i - 1];
    const [h1, p1] = AXIS[i];
    if (hours <= h1) return (p0 + ((p1 - p0) * (hours - h0)) / (h1 - h0)) * 100;
  }
  return 100;
}

/** The striped amber of "no way to pay", as the PMS draws a held booking. */
const GAP_STRIPES = {
  backgroundImage:
    "repeating-linear-gradient(135deg, #FEF3C7 0px, #FEF3C7 6px, #FFFBEB 6px, #FFFBEB 12px)",
};

function Segment({
  range,
  className,
  label,
}: {
  range: PaymentMethodGap;
  className: string;
  label?: string;
}) {
  const left = axisPercent(range.fromHours);
  return (
    <div
      className={`absolute inset-y-0 flex items-center justify-center overflow-hidden rounded-md ${className}`}
      style={{
        left: `${left}%`,
        width: `${axisPercent(range.toHours) - left}%`,
        ...(label ? GAP_STRIPES : {}),
      }}
    >
      {label && (
        <span className="hidden whitespace-nowrap text-[11px] font-semibold text-amber-800 sm:inline">
          {label}
        </span>
      )}
    </div>
  );
}

function Lane({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-[12px] font-medium text-gray-700 sm:w-32">{name}</span>
      <div className="relative h-[22px] flex-1 rounded-md bg-gray-100">{children}</div>
    </div>
  );
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

/**
 * VAY-2348: Booking Admin › Payments › "When guests can pay each way": when guests booking a given
 * time before arrival can pay each way they are offered, and where they have no way to pay. The
 * windows are chosen in Step 1 (VAY-2424); the page's one Save stores them.
 */
export function PaymentWindowsCard({
  methods,
  windows,
}: {
  methods: PaymentWindowMethods;
  windows: PaymentWindowsState;
}) {
  const { t } = useTranslation();
  const { saved, drafts, loadError } = windows;

  const heading = (
    <div>
      <h2 id="payment-windows-heading" className="text-sm font-semibold text-gray-900">
        {t("settings.paymentWindows.title")}
      </h2>
      <p className="mt-0.5 text-[12px] text-gray-500">{t("settings.paymentWindows.description")}</p>
    </div>
  );
  if (loadError || !saved || !drafts)
    return (
      <section
        aria-labelledby="payment-windows-heading"
        className="rounded-lg border border-gray-200 bg-white p-4 md:p-5"
      >
        {heading}
        {loadError ? (
          <div role="alert" className="mt-3 flex items-center justify-between gap-4 text-sm">
            <span className="text-red-600">{t("settings.paymentWindows.loadFailed")}</span>
            <button
              type="button"
              onClick={windows.reload}
              className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              {t("settings.paymentsSave.tryAgain")}
            </button>
          </div>
        ) : (
          <p role="status" className="mt-3 text-[13px] text-gray-500">
            {t("admin.loadingCurrentSetting")}
          </p>
        )}
      </section>
    );

  const shown = WINDOWED_PAYMENT_METHODS.filter((method) => methods[method]);
  const { next } = paymentWindowsPlan(methods, saved, drafts);
  const gaps = noWayToPay(methods, next);
  const lanes: { name: string; range: PaymentMethodGap }[] = shown.map((method) => ({
    name: t(METHOD_LABEL[method]),
    range: methodRange(method, next[method]),
  }));
  if (methods.paypalHours !== null)
    lanes.push({ name: "PayPal", range: { fromHours: methods.paypalHours, toHours: null } });
  const bookable: PaymentMethodGap[] = [];
  let from = 0;
  for (const gap of gaps) {
    if (gap.fromHours > from) bookable.push({ fromHours: from, toHours: gap.fromHours });
    from = gap.toHours ?? Number.POSITIVE_INFINITY;
  }
  if (from !== Number.POSITIVE_INFINITY) bookable.push({ fromHours: from, toHours: null });

  return (
    <section
      aria-labelledby="payment-windows-heading"
      className="overflow-hidden rounded-lg border border-gray-200 bg-white"
    >
      <div className="p-4 pb-3 md:p-5 md:pb-3">{heading}</div>
      <div
        aria-hidden="true"
        className="space-y-2 bg-gray-50/60 px-4 py-4 md:px-5"
        data-testid="payment-windows-strip"
      >
        <p className="text-[12px] font-medium text-gray-600">
          {t("settings.paymentWindows.stripTitle")}
        </p>
        {lanes.map((lane) => (
          <Lane key={lane.name} name={lane.name}>
            <Segment range={lane.range} className="bg-primary-500" />
          </Lane>
        ))}
        <Lane name={t("settings.paymentWindows.guestsCanBook")}>
          {bookable.map((range) => (
            <Segment key={`ok-${range.fromHours}`} range={range} className="bg-green-500" />
          ))}
          {gaps.map((range) => (
            <Segment
              key={`gap-${range.fromHours}`}
              range={range}
              label={t("settings.paymentWindows.noWayToPay")}
              className="border-[1.5px] border-dashed border-amber-600"
            />
          ))}
        </Lane>
        <div className="flex gap-3">
          <span className="w-24 shrink-0 sm:w-32" />
          <div className="relative h-3.5 flex-1">
            {TICKS.map((hours) => (
              <span
                key={hours}
                className={`absolute whitespace-nowrap text-[11px] text-gray-500 ${hours === 48 || hours === 720 ? "hidden sm:inline" : ""}`}
                style={{ left: `${axisPercent(hours)}%` }}
              >
                {hours === 0 ? t("settings.paymentWindows.arrival") : leadText(hours, t)}
              </span>
            ))}
          </div>
        </div>
      </div>
      {gaps.length > 0 && (
        <div
          role="status"
          className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-[12px] md:px-5"
        >
          {gaps.map((gap) => (
            <p key={gap.fromHours} className="text-[13px] font-semibold text-amber-800">
              {gapText(gap, t)}
            </p>
          ))}
          <p className="text-amber-700">{t("settings.paymentWindows.gapHelp")}</p>
        </div>
      )}
    </section>
  );
}
