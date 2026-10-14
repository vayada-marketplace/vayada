"use client";

import { useState, type ReactNode } from "react";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { AcceptedPaymentMethods as SharedAcceptedPaymentMethods } from "@vayada/product-onboarding/AcceptedPaymentMethods";
import { useTranslation } from "@/lib/i18n";
import { errorText, type Translate } from "./pricingAmounts";
import { usePricingManualMethods } from "./pricingManualMethods";
import {
  hasKeptSettings,
  onePriceAgain,
  paymentEdits,
  pricePerAdultCount,
  type SimpleRoom,
} from "./simplePricing";
import {
  adjustmentText,
  childrenSummary,
  mainOffer,
  money,
  moreOptionsSummary,
  type OptionTerms,
} from "./stepPricing";
import * as ui from "./pricingStyles";

type Room = PricingConfiguration;

/** One group inside the open More options row. */
export function MoreGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2.5 border-gray-100 py-4 [&:not(:first-child)]:border-t">
      <div className="space-y-0.5">
        <h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>
        {hint && <p className={ui.stepHint}>{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** "Guests pay at the hotel or by card": the accepted methods in words. */
export function paymentText(methods: readonly string[], t: Translate) {
  const words = methods.map((method) => t(`pricing.simple.pay.${method}`));
  return words.length < 2
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} ${t("pricing.simple.pay.or")} ${words.at(-1)}`;
}

/** The closed More options row's line: how guests pay, the minimum stay, children, and anything else it holds, so no
 * setting hides behind it. */
export function simpleSummary(room: Room, simple: SimpleRoom | null, t: Translate) {
  const main = mainOffer(room);
  const nights = main.restrictions.kind === "own" ? main.restrictions.rules.minArrivalNights : 1;
  const payment = simple?.mainTerms.payment;
  const methods = payment?.acceptedMethods ?? [];
  const others = simple?.others.length ?? 0;
  return [
    ...(methods.length
      ? [t("pricing.simple.summary.payment", { methods: paymentText(methods, t) })]
      : []),
    ...(payment?.kind === "deposit"
      ? [t("pricing.simple.summary.deposit", { percent: payment.basisPoints / 100 })]
      : []),
    nights > 1
      ? t("pricing.simple.summary.minimum", { count: nights })
      : t("pricing.simple.summary.noMinimum"),
    ...(room.capacity.children > 0
      ? [t("pricing.simple.summary.children", { summary: childrenSummary(room, t) })]
      : []),
    ...(others
      ? [
          t(
            others === 1
              ? "pricing.simple.summary.options.one"
              : "pricing.simple.summary.options.other",
            { count: others },
          ),
        ]
      : []),
    ...(moreOptionsSummary(room, t)?.split(" · ") ?? []),
  ].join(" · ");
}
/** Whether the card's top leaves settings out (see `hasKeptSettings`), counting a deposit and a closed or stopped
 * main option too: the card then says they are kept. */
export function keptSettings(room: Room, simple: SimpleRoom | null) {
  if (!simple) return false;
  const rules = simple.main.restrictions.kind === "own" ? simple.main.restrictions.rules : null;
  return (
    hasKeptSettings(room, simple) ||
    simple.mainTerms.payment.kind === "deposit" ||
    !!(rules && (rules.closedToArrival || rules.closedToDeparture || rules.stopSell))
  );
}

/** How guests pay for the card's price and its switches (the main option's accepted methods, copied to both). */
export function SimplePayment({
  simple,
  terms,
  failed,
  disabled,
  onTerms,
}: {
  simple: SimpleRoom | null;
  terms: Readonly<Record<string, OptionTerms | undefined>>;
  /** The options' terms couldn't be loaded (the cancellation offers the retry). */
  failed: boolean;
  disabled: boolean;
  onTerms: (edits: ReturnType<typeof paymentEdits>) => void;
}) {
  const { t } = useTranslation();
  const manualMethods = usePricingManualMethods();
  const [error, setError] = useState("");
  if (!simple)
    return (
      <p className={ui.stepHint}>
        {t(failed ? "pricing.simple.more.paymentFailed" : "pricing.simple.cancellation.loading")}
      </p>
    );
  const { payment } = simple.mainTerms;
  return (
    <>
      <SharedAcceptedPaymentMethods
        methods={simple.mainTerms.payment.acceptedMethods ?? []}
        manualMethods={manualMethods}
        disabled={disabled}
        onChange={(methods) => {
          try {
            onTerms(paymentEdits(simple, terms, methods));
            setError("");
          } catch (cause) {
            setError(errorText(cause, t, "pricing.error.paymentMethodRequired"));
          }
        }}
        t={t}
        look={{ ...ui.formLook, legend: "sr-only" }}
      />
      {payment.kind === "deposit" && (
        <p className={ui.stepHint}>
          {t("pricing.terms.deposit", {
            percent: payment.basisPoints / 100,
            days: payment.balanceDaysBeforeArrival,
          })}
        </p>
      )}
      {error && (
        <p role="alert" className={ui.errorText}>
          {error}
        </p>
      )}
    </>
  );
}

/** Price by number of guests: one price for the room can become a price per adult count (no price changes until the
 * counts' own prices are typed), and back when every count costs the same. Other ways of pricing by guests are named
 * here and edited in the price section and the option's window. */
export function SimpleGuests({
  room,
  disabled,
  onChange,
}: {
  room: Room;
  disabled: boolean;
  onChange: (room: Room) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const main = mainOffer(room);
  const base = main.price.kind === "independent" ? main.price.calendar.base : null;
  if (!base || room.capacity.adults < 2) return null;
  const back = base.mode === "occupancy" ? onePriceAgain(room) : null;
  const now =
    base.mode === "flat"
      ? t("pricing.simple.more.guestsSame")
      : t("pricing.simple.more.guestsNow", {
          summary:
            base.mode === "occupancy"
              ? base.amountsMinor
                  .map(
                    (amount, index) =>
                      `${t(index ? "pricing.adults.other" : "pricing.adults.one", { count: index + 1 })} ${money(amount, room.currency)}`,
                  )
                  .join(" · ")
              : base.mode === "per_person"
                ? `${money(base.unitMinor, room.currency)} ${t("pricing.steps.price.perAdultNight")}`
                : base.adjustments
                    .map((adjustment, index) =>
                      index + 1 === base.baseGuests
                        ? `${t(index ? "pricing.adults.other" : "pricing.adults.one", { count: index + 1 })} ${money(base.baseMinor, room.currency)}`
                        : `${t(index ? "pricing.adults.other" : "pricing.adults.one", { count: index + 1 })} ${adjustmentText(adjustment, room.currency)}`,
                    )
                    .join(" · "),
        });
  const apply = (next: () => Room | null) => {
    if (disabled) return;
    try {
      const value = next();
      if (value) onChange(value);
      setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.setup.errorConfiguration"));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <p className="grow text-[14px] text-gray-600">{now}</p>
      {base.mode === "flat" && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => apply(() => pricePerAdultCount(room))}
          className={ui.stepLink}
        >
          {t("pricing.simple.more.guestsPerCount")}
        </button>
      )}
      {back && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => apply(() => onePriceAgain(room))}
          className={ui.stepLink}
        >
          {t("pricing.simple.more.guestsOne")}
        </button>
      )}
      {error && (
        <p role="alert" className={`w-full ${ui.errorText}`}>
          {error}
        </p>
      )}
    </div>
  );
}
