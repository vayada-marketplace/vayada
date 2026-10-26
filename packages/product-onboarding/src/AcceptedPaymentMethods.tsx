"use client";

import type { PricingPaymentMethod } from "@vayada/domain-booking/replacement-pricing";
import type { Translate } from "./firstPricingSetupMessages";
import { defaultPricingFormLook, type PricingFormLook } from "./pricingFormLook";

export type PaymentMethod = PricingPaymentMethod;
export type ManualPaymentMethod = "bank_transfer" | "paypal";

const options = [
  { value: "card", labelKey: "pricing.paymentMethods.card" },
  { value: "pay_at_property", labelKey: "pricing.paymentMethods.payAtProperty" },
  // Paid to the hotel directly; the hotel confirms each payment (VAY-2139).
  { value: "bank_transfer", labelKey: "pricing.paymentMethods.bankTransfer" },
  { value: "paypal", labelKey: "pricing.paymentMethods.paypal" },
] as const;

/** Non-refundable stays are paid in advance (VAY-2280): they never accept pay at property, and the server refuses
 * terms that would. */
export const paidInAdvance = (methods: readonly PaymentMethod[]): PaymentMethod[] =>
  methods.filter((method) => method !== "pay_at_property");

export function AcceptedPaymentMethods({
  methods,
  disabled,
  onChange,
  t,
  look = defaultPricingFormLook,
  manualMethods = [],
  nonRefundable = false,
}: {
  methods: readonly PaymentMethod[];
  disabled: boolean;
  onChange(methods: PaymentMethod[]): void;
  t: Translate;
  look?: PricingFormLook;
  /** Bank transfer and PayPal the hotel can use now (VAY-2139). A chosen one stays visible so
   * it can be removed; without them the list is card and pay at property, as before. */
  manualMethods?: readonly ManualPaymentMethod[];
  /** The rate is non-refundable: pay at property shows as not offered and can only be removed (VAY-2280). */
  nonRefundable?: boolean;
}) {
  const shown = options.filter(
    ({ value }) =>
      (value !== "bank_transfer" && value !== "paypal") ||
      manualMethods.includes(value) ||
      methods.includes(value),
  );
  return (
    <fieldset className="space-y-2">
      <legend className={look.legend}>{t("pricing.paymentMethods.legend")}</legend>
      {shown.map(({ value, labelKey }) => {
        const notOffered = nonRefundable && value === "pay_at_property";
        return (
          <label key={value} className={look.check}>
            <input
              type="checkbox"
              aria-label={t(labelKey)}
              disabled={disabled || (notOffered && !methods.includes(value))}
              checked={methods.includes(value)}
              onChange={(event) =>
                onChange([
                  ...shown
                    .filter((option) =>
                      option.value === value
                        ? event.target.checked
                        : methods.includes(option.value),
                    )
                    .map((option) => option.value),
                  // Keep methods this list does not show (VAY-2139).
                  ...methods.filter((method) => !shown.some((option) => option.value === method)),
                ])
              }
            />
            {t(labelKey)}
            {notOffered && (
              <span className={look.smallHint}> · {t("pricing.paymentMethods.notOffered")}</span>
            )}
          </label>
        );
      })}
      <p className={look.smallHint}>{t("pricing.paymentMethods.hint")}</p>
    </fieldset>
  );
}
