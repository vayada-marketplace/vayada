"use client";

import { useTranslation } from "@/lib/i18n";
import { cancellationDays, defaultFreeDays, type SimpleCancellation } from "./simplePricing";
import * as ui from "./pricingStyles";

/** Free cancellation until a number of days before arrival, or non-refundable: the first-price form's control (step
 * "Rates" has its own, VAY-2282). */
export function CancellationChoice({
  value,
  disabled,
  noNonRefundable = false,
  onChange,
}: {
  value: Exclude<SimpleCancellation, { kind: "own" }>;
  disabled: boolean;
  /** Guests can only pay at the property, so non-refundable (paid in advance) can't be chosen (VAY-2280). */
  noNonRefundable?: boolean;
  onChange: (choice: Exclude<SimpleCancellation, { kind: "own" }>) => void;
}) {
  const { t } = useTranslation();
  const choose = (choice: Exclude<SimpleCancellation, { kind: "own" }>) => {
    if (!disabled) onChange(choice);
  };
  const days = value.kind === "free" ? value.days : defaultFreeDays;
  const choices = Array.from(new Set<number>([...cancellationDays, days])).sort((a, b) => a - b);
  return (
    <>
      <div
        role="group"
        aria-label={t("pricing.simple.cancellation.title")}
        className="flex flex-wrap gap-2"
      >
        <button
          type="button"
          aria-pressed={value.kind === "free"}
          disabled={disabled}
          onClick={() => choose({ kind: "free", days })}
          className={ui.chip(value.kind === "free")}
        >
          {t("pricing.simple.cancellation.free")}
        </button>
        <button
          type="button"
          aria-pressed={value.kind === "non_refundable"}
          disabled={disabled || (noNonRefundable && value.kind !== "non_refundable")}
          onClick={() => choose({ kind: "non_refundable" })}
          className={ui.chip(value.kind === "non_refundable")}
        >
          {t("pricing.simple.cancellation.nonRefundable")}
        </button>
      </div>
      {noNonRefundable && (
        <p className="text-[13px] text-gray-500">{t("pricing.error.nonRefundableNeedsAdvance")}</p>
      )}
      {value.kind === "free" && (
        <label className="flex flex-wrap items-center gap-2.5 text-[15px] text-gray-700">
          {t("pricing.simple.cancellation.until")}
          <select
            aria-label={t("pricing.simple.cancellation.daysLabel")}
            disabled={disabled}
            value={days}
            onChange={(event) => choose({ kind: "free", days: Number(event.target.value) })}
            className="h-10 rounded-[10px] border border-gray-300 bg-white px-3 text-[15px] font-medium text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {choices.map((count) => (
              <option key={count} value={count}>
                {t(
                  count === 1
                    ? "pricing.simple.cancellation.days.one"
                    : "pricing.simple.cancellation.days.other",
                  { count },
                )}
              </option>
            ))}
          </select>
          {t("pricing.simple.cancellation.before")}
        </label>
      )}
    </>
  );
}
