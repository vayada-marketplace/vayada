"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRightIcon, MinusIcon, PauseCircleIcon, PlusIcon } from "@heroicons/react/24/outline";
import {
  paidWhenBooking,
  PREPAID_PRICING_PAYMENT_METHODS,
  type PricingPaymentMethod,
} from "@vayada/domain-booking/replacement-pricing";
import {
  pricingOfferOnBookingPage,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import type { PricingRateNotSelling } from "@/services/api/replacementPricingClient";
import { errorText } from "./pricingAmounts";
import {
  usePricingCardReadiness,
  usePricingManualMethods,
  usePricingNotSelling,
} from "./pricingManualMethods";
import {
  cancellationDays,
  cancellationEdits,
  defaultDiscount,
  defaultFreeDays,
  ratePaymentEdits,
  setDiscount,
  setOfferSale,
  switchOption,
  type SimpleRoom,
} from "./simplePricing";
import { money, type OptionTerms } from "./stepPricing";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

type Terms = Readonly<Record<string, OptionTerms | undefined>>;
type Edits = { offerId: string; terms: OptionTerms }[];
type Payment = OptionTerms["payment"];

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
const discountOf = (offer: SimpleRoom["nonRefundable"]) =>
  offer?.price.kind === "linked" && offer.price.adjustment.kind === "percentage"
    ? -offer.price.adjustment.basisPoints
    : null;

/** Step "Rates" (VAY-2282, approved board): how guests can book the room. The Flexible rate is the main option (off:
 * not sold, VAY-2285, its prices still set the Non-refundable rate's) and the Non-refundable rate is the
 * non-refundable switch, side by side, each with its own cancellation, payment at booking and payment methods; one
 * of them stays on.
 * "Paid when booking" is read from the rate's terms (VAY-2205); choosing it comes with card payments and deposits.
 * `children` is the "Other booking options" list (VAY-2283). */
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
            room={room}
            simple={simple}
            terms={terms}
            disabled={disabled}
            onTerms={onTerms}
            onEditOwn={onEditOwn}
            onChange={onChange}
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
  off = false,
  notSelling,
  children,
}: {
  name: string;
  sub: string;
  control: ReactNode;
  off?: boolean;
  /** The published rate isn't selling now (VAY-2304): a badge beside the name and the note first. */
  notSelling?: PricingRateNotSelling;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={name}
      className={`flex min-w-0 flex-col gap-3.5 rounded-xl border border-gray-200 p-4 ${off ? "bg-gray-50" : "bg-white"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-gray-900">
            {name}
            {notSelling && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[12px] font-semibold text-amber-800">
                {t("pricing.notSelling.badge")}
              </span>
            )}
          </h4>
          <p className="text-[12px] text-gray-500">{sub}</p>
        </div>
        {control}
      </div>
      {notSelling && <NotSellingNote rate={notSelling} />}
      {children}
    </section>
  );
}

/** This room's rate in the not-selling list (VAY-2304), if it is there. */
const useNotSelling = (room: PricingConfiguration, offerId: string | undefined) => {
  const rates = usePricingNotSelling();
  return offerId === undefined
    ? undefined
    : rates.find(
        (rate) => rate.roomTypeId === room.roomTypeId.toLowerCase() && rate.offerId === offerId,
      );
};
const notSellingReasons = {
  card_off: "pricing.notSelling.reason.cardOff",
  card_not_chosen: "pricing.notSelling.reason.cardNotChosen",
  card_setup_incomplete: "pricing.notSelling.reason.cardSetupIncomplete",
  deposits_off: "pricing.notSelling.reason.depositsOff",
  pay_at_property_off: "pricing.notSelling.reason.payAtPropertyOff",
  no_payment_method: "pricing.notSelling.reason.noPaymentMethod",
} as const;
const rateFixes = {
  turn_card_on: "pricing.notSelling.fix.turnCardOn",
  choose_card: "pricing.notSelling.fix.chooseCard",
  finish_stripe_setup: "pricing.notSelling.fix.finishStripeSetup",
  allow_pay_at_property: "pricing.notSelling.fix.allowPayAtProperty",
  change_rate_payment: "pricing.notSelling.fix.changeRatePayment",
  turn_pay_at_property_on: "pricing.notSelling.fix.turnPayAtPropertyOn",
} as const;
/** Why a published rate isn't selling and how to fix it (VAY-2304): its prices stay, and it sells again by itself. */
function NotSellingNote({ rate }: { rate: PricingRateNotSelling }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5 rounded-[10px] border border-amber-200 bg-amber-50 px-3.5 py-3">
      <p className="flex items-center gap-2 text-[14px] font-semibold text-amber-800">
        <PauseCircleIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
        {t("pricing.notSelling.title")}
      </p>
      <p className="text-[13px] text-gray-800">{t(notSellingReasons[rate.reason])}</p>
      <ul className="space-y-1">
        {rate.fixes.map((fix) => (
          <li
            key={fix}
            className="flex items-start gap-1.5 text-[13px] font-medium text-primary-700"
          >
            <ArrowRightIcon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t(rateFixes[fix])}
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-gray-500">{t("pricing.notSelling.prices")}</p>
    </div>
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
      <p className={ui.partLabel}>{label}</p>
      {children}
    </div>
  );
}

function FlexibleRate({
  room,
  simple,
  terms,
  disabled,
  onTerms,
  onEditOwn,
  onChange,
}: {
  room: PricingConfiguration;
  simple: SimpleRoom;
  terms: Terms;
  disabled: boolean;
  onTerms: (edits: Edits) => void;
  onEditOwn: () => void;
  onChange: (room: PricingConfiguration) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const notSelling = useNotSelling(room, simple.main.id);
  const on = pricingOfferOnBookingPage(simple.main);
  const otherRate = !!simple.nonRefundable && pricingOfferOnBookingPage(simple.nonRefundable);
  // Off keeps the option and its terms (sale "not_sold"); on again drops the key (VAY-2285).
  const toggle = () => {
    if (disabled) return;
    if (on && !otherRate) return setError(t("pricing.rates.keepOneFlexible"));
    try {
      onChange(setOfferSale(room, simple.main.id, on ? "not_sold" : null));
      setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.rates.keepOne"));
    }
  };
  const current = simple.cancellation;
  const dayText = (count: number) =>
    t(
      count === 1
        ? "pricing.simple.cancellation.days.one"
        : "pricing.simple.cancellation.days.other",
      { count },
    );
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
      off={!on}
      notSelling={notSelling}
      control={
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t("pricing.simple.extras.turnOn", { name: t("pricing.rates.flexible") })}
          disabled={disabled}
          onClick={toggle}
          className={ui.switchTrack(on)}
        >
          <span aria-hidden="true" className="h-[18px] w-[18px] rounded-full bg-white shadow-sm" />
        </button>
      }
    >
      {error && (
        <p role="alert" className={ui.errorText}>
          {error}
        </p>
      )}
      {!on ? (
        <p className="text-[13px] text-gray-500">
          {t(otherRate ? "pricing.rates.flexibleOff" : "pricing.rates.flexibleOffPlain")}
        </p>
      ) : (
        <FlexibleParts
          simple={simple}
          terms={terms}
          disabled={disabled}
          onTerms={onTerms}
          onEditOwn={onEditOwn}
        />
      )}
    </RateCard>
  );
}

/** The Flexible rate's cancellation, payment at booking and payment methods, while it is on. */
function FlexibleParts({
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
  return (
    <>
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
      <RatePayment
        rate="flexible"
        payment={simple.mainTerms.payment}
        disabled={disabled}
        onPayment={(payment) => onTerms(ratePaymentEdits(simple, terms, "flexible", payment))}
      />
    </>
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
  const notSelling = useNotSelling(room, offer?.id);
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
  // With the Flexible rate off this is the rate guests book, so it stays on until Flexible is on again (VAY-2285).
  const last = !!offer && !pricingOfferOnBookingPage(simple.main);
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
    if (disabled || !available || last) return;
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
      notSelling={notSelling}
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
          disabled={disabled || !available || last}
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
            {last && <p className={ui.errorText}>{t("pricing.rates.keepOneNonRefundable")}</p>}
          </Part>
          <RatePayment
            rate="non_refundable"
            payment={terms[offer.id]?.payment ?? mainTerms.payment}
            disabled={disabled}
            onPayment={(payment) =>
              onTerms(ratePaymentEdits(simple, terms, "non_refundable", payment))
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

type Choice = "nothing" | "guest_chooses" | "deposit" | "full_stay";
const choiceNames = {
  nothing: "pricing.rates.paid.nothing",
  guest_chooses: "pricing.rates.paid.guestChooses",
  deposit: "pricing.rates.paid.deposit",
  full_stay: "pricing.rates.paid.full",
} as const;
const choiceHints = {
  nothing: "pricing.rates.paid.nothingHint",
  guest_chooses: "pricing.rates.paid.guestChoosesHint",
  full_stay: "pricing.rates.paid.fullHint",
  not_set: "pricing.rates.paid.settingsHint",
} as const;

/** A rate's "Paid when booking" as a choice (VAY-2305, the CEO's design), with the payment methods that go with it:
 * - nothing: pay at the property only;
 * - guest chooses: the property or a way to pay before arrival, the guest picks (as many hotels take today);
 * - deposit: a percentage by card when booking, the rest at the property; offered only while deposits can be taken;
 * - full stay: ways to pay before arrival only (card once the booking page takes it, bank transfer and PayPal once
 *   ready); greyed out, with why, while there is none.
 * The non-refundable rate is paid in advance: a deposit or the full stay. A method the rate already takes always
 * shows, so it can be removed; terms from before methods were set say so. */
function RatePayment({
  rate,
  payment,
  disabled,
  onPayment,
}: {
  rate: "flexible" | "non_refundable";
  payment: Payment;
  disabled: boolean;
  onPayment: (payment: Payment) => void;
}) {
  const { t } = useTranslation();
  const manual = usePricingManualMethods();
  const readiness = usePricingCardReadiness();
  const card = readiness?.card;
  const [error, setError] = useState("");
  const methods = payment.acceptedMethods ?? [];
  const stored = paidWhenBooking(payment);
  const prepaid = PREPAID_PRICING_PAYMENT_METHODS.filter((method) =>
    method === "card" ? !!card?.ready : manual.includes(method),
  );
  const kept = prepaid.filter((method) => methods.includes(method));
  // The rate's own choice always shows, also one its kind doesn't offer now (old non-refundable terms that let the
  // guest choose, or pay at the property only), so the hotel sees it and can change it.
  const offered: Choice[] =
    rate === "flexible"
      ? ["nothing", "guest_chooses", "deposit", "full_stay"]
      : ["deposit", "full_stay"];
  const choices = [
    ...(stored !== "not_set" && !offered.includes(stored) ? [stored] : []),
    ...offered.filter(
      (choice) =>
        choice === stored ||
        (choice === "deposit"
          ? !!readiness?.deposits.ready
          : choice !== "guest_chooses" || prepaid.length > 0),
    ),
  ];
  const unavailable = (choice: Choice) =>
    choice === "full_stay" && choice !== stored && !prepaid.length;
  const apply = (next: Payment) => {
    if (disabled) return;
    try {
      onPayment(next);
      setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.error.paymentMethodRequired"));
    }
  };
  const deposit = (percent: number): Payment => ({
    kind: "deposit",
    basisPoints: percent * 100,
    balanceDaysBeforeArrival: 0,
    acceptedMethods: ["card"],
  });
  const choose = (choice: Choice) => {
    if (choice === stored || unavailable(choice)) return;
    apply(
      choice === "nothing"
        ? { kind: "full", acceptedMethods: ["pay_at_property"] }
        : choice === "guest_chooses"
          ? {
              kind: "full",
              acceptedMethods: ["pay_at_property", ...(kept.length ? kept : prepaid.slice(0, 1))],
            }
          : choice === "deposit"
            ? deposit(payment.kind === "deposit" ? payment.basisPoints / 100 : 30)
            : { kind: "full", acceptedMethods: [...(kept.length ? kept : prepaid)] },
    );
  };
  const percent = payment.kind === "deposit" ? payment.basisPoints / 100 : 0;
  const hint =
    payment.kind === "deposit"
      ? payment.balanceDaysBeforeArrival === 0
        ? t("pricing.rates.paid.depositHint", { percent })
        : t("pricing.terms.deposit", { percent, days: payment.balanceDaysBeforeArrival })
      : t(choiceHints[stored as Exclude<typeof stored, "deposit">]);
  const order: PricingPaymentMethod[] =
    rate === "flexible"
      ? ["card", "pay_at_property", "bank_transfer", "paypal"]
      : ["card", "bank_transfer", "paypal", "pay_at_property"];
  // Pay at property comes with nothing, guest chooses and (for the rest) a deposit; ways to pay before arrival with
  // guest chooses and full stay; the non-refundable rate says why it doesn't take pay at property.
  const shown = order.filter((method) => {
    if (methods.includes(method)) return true;
    if (method === "pay_at_property") return rate === "non_refundable" || stored !== "full_stay";
    return (
      (stored === "guest_chooses" || stored === "full_stay" || stored === "not_set") &&
      prepaid.includes(method)
    );
  });
  const toggle = (method: PricingPaymentMethod, on: boolean) =>
    apply({
      ...payment,
      acceptedMethods: on ? [...methods, method] : methods.filter((value) => value !== method),
    });
  return (
    <>
      <Part label={t("pricing.rates.paid.title")} className="lg:min-h-[104px]">
        <div
          role="group"
          aria-label={t("pricing.rates.paid.title")}
          className="flex gap-0.5 rounded-lg bg-gray-100 p-[3px]"
        >
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={choice === stored}
              disabled={disabled || unavailable(choice)}
              onClick={() => choose(choice)}
              className={`min-h-8 min-w-0 flex-1 rounded-md px-2 py-1 text-[13px] font-medium leading-4 disabled:cursor-not-allowed ${
                choice === stored
                  ? "bg-white text-gray-900 shadow-sm"
                  : unavailable(choice)
                    ? "text-gray-400"
                    : "text-gray-500"
              }`}
            >
              {t(choiceNames[choice])}
            </button>
          ))}
        </div>
        {stored === "not_set" && (
          <p className="text-[14px] font-semibold text-gray-900">
            {t("pricing.rates.paid.settings")}
          </p>
        )}
        {payment.kind === "deposit" && (
          <div className="flex h-10 w-fit items-center gap-1 rounded-[10px] border border-gray-300 bg-white px-1.5">
            <button
              type="button"
              aria-label={t("pricing.rates.paid.depositLess")}
              disabled={disabled || percent <= 5}
              onClick={() => apply(deposit(Math.max(5, Math.ceil(percent / 5) * 5 - 5)))}
              className="rounded-md p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
            >
              <MinusIcon aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
            <output
              aria-live="polite"
              className="w-12 text-center text-[14px] font-semibold text-gray-900"
            >
              {percent}%
            </output>
            <button
              type="button"
              aria-label={t("pricing.rates.paid.depositMore")}
              disabled={disabled || percent >= 95}
              onClick={() => apply(deposit(Math.min(95, Math.floor(percent / 5) * 5 + 5)))}
              className="rounded-md p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
            >
              <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <p className="text-[12px] text-gray-500">{hint}</p>
        {choices.some(unavailable) && (
          <p className="text-[12px] text-gray-500">{t("pricing.rates.paid.fullNeedsPrepaid")}</p>
        )}
      </Part>
      <Part label={t("pricing.rates.methods")}>
        <fieldset className="space-y-2">
          <legend className="sr-only">{t("pricing.paymentMethods.legend")}</legend>
          {shown.map((method) => {
            const taken = methods.includes(method);
            const rest = stored === "deposit" && method === "pay_at_property";
            // The Non-refundable rate says it doesn't take pay at property, also while old terms still do (then the
            // hotel can untick it); only an unticked one is greyed out.
            const notOffered = rate === "non_refundable" && method === "pay_at_property" && !rest;
            const blocked = notOffered && !taken;
            // The choice fixes these: a deposit's card and rest, and the Flexible rate's pay at property with
            // "nothing" or "guest chooses". The Non-refundable rate's old pay at property can always be removed.
            const fixed =
              rest ||
              (stored === "deposit" && method === "card") ||
              (rate === "flexible" &&
                method === "pay_at_property" &&
                taken &&
                (stored === "nothing" || stored === "guest_chooses"));
            const on = taken || rest;
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
                  disabled={disabled || blocked || fixed}
                  onChange={(event) => toggle(method, event.target.checked)}
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
                    {notOffered
                      ? t("pricing.rates.notOffered")
                      : rest
                        ? t("pricing.rates.method.depositRest")
                        : stored === "deposit" && method === "card"
                          ? t("pricing.rates.method.depositCard")
                          : method === "card" && card?.charge === "at_booking"
                            ? t("pricing.rates.method.cardAtBooking")
                            : t(methodHints[method])}
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
    </>
  );
}
