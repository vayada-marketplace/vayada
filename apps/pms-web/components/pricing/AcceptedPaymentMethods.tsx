"use client";

export type PaymentMethod = "card" | "pay_at_property";

const options = [
  { value: "card", label: "Card online" },
  { value: "pay_at_property", label: "Pay at property" },
] as const;

export function AcceptedPaymentMethods({
  methods,
  disabled,
  onChange,
}: {
  methods: readonly PaymentMethod[];
  disabled: boolean;
  onChange(methods: PaymentMethod[]): void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Accepted payment methods</legend>
      {options.map(({ value, label }) => (
        <label key={value} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label={label}
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
          {label}
        </label>
      ))}
      <p className="text-xs text-gray-600">
        Only payment methods ready in Payment settings can be used at checkout.
      </p>
    </fieldset>
  );
}
