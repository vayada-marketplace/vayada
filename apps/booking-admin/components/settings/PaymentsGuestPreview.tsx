"use client";

import { useState, type CSSProperties } from "react";
import type { PaymentMethodBookingWindows, PaymentMethodGap } from "@vayada/domain-booking";
import { useTranslation } from "@/lib/i18n";
import {
  leadText,
  methodRange,
  noWayToPay,
  type PaymentWindowsState,
  type Translate,
} from "@/components/settings/paymentWindows";

export type PreviewMethod = "card" | "pay_at_property" | "bank_transfer" | "paypal";

/** The ways to pay as Step 1 shows them now (saved or not), whether a payment account can take
 * Credit card, and whether there are bank details to give guests for Bank transfer. */
export type PreviewMethods = Record<PreviewMethod, boolean> & {
  paypalHours: number;
  cardReady: boolean;
  bankReady: boolean;
};

/** Switched on, but guests can't use it yet: drawn striped and not offered at checkout. */
export const notReady = (methods: PreviewMethods, method: PreviewMethod) =>
  (method === "card" && !methods.cardReady) || (method === "bank_transfer" && !methods.bankReady);

const ORDER: PreviewMethod[] = ["card", "pay_at_property", "bank_transfer", "paypal"];
const NAME: Record<PreviewMethod, string> = {
  card: "settings.billing.onlineCard",
  pay_at_property: "settings.billing.payAtHotel",
  bank_transfer: "settings.billing.bankTransfer",
  paypal: "settings.payments.paypal",
};

/** Timo's mockup: when a guest books, in days before arrival. */
const LEADS: [days: number, label: string][] = [
  [0, "settings.payments.leadTonight"],
  [3, "settings.payments.leadThreeDays"],
  [14, "settings.payments.leadTwoWeeks"],
  [30, "settings.payments.leadMonth"],
];

// The mockup's axis: arrival, 48 hours, 7, 14 and 30+ days at equal steps.
const STOPS: [hours: number, percent: number][] = [
  [0, 0],
  [48, 25],
  [168, 50],
  [336, 75],
  [720, 100],
];

export function axisPercent(hours: number | null): number {
  if (hours === null || hours >= 720) return 100;
  for (let i = 1; i < STOPS.length; i += 1) {
    const [h0, p0] = STOPS[i - 1];
    const [h1, p1] = STOPS[i];
    if (hours <= h1) return p0 + ((p1 - p0) * (hours - h0)) / (h1 - h0);
  }
  return 100;
}

/** Where a range sits on the axis. Anything from 30 days on keeps a visible tail. */
export function rangeBox(range: PaymentMethodGap): { left: number; width: number } {
  const left = range.fromHours >= 720 ? 96 : axisPercent(range.fromHours);
  return { left, width: axisPercent(range.toHours) - left };
}

/** Lead times (hours before check-in) each way to pay covers. */
export function previewRanges(
  methods: PreviewMethods,
  windows: PaymentMethodBookingWindows,
): Record<PreviewMethod, PaymentMethodGap> {
  return {
    card: methodRange("card", windows.card),
    pay_at_property: methodRange("pay_at_property", windows.pay_at_property),
    bank_transfer: methodRange("bank_transfer", windows.bank_transfer),
    paypal: { fromHours: methods.paypalHours, toHours: null },
  };
}

/** What a guest booking `hours` before arrival can choose at checkout. PayPal needs check-in
 * further away than its own payment window (strictly, as the API offers it). */
export function checkoutMethods(
  methods: PreviewMethods,
  windows: PaymentMethodBookingWindows,
  hours: number,
): PreviewMethod[] {
  const ranges = previewRanges(methods, windows);
  return ORDER.filter((method) => {
    const { fromHours, toHours } = ranges[method];
    return (
      methods[method] &&
      !notReady(methods, method) &&
      (method === "paypal" ? hours > fromHours : hours >= fromHours) &&
      (toHours === null || hours <= toHours)
    );
  });
}

/** Lead times with no way to pay, and the rest, for the "Guests can book" bar. */
export function bookingGaps(methods: PreviewMethods, windows: PaymentMethodBookingWindows) {
  const gaps = noWayToPay(
    {
      card: methods.card && methods.cardReady,
      pay_at_property: methods.pay_at_property,
      bank_transfer: methods.bank_transfer && methods.bankReady,
      paypalHours: methods.paypal ? methods.paypalHours : null,
    },
    windows,
  );
  const bookable: PaymentMethodGap[] = [];
  let from = 0;
  for (const gap of gaps) {
    if (gap.fromHours > from) bookable.push({ fromHours: from, toHours: gap.fromHours });
    from = gap.toHours ?? Number.POSITIVE_INFINITY;
  }
  if (from !== Number.POSITIVE_INFINITY) bookable.push({ fromHours: from, toHours: null });
  return { gaps, bookable };
}

export function gapText(gap: PaymentMethodGap, t: Translate): string {
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

// Switched on but not usable yet (Credit card without an account, Bank transfer without bank
// details): the mockup's stripes.
const HIDDEN_STRIPES = "repeating-linear-gradient(135deg, #C7CDF9 0 8px, #E0E4FD 8px 16px)";
// "No way to pay" stretches, as the PMS draws a held booking (VAY-2348).
const GAP_STRIPES =
  "repeating-linear-gradient(135deg, #FEF3C7 0px, #FEF3C7 6px, #FFFBEB 6px, #FFFBEB 12px)";

function Bar({
  range,
  className,
  style,
}: {
  range: PaymentMethodGap;
  className: string;
  style?: CSSProperties;
}) {
  const { left, width } = rangeBox(range);
  return (
    <div
      className={`absolute inset-y-0 rounded-lg ${className}`}
      style={{ left: `${left}%`, width: `${width}%`, ...style }}
    />
  );
}

const LABEL =
  "w-24 shrink-0 break-words text-[13px] text-slate-900 hyphens-auto sm:w-[140px] sm:text-sm";

/**
 * VAY-2424, Booking Admin › Payments › "What guests will see": for a guest booking tonight, 3
 * days, 2 weeks or a month ahead, which ways to pay checkout offers, on a timeline of Step 1's
 * choices as they are now (VAY-2348's booking windows). Where nothing is offered, guests can't
 * book.
 */
export function PaymentsGuestPreview({
  methods,
  windows,
  next,
}: {
  methods: PreviewMethods;
  windows: PaymentWindowsState;
  /** The booking windows a save would send: Step 1's choices for the ways switched on. */
  next: PaymentMethodBookingWindows | null;
}) {
  const { t } = useTranslation();
  const [lead, setLead] = useState(3);
  const heading = (
    <div className="flex flex-col gap-1">
      <h2 id="payment-preview-heading" className="text-lg font-semibold text-slate-900">
        {t("settings.payments.previewTitle")}
      </h2>
      <p className="text-sm text-slate-600">{t("settings.payments.previewDesc")}</p>
    </div>
  );
  const frame = "flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-6";
  if (windows.loadError || !next)
    return (
      <section aria-labelledby="payment-preview-heading" className={frame}>
        {heading}
        {windows.loadError ? (
          <div role="alert" className="flex items-center justify-between gap-4 text-sm">
            <span className="text-red-600">{t("settings.paymentWindows.loadFailed")}</span>
            <button
              type="button"
              onClick={windows.reload}
              className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              {t("settings.paymentsSave.tryAgain")}
            </button>
          </div>
        ) : (
          <p role="status" className="text-[13px] text-slate-500">
            {t("admin.loadingCurrentSetting")}
          </p>
        )}
      </section>
    );

  const ranges = previewRanges(methods, next);
  const { gaps, bookable } = bookingGaps(methods, next);
  const atLead = checkoutMethods(methods, next, lead * 24);
  return (
    <section aria-labelledby="payment-preview-heading" className={frame}>
      {heading}
      <div
        role="group"
        aria-label={t("settings.payments.leadGroup")}
        className="flex flex-wrap gap-2"
      >
        {LEADS.map(([days, label]) => (
          <button
            key={days}
            type="button"
            aria-pressed={lead === days}
            onClick={() => setLead(days)}
            className={`h-10 rounded-full border px-3.5 text-sm transition-colors ${
              lead === days
                ? "border-primary-500 bg-[#EEF0FD] font-semibold text-[#2433B0]"
                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
            }`}
          >
            {t(label)}
          </button>
        ))}
      </div>

      <div
        role="img"
        aria-label={t("settings.payments.timelineLabel")}
        data-testid="payment-windows-strip"
        className="flex flex-col gap-3 rounded-[10px] border border-slate-200 bg-slate-50 p-4 sm:p-5"
      >
        <span className="text-[13px] text-slate-600">
          {t("settings.paymentWindows.stripTitle")}
        </span>
        <div className="flex flex-col gap-3">
          <div className="relative flex flex-col gap-3">
            {ORDER.filter((method) => methods[method]).map((method) => (
              <div key={method} className="flex items-center gap-3 sm:gap-4">
                <span className={LABEL}>{t(NAME[method])}</span>
                <div className="relative h-7 flex-1 overflow-hidden rounded-lg bg-[#EEF2F6]">
                  <Bar
                    range={ranges[method]}
                    className={notReady(methods, method) ? "" : "bg-primary-500"}
                    style={
                      notReady(methods, method) ? { backgroundImage: HIDDEN_STRIPES } : undefined
                    }
                  />
                </div>
              </div>
            ))}
            <div className="flex items-center gap-3 sm:gap-4">
              <span className={LABEL}>{t("settings.paymentWindows.guestsCanBook")}</span>
              <div className="relative h-7 flex-1 overflow-hidden rounded-lg bg-[#EEF2F6]">
                {bookable.map((range) => (
                  <Bar key={`ok-${range.fromHours}`} range={range} className="bg-[#22A55A]" />
                ))}
                {gaps.map((range) => {
                  const { left, width } = rangeBox(range);
                  return (
                    <div
                      key={`gap-${range.fromHours}`}
                      className="absolute inset-y-0 flex items-center justify-center overflow-hidden rounded-lg border-[1.5px] border-dashed border-amber-600"
                      style={{ left: `${left}%`, width: `${width}%`, backgroundImage: GAP_STRIPES }}
                    >
                      <span className="hidden whitespace-nowrap text-[11px] font-semibold text-amber-800 sm:inline">
                        {t("settings.paymentWindows.noWayToPay")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* The chosen booking time, over the bars only. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-y-1.5 inset-x-0 flex gap-3 sm:gap-4"
            >
              <span className={LABEL} />
              <div className="relative flex-1">
                <div
                  data-testid="payment-preview-marker"
                  className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-[#2433B0]"
                  style={{ left: `${axisPercent(lead * 24)}%` }}
                />
              </div>
            </div>
          </div>
          {/* Below sm, three labels (0, 50 and 100%) still sit on their stops. */}
          <div className="flex gap-3 sm:gap-4">
            <span className={LABEL} />
            <div className="flex flex-1 justify-between text-[11px] text-slate-500 sm:text-xs">
              <span>{t("settings.paymentWindows.arrival")}</span>
              <span className="hidden sm:inline">{leadText(48, t)}</span>
              <span>{leadText(168, t)}</span>
              <span className="hidden sm:inline">{leadText(336, t)}</span>
              <span>{t("settings.payments.axisBeyond", { count: 30 })}</span>
            </div>
          </div>
        </div>
      </div>
      {gaps.length > 0 && (
        <div role="status" className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3">
          {gaps.map((gap) => (
            <p key={gap.fromHours} className="text-[13px] font-semibold text-amber-800">
              {gapText(gap, t)}
            </p>
          ))}
          <p className="text-[12px] text-amber-700">{t("settings.paymentWindows.gapHelp")}</p>
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-[10px] border border-slate-200 bg-slate-50 p-4">
        <span className="text-[13px] text-slate-600">{t("settings.payments.checkoutTitle")}</span>
        {atLead.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label={t("settings.payments.checkoutTitle")}>
            {atLead.map((method) => (
              <li
                key={method}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
              >
                {t(NAME[method])}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-sm font-medium text-red-700">
            {t("settings.payments.noWayAtLead")}
          </span>
        )}
      </div>
    </section>
  );
}
