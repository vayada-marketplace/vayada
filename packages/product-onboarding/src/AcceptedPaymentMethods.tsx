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

export function AcceptedPaymentMethods({
  methods,
  disabled,
  onChange,
  t,
  look = defaultPricingFormLook,
  manualMethods = [],
}: {
  methods: readonly PaymentMethod[];
  disabled: boolean;
  onChange(methods: PaymentMethod[]): void;
  t: Translate;
  look?: PricingFormLook;
  /** Bank transfer and PayPal the hotel can use now (VAY-2139). A chosen one stays visible so
   * it can be removed; without them the list is card and pay at property, as before. */
  manualMethods?: readonly ManualPaymentMethod[];
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
      {shown.map(({ value, labelKey }) => (
        <label key={value} className={look.check}>
          <input
            type="checkbox"
            aria-label={t(labelKey)}
            disabled={disabled}
            checked={methods.includes(value)}
            onChange={(event) =>
              onChange([
                ...shown
                  .filter((option) =>
                    option.value === value ? event.target.checked : methods.includes(option.value),
                  )
                  .map((option) => option.value),
                // Keep methods this list does not show (VAY-2139).
                ...methods.filter((method) => !shown.some((option) => option.value === method)),
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
