"use client";

import { useId, type KeyboardEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { PricingPaymentMethod } from "@vayada/domain-booking/replacement-pricing";
import type { PaymentMethodOption } from "@/lib/paymentMethodOptions";

const card = "bg-white rounded-2xl border border-gray-200 p-5 md:p-8";

/** Step 3, "Review & pay" (VAY-2347): who is booking, how they pay (the hotel's ways, each with
 * its own words from `options`), what they agree to for this final price, and the button. */
export default function PaymentStep({
  guestName,
  guestEmail,
  guestPhone = "",
  onChangeDetails,
  method,
  options,
  unavailable = null,
  onMethod,
  showExplanation,
  notice,
  beforeYouBook,
  confirm,
  locked = false,
}: {
  guestName: string;
  guestEmail: string;
  guestPhone?: string;
  onChangeDetails: () => void;
  method: PricingPaymentMethod | "";
  /** The ways to pay the chosen rates take, with their words (see paymentMethodOptions). */
  options: readonly PaymentMethodOption[];
  /** Shown instead of the ways to pay when none is left for the chosen rates (VAY-2309). */
  unavailable?: ReactNode;
  onMethod: (method: PricingPaymentMethod) => void;
  /** The current price is for the chosen way, so its explanation's amounts are right. */
  showExplanation: boolean;
  notice: ReactNode;
  /** What the guest agrees to for this price and the tick (VAY-2347); nothing without a price. */
  beforeYouBook: ReactNode;
  /** The booking's button and what follows it (VAY-2416: the button itself shows in "Your stay"). */
  confirm: ReactNode;
  /** A booking attempt is open: the way to pay and the details can't change until it settles. */
  locked?: boolean;
}) {
  const t = useTranslations("reviewPay");
  const id = useId();
  const methods = options.map((option) => option.method);
  // The options behave like radio buttons: arrow keys move the choice.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step || locked || !methods.length) return;
    event.preventDefault();
    const index = Math.max(0, methods.indexOf(method as PricingPaymentMethod));
    const target = methods[(index + step + methods.length) % methods.length]!;
    onMethod(target);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-method="${target}"]`)?.focus();
  };
  return (
    <div className="space-y-6">
      <section aria-label={t("guest")} className={`${card} flex items-start gap-4`}>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-gray-500">{t("guest")}</p>
          <p id={`${id}-guest`} className="mt-0.5 text-[17px] font-bold text-gray-900">
            {guestName}
          </p>
          <p className="text-[15px] text-gray-600 break-words">
            {[guestEmail, guestPhone].filter(Boolean).join(" · ")}
          </p>
        </div>
        <button
          type="button"
          className="text-[15px] font-semibold text-gray-900 underline disabled:opacity-40"
          disabled={locked}
          aria-describedby={`${id}-guest`}
          title={t("editDetails")}
          onClick={onChangeDetails}
        >
          {t("edit")}
        </button>
      </section>
      {notice}
      <section aria-label={t("howToPay")} className={card}>
        <h2 className="mb-5 text-xl font-bold text-gray-900">{t("howToPay")}</h2>
        {!options.length && unavailable ? (
          unavailable
        ) : (
          <>
            <div
              role="radiogroup"
              aria-label={t("paymentPreference")}
              aria-disabled={locked || undefined}
              className="space-y-3"
              onKeyDown={onKeyDown}
            >
              {options.map((option) => {
                const on = option.method === method;
                return (
                  <button
                    key={option.method}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-method={option.method}
                    // Named by its title; the summary and explanation describe it.
                    aria-labelledby={`${id}-${option.method}`}
                    aria-describedby={`${id}-${option.method}-about`}
                    tabIndex={on || (!method && option.method === methods[0]) ? 0 : -1}
                    disabled={locked}
                    onClick={() => onMethod(option.method)}
                    className={`flex w-full items-start gap-3.5 rounded-[14px] border p-4 text-left transition-colors md:px-5 ${
                      on
                        ? "border-primary-600 bg-primary-50 ring-1 ring-primary-600"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2 bg-white ${
                        on ? "border-primary-600" : "border-gray-400"
                      }`}
                    >
                      {on && <span className="h-2.5 w-2.5 rounded-full bg-primary-600" />}
                    </span>
                    <span className="flex-1">
                      <span
                        id={`${id}-${option.method}`}
                        className="block text-[17px] font-bold text-gray-900"
                      >
                        {option.title}
                      </span>
                      <span id={`${id}-${option.method}-about`} className="block">
                        <span className="block text-[15px] text-gray-600">{option.summary}</span>
                        {on && showExplanation && (
                          <span className="mt-1.5 block text-[15px] text-gray-700">
                            {option.explanation}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </section>
      {beforeYouBook}
      {confirm}
    </div>
  );
}
