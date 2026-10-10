"use client";

import type { Translate } from "./firstPricingSetupMessages";

export type PaymentMethod = "card" | "pay_at_property";

const options = [
  { value: "card", labelKey: "pricing.paymentMethods.card" },
  { value: "pay_at_property", labelKey: "pricing.paymentMethods.payAtProperty" },
] as const;

export function AcceptedPaymentMethods({
  methods,
  disabled,
  onChange,
  t,
}: {
  methods: readonly PaymentMethod[];
  disabled: boolean;
  onChange(methods: PaymentMethod[]): void;
  t: Translate;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t("pricing.paymentMethods.legend")}</legend>
      {options.map(({ value, labelKey }) => (
        <label key={value} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label={t(labelKey)}
            disabled={disabled}
            checked={methods.includes(value)}
            onChange={(event) =>
              onChange(
                options
                  .filter((option) =>
                    option.value === value ? event.target.checked : methods.includes(option.value),
                  )
                  .map((option) => option.value),
              )
            }
          />
          {t(labelKey)}
        </label>
      ))}
      <p className="text-xs text-gray-600">{t("pricing.paymentMethods.hint")}</p>
    </fieldset>
  );
}
