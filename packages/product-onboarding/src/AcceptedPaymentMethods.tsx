"use client";

import type { PricingPaymentMethod } from "@vayada/domain-booking/replacement-pricing";
import type { Translate } from "./firstPricingSetupMessages";
import { defaultPricingFormLook, type PricingFormLook } from "./pricingFormLook";

export type PaymentMethod = PricingPaymentMethod;

const options = [
  { value: "card", labelKey: "pricing.paymentMethods.card" },
  { value: "pay_at_property", labelKey: "pricing.paymentMethods.payAtProperty" },
  // Paid to the hotel directly; the hotel confirms each payment (VAY-2139).
  { value: "bank_transfer", labelKey: "pricing.paymentMethods.bankTransfer" },
  { value: "paypal", labelKey: "pricing.paymentMethods.paypal" },
] as const;

export function AcceptedPaymentMethods({
  methods,
  disabled,
  onChange,
  t,
  look = defaultPricingFormLook,
}: {
  methods: readonly PaymentMethod[];
  disabled: boolean;
  onChange(methods: PaymentMethod[]): void;
  t: Translate;
  look?: PricingFormLook;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className={look.legend}>{t("pricing.paymentMethods.legend")}</legend>
      {options.map(({ value, labelKey }) => (
        <label key={value} className={look.check}>
          <input
            type="checkbox"
            aria-label={t(labelKey)}
            disabled={disabled}
            checked={methods.includes(value)}
            onChange={(event) =>
              onChange([
                ...options
                  .filter((option) =>
                    option.value === value ? event.target.checked : methods.includes(option.value),
                  )
                  .map((option) => option.value),
                // Keep methods this list does not show, such as bank transfer (VAY-2139).
                ...methods.filter((method) => !options.some((option) => option.value === method)),
              ])
            }
          />
          {t(labelKey)}
        </label>
      ))}
      <p className={look.smallHint}>{t("pricing.paymentMethods.hint")}</p>
    </fieldset>
  );
}
