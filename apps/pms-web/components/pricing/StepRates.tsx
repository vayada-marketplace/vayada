"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MinusIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { PricingPaymentMethod } from "@vayada/domain-booking/replacement-pricing";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { errorText } from "./pricingAmounts";
import { usePricingManualMethods } from "./pricingManualMethods";
import {
  cancellationDays,
  cancellationEdits,
  defaultDiscount,
  defaultFreeDays,
  rateMethodEdits,
  setDiscount,
  switchOption,
  type SimpleRoom,
} from "./simplePricing";
import { money, type OptionTerms } from "./stepPricing";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

type Terms = Readonly<Record<string, OptionTerms | undefined>>;
type Edits = { offerId: string; terms: OptionTerms }[];
type Payment = OptionTerms["payment"];

// Card online shows once Payment settings say it is ready (VAY-2205); until then only a rate that already takes it
// lists it, so it can be removed.
const cardReady = false;
const methodHints = {
  card: "pricing.rates.method.card",
  pay_at_property: "pricing.rates.method.payAtProperty",
  bank_transfer: "pricing.rates.method.bankTransfer",
  paypal: "pricing.rates.method.paypal",
} as const;
const methodNames = {
  card: "pricing.paymentMethods.card",
  pay_at_property: "pricing.paymentMethods.payAtProperty",
  bank_transfer: "pricing.paymentMethods.bankTransfer",
  paypal: "pricing.paymentMethods.paypal",
} as const;
const sectionLabel = "text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500";
const discountOf = (offer: SimpleRoom["nonRefundable"]) =>
  offer?.price.kind === "linked" && offer.price.adjustment.kind === "percentage"
    ? -offer.price.adjustment.basisPoints
    : null;

/** Step "Rates" (VAY-2282, approved board): how guests can book the room. The Flexible rate is the main option (always
 * on for now: switching it off waits for the API's sold-where setting) and the Non-refundable rate is the
 * non-refundable switch, side by side, each with its own cancellation, payment at booking and payment methods.
 * "Paid when booking" is read from the methods until card payments and deposits come (VAY-2205). `children` is the
 * "Other booking options" list (VAY-2283). */
export function StepRates({
  room,
  simple,
  terms,
  failed,
  prices,
  disabled,
  onTerms,
  onRetry,
  onEditOwn,
  onAdd,
  onRemove,
  onChange,
  onPending,
  edited = [],
  children,
}: {
  room: PricingConfiguration;
  /** Null while the options' terms load (or failed). */
  simple: SimpleRoom | null;
  terms: Terms;
  failed: boolean;
  /** Each option's normal night for the sample guests (see `normalNight`). */
  prices: Readonly<Record<string, string | null>>;
  disabled: boolean;
  onTerms: (edits: Edits) => void;
  onRetry: () => void;
  /** Opens the main option's window, where a partial refund's steps are set. */
  onEditOwn: () => void;
  /** Adds the non-refundable option; returns why it couldn't. */
  onAdd: (input: ReturnType<typeof switchOption>) => unknown;
  onRemove: (offerId: string) => void;
  onChange: (room: PricingConfiguration) => void;
  onPending: (pending: boolean) => void;
  /** Options whose terms have unsaved edits: they are written on Save. */
  edited?: readonly string[];
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <StepCard step={3} title={t("pricing.rates.title")} hint={t("pricing.rates.hint")}>
      {!simple ? (
        failed ? (
          <p role="status" className="text-[14px] text-amber-700">
            {t("pricing.simple.cancellation.failed")}{" "}
            <button type="button" onClick={onRetry} className={ui.stepLink}>
              {t("pricing.steps.options.retry")}
            </button>
          </p>
        ) : (
          <p role="status" className={ui.stepHint}>
            {t("pricing.simple.cancellation.loading")}
          </p>
        )
      ) : (
        <div className="grid items-stretch gap-3 lg:grid-cols-2">
          <FlexibleRate
            simple={simple}
            terms={terms}
            disabled={disabled}
            onTerms={onTerms}
            onEditOwn={onEditOwn}
          />
          <NonRefundableRate
            room={room}
            simple={simple}
            terms={terms}
            prices={prices}
            disabled={disabled}
            onTerms={onTerms}
            onAdd={onAdd}
            onRemove={onRemove}
            onChange={onChange}
            onPending={onPending}
            edited={edited}
          />
        </div>
      )}
      {children}
    </StepCard>
  );
}

function RateCard({
  name,
  sub,
  control,
  children,
}: {
  name: string;
  sub: string;
  control: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={name}
      className="flex min-w-0 flex-col gap-3.5 rounded-xl border border-gray-200 bg-white p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-[15px] font-semibold text-gray-900">{name}</h4>
          <p className="text-[12px] text-gray-500">{sub}</p>
        </div>
        {control}
      </div>
      {children}
    </section>
  );
}

/** One part of a rate card under a small label; `className` gives both cards' parts the same height, so the parts
 * line up side by side. */
function Part({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`space-y-2.5 border-t border-gray-100 pt-3.5 ${className}`}>
      <p className={sectionLabel}>{label}</p>
      {children}
    </div>
  );
}

function FlexibleRate({
  simple,
  terms,
  disabled,
  onTerms,
  onEditOwn,
}: {
  simple: SimpleRoom;
  terms: Terms;
  disabled: boolean;
  onTerms: (edits: Edits) => void;
  onEditOwn: () => void;
}) {
  const { t } = useTranslation();
  const current = simple.cancellation;
  const days = current.kind === "free" ? current.days : defaultFreeDays;
  const choices = Array.from(new Set<number>([...cancellationDays, days])).sort((a, b) => a - b);
  const dayText = (count: number) =>
    t(
      count === 1
        ? "pricing.simple.cancellation.days.one"
        : "pricing.simple.cancellation.days.other",
      { count },
    );
  const free = (count: number) => {
    if (disabled || (current.kind === "free" && current.days === count)) return;
    onTerms(cancellationEdits(simple, terms, { kind: "free", days: count }));
  };
  const sub =
    current.kind === "free"
      ? t("pricing.rates.freeSub", { days: dayText(current.days) })
      : current.kind === "own"
        ? t("pricing.rates.partial")
        : t("pricing.simple.cancellation.nonRefundable");
  return (
    <RateCard
      name={t("pricing.rates.flexible")}
      sub={sub}
      control={
        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[12px] font-medium text-gray-600">
          {t("pricing.rates.alwaysOn")}
        </span>
      }
    >
      <Part label={t("pricing.simple.cancellation.title")} className="lg:min-h-[150px]">
        <div
          role="group"
          aria-label={t("pricing.simple.cancellation.title")}
          className="grid grid-cols-2 gap-0.5 rounded-lg bg-gray-100 p-[3px]"
        >
          {(
            [
              ["free", t("pricing.simple.cancellation.free"), () => free(days)],
              ["own", t("pricing.rates.partial"), onEditOwn],
            ] as const
          ).map(([kind, label, choose]) => (
            <button
              key={kind}
              type="button"
              aria-pressed={current.kind === kind}
              disabled={disabled}
              onClick={choose}
              className={`h-8 rounded-md px-3 text-[13px] font-medium disabled:cursor-not-allowed ${
                current.kind === kind ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {current.kind === "free" ? (
          <div className="space-y-1.5">
            <p className="text-[13px] text-gray-600">{t("pricing.rates.freeUntil")}</p>
            <div
              role="group"
              aria-label={t("pricing.rates.freeUntil")}
              className="flex flex-wrap gap-1.5"
            >
              {choices.map((count) => (
                <button
                  key={count}
                  type="button"
                  aria-pressed={count === days}
                  aria-label={dayText(count)}
                  disabled={disabled}
                  onClick={() => free(count)}
                  className={`h-[34px] min-w-9 rounded-lg border px-2 text-[13px] font-medium disabled:cursor-not-allowed ${
                    count === days
                      ? "border-primary-500 bg-primary-50 text-primary-700"
                      : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {count}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-gray-700">
            {t(
              current.kind === "own" ? "pricing.rates.partialText" : "pricing.rates.flexibleLocked",
            )}{" "}
            {current.kind === "own" && (
              <button type="button" disabled={disabled} onClick={onEditOwn} className={ui.stepLink}>
                {t("pricing.steps.options.edit")}
              </button>
            )}
          </p>
        )}
        {simple.breakfast && current.kind !== "own" && (
          <p className="text-[12px] text-gray-500">
            {t("pricing.simple.cancellation.withBreakfast")}
          </p>
        )}
      </Part>
      <PaidWhenBooking rate="flexible" payment={simple.mainTerms.payment} />
      <RateMethods
        rate="flexible"
        methods={simple.mainTerms.payment.acceptedMethods ?? []}
        disabled={disabled}
        onChange={(methods) => onTerms(rateMethodEdits(simple, terms, "flexible", methods))}
      />
    </RateCard>
  );
}

function NonRefundableRate({
  room,
  simple,
  terms,
  prices,
  disabled,
  onTerms,
  onAdd,
  onRemove,
  onChange,
  onPending,
  edited,
}: {
  room: PricingConfiguration;
  simple: SimpleRoom;
  terms: Terms;
  prices: Readonly<Record<string, string | null>>;
  disabled: boolean;
  onTerms: (edits: Edits) => void;
  onAdd: (input: ReturnType<typeof switchOption>) => unknown;
  onRemove: (offerId: string) => void;
  onChange: (room: PricingConfiguration) => void;
  onPending: (pending: boolean) => void;
  edited: readonly string[];
}) {
  const { t } = useTranslation();
  const manual = usePricingManualMethods();
  const { nonRefundable: offer, mainTerms } = simple;
  const saved = discountOf(offer);
  const [typed, setTyped] = useState(saved === null ? defaultDiscount : String(saved / 100));
  const [error, setError] = useState("");
  // A reload or a reset brings the saved discount back; text that already means it ("1", "12.") stays as typed.
  useEffect(() => {
    if (saved !== null)
      setTyped((text) =>
        Math.round(Number(text.trim()) * 100) === saved ? text : String(saved / 100),
      );
  }, [saved]);
  // The editor's callback is new on every render, so it is read through a ref.
  const pendingRef = useRef(onPending);
  useEffect(() => {
    pendingRef.current = onPending;
  });
  // Old terms that still accept pay at property can't be written again (VAY-2280): once the rate's terms are edited,
  // Save waits until pay at property is unticked. Nothing is unticked for the hotel.
  const blocked =
    !!offer &&
    edited.includes(offer.id) &&
    !!terms[offer.id]?.payment.acceptedMethods?.includes("pay_at_property");
  // A discount that doesn't parse holds Save while the rate is on.
  const pending = !!(error && offer) || blocked;
  useEffect(() => pendingRef.current(pending), [pending]);
  const available = simple.cancellation.kind === "free";
  const edit = (value: string) => {
    setTyped(value);
    if (!offer) return setError("");
    try {
      onChange(setDiscount(room, offer.id, value));
      setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.linkedOffer.errorCheck"));
    }
  };
  const step = (delta: number) => {
    const current = Number(typed.trim());
    if (Number.isFinite(current))
      edit(String(Math.min(99, Math.max(1, Math.round(current) + delta))));
  };
  const toggle = () => {
    if (disabled || !available) return;
    if (offer) {
      setError("");
      if (saved !== null) setTyped(String(saved / 100));
      return onRemove(offer.id);
    }
    // Non-refundable stays are paid in advance, so the rate starts with the main option's other methods, or the
    // hotel's ready bank transfer or PayPal.
    const main = mainTerms.payment.acceptedMethods;
    const advance = (main ?? []).filter((method) => method !== "pay_at_property");
    const methods = advance.length ? advance : [...manual];
    if (main && !methods.length) return setError(t("pricing.rates.needsAdvance"));
    try {
      const failure = onAdd(
        switchOption(
          room,
          crypto.randomUUID(),
          "non_refundable",
          { percent: typed, ...(main ? { methods } : {}) },
          mainTerms,
        ),
      );
      if (failure) setError(errorText(failure, t, "pricing.linkedOffer.errorCheck"));
      else setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.linkedOffer.errorCheck"));
    }
  };
  const name = t("pricing.rates.nonRefundable");
  const before = prices[simple.main.id],
    after = offer ? prices[offer.id] : null;
  return (
    <RateCard
      name={name}
      sub={
        offer && saved !== null
          ? t("pricing.rates.nonRefundableSub", { percent: saved / 100 })
          : t("pricing.rates.nonRefundableOffSub")
      }
      control={
        <button
          type="button"
          role="switch"
          aria-checked={!!offer}
          aria-label={t("pricing.simple.extras.turnOn", {
            name: t("pricing.simple.extras.nonRefundable"),
          })}
          disabled={disabled || !available}
          onClick={toggle}
          className={ui.switchTrack(!!offer)}
        >
          <span aria-hidden="true" className="h-[18px] w-[18px] rounded-full bg-white shadow-sm" />
        </button>
      }
    >
      {!offer ? (
        <p className="text-[13px] text-gray-500">
          {t(available ? "pricing.rates.nonRefundableOff" : "pricing.rates.nonRefundableNeedsFree")}
        </p>
      ) : (
        <>
          <Part label={t("pricing.rates.discount")} className="lg:min-h-[150px]">
            <p className="text-[13px] text-gray-600">{t("pricing.rates.discountQuestion")}</p>
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex h-10 items-center gap-1 rounded-[10px] border border-gray-300 bg-white px-1.5">
                <button
                  type="button"
                  aria-label={t("pricing.rates.discountLess")}
                  disabled={disabled}
                  onClick={() => step(-1)}
                  className="rounded-md p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                >
                  <MinusIcon aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
                <input
                  aria-label={t("pricing.simple.extras.discountLabel")}
                  aria-invalid={!!error || undefined}
                  inputMode="decimal"
                  disabled={disabled}
                  value={typed}
                  onChange={(event) => edit(event.target.value)}
                  className="w-10 bg-transparent text-center text-[14px] font-semibold text-gray-900 outline-none"
                />
                <span className="text-[14px] font-semibold text-gray-900">%</span>
                <button
                  type="button"
                  aria-label={t("pricing.rates.discountMore")}
                  disabled={disabled}
                  onClick={() => step(1)}
                  className="rounded-md p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                >
                  <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </div>
              {before && after && (
                <span className="flex items-center gap-1.5">
                  <s className="text-[13px] text-gray-400">{money(before, room.currency)}</s>
                  <span className="text-[14px] font-semibold text-gray-900">
                    {t("pricing.simple.extras.night", { amount: money(after, room.currency) })}
                  </span>
                </span>
              )}
            </div>
          </Part>
          <PaidWhenBooking
            rate="non_refundable"
            payment={terms[offer.id]?.payment ?? mainTerms.payment}
          />
          <RateMethods
            rate="non_refundable"
            methods={terms[offer.id]?.payment.acceptedMethods ?? []}
            disabled={disabled}
            onChange={(methods) =>
              onTerms(rateMethodEdits(simple, terms, "non_refundable", methods))
            }
          />
        </>
      )}
      {blocked && (
        <p role="alert" className={ui.errorText}>
          {t("pricing.error.nonRefundablePayAtProperty")}
        </p>
      )}
      {error && (
        <p role="alert" className={ui.errorText}>
          {error}
        </p>
      )}
    </RateCard>
  );
}

/** "Paid when booking", read from the rate's terms (VAY-2280: the choice itself comes with card payments, VAY-2205):
 * the deposit a rate already has, else nothing when guests may pay at the property, the full stay otherwise. A
 * non-refundable stay is always paid in advance, even where old terms still name pay at property. */
function PaidWhenBooking({
  rate,
  payment,
}: {
  rate: "flexible" | "non_refundable";
  payment: Payment;
}) {
  const { t } = useTranslation();
  const methods = payment.acceptedMethods;
  const [value, hint] =
    payment.kind === "deposit"
      ? [
          t("pricing.rates.paid.deposit"),
          t("pricing.terms.deposit", {
            percent: payment.basisPoints / 100,
            days: payment.balanceDaysBeforeArrival,
          }),
        ]
      : rate === "non_refundable"
        ? [t("pricing.rates.paid.full"), t("pricing.rates.paid.fullHint")]
        : !methods
          ? [t("pricing.rates.paid.settings"), t("pricing.rates.paid.settingsHint")]
          : methods.includes("pay_at_property")
            ? [t("pricing.rates.paid.nothing"), t("pricing.rates.paid.nothingHint")]
            : [t("pricing.rates.paid.full"), t("pricing.rates.paid.fullHint")];
  return (
    <Part label={t("pricing.rates.paid.title")} className="lg:min-h-[104px]">
      <p className="text-[14px] font-semibold text-gray-900">{value}</p>
      <p className="text-[12px] text-gray-500">{hint}</p>
    </Part>
  );
}

/** A rate's payment methods: pay at property, bank transfer and PayPal when the hotel can use them, and card once
 * it's ready; a method the rate already takes always shows, so it can be removed. The non-refundable rate is paid in
 * advance, so it can't take pay at property (one it already takes can still be removed). */
function RateMethods({
  rate,
  methods,
  disabled,
  onChange,
}: {
  rate: "flexible" | "non_refundable";
  methods: readonly PricingPaymentMethod[];
  disabled: boolean;
  onChange: (methods: PricingPaymentMethod[]) => void;
}) {
  const { t } = useTranslation();
  const manual = usePricingManualMethods();
  const [error, setError] = useState("");
  const order: PricingPaymentMethod[] =
    rate === "flexible"
      ? ["card", "pay_at_property", "bank_transfer", "paypal"]
      : ["card", "bank_transfer", "paypal", "pay_at_property"];
  const shown = order.filter(
    (method) =>
      methods.includes(method) ||
      method === "pay_at_property" ||
      (method === "card" ? cardReady : manual.includes(method as "bank_transfer" | "paypal")),
  );
  const change = (method: PricingPaymentMethod, on: boolean) => {
    const next = on ? [...methods, method] : methods.filter((value) => value !== method);
    try {
      onChange(next);
      setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.error.paymentMethodRequired"));
    }
  };
  return (
    <Part label={t("pricing.rates.methods")}>
      <fieldset className="space-y-2">
        <legend className="sr-only">{t("pricing.paymentMethods.legend")}</legend>
        {shown.map((method) => {
          const on = methods.includes(method);
          const notOffered = rate === "non_refundable" && method === "pay_at_property";
          const blocked = notOffered && !on;
          return (
            <label
              key={method}
              className={`flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 ${
                blocked
                  ? "border-gray-200 bg-gray-50"
                  : on
                    ? "border-primary-200 bg-primary-50"
                    : "border-gray-200 bg-white"
              }`}
            >
              <input
                type="checkbox"
                aria-label={t(methodNames[method])}
                checked={on}
                disabled={disabled || blocked}
                onChange={(event) => change(method, event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-primary-600 disabled:opacity-50"
              />
              <span className="min-w-0">
                <span
                  className={`block text-[14px] font-medium ${blocked ? "text-gray-400" : "text-gray-900"}`}
                >
                  {t(methodNames[method])}
                </span>
                <span
                  className={`block text-[12px] ${notOffered ? "text-amber-700" : "text-gray-500"}`}
                >
                  {notOffered ? t("pricing.rates.notOffered") : t(methodHints[method])}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {error && (
        <p role="alert" className={ui.errorText}>
          {error}
        </p>
      )}
    </Part>
  );
}
