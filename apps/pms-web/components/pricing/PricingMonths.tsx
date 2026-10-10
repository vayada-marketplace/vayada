"use client";
import { useState } from "react";
import {
  parsePricingConfiguration,
  pricingAmountStep,
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { baseAmounts, decimalAmount, errorText, PricingError } from "./pricingAmounts";

import { recurringTemplate, recurringPrice, recurringAdjustments } from "./recurringPricingInputs";

import {
  IncludedPricing,
  includedInput,
  includedPrice,
  type IncludedInput,
} from "./IncludedPricing";

type Offer = PricingConfiguration["offers"][number];
export function changeMonthPrice(
  room: PricingConfiguration,
  offerId: string,
  month: string,
  values: string[] | null,
  replace = false,
  included: IncludedInput | null = null,
): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "independent")
    throw new PricingError("pricing.months.errorIndependent");
  if (!/^(?:[1-9]|1[0-2])$/.test(month)) throw new PricingError("pricing.months.errorMonth");
  const calendar = offer.price.calendar,
    existing = calendar.months.find((entry) => entry.month === Number(month)),
    exists = !!existing;
  if (replace && (!existing || !values)) throw new PricingError("pricing.months.errorEditMissing");
  if (values && exists && !replace) throw new PricingError("pricing.months.errorExists");
  if (!values && !exists) throw new PricingError("pricing.months.errorNothingToClear");
  let next = calendar.months.filter((entry) => entry.month !== Number(month));
  if (values) {
    if (
      included &&
      ((replace ? existing?.price : recurringTemplate(offer))?.mode !== "included_guests" ||
        values.length !== 1)
    )
      throw new PricingError("pricing.months.errorIncludedRequired");
    const price = included
      ? includedPrice(
          included,
          values[0],
          room.capacity.adults,
          pricingCurrencyScale(room.currency)!,
          pricingAmountStep(room.currency),
        )
      : recurringPrice(
          offer,
          values,
          room.currency,
          replace ? existing!.price : recurringTemplate(offer),
        );
    next = [...next, { month: Number(month), price }].sort((a, b) => a.month - b.month);
  }
  const price = { ...offer.price, calendar: { ...calendar, months: next } };
  const result = parsePricingConfiguration({
    ...room,
    offers: room.offers.map((value) => (value.id === offerId ? { ...offer, price } : value)),
  });
  if (!result) throw new PricingError("pricing.months.errorInvalid");
  return result;
}

export function PricingMonths({
  room,
  offer,
  label,
  disabled,
  onChange,
  onPending,
}: {
  room: PricingConfiguration;
  offer: Offer;
  label: string;
  disabled: boolean;
  onChange: (room: PricingConfiguration) => void;
  onPending: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const [included, setIncluded] = useState<IncludedInput | null>(null);
  const [month, setMonth] = useState(""),
    [values, setValues] = useState<string[]>([]),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false);
  if (offer.price.kind !== "independent") return null;
  const template = editing
      ? offer.price.calendar.months.find((entry) => entry.month === Number(month))?.price
      : recurringTemplate(offer),
    scale = pricingCurrencyScale(room.currency)!;
  const activeIncluded =
    included ??
    (!editing && template?.mode === "included_guests" ? includedInput(template, scale) : null);
  const pending = !!included || !!month || values.some(Boolean);
  const reset = () => {
    setMonth("");
    setValues([]);
    setIncluded(null);
    setEditing(false);
    setError("");
    onPending(false);
  };
  const apply = (selected: string, amounts: string[] | null) => {
    if (disabled || (!amounts && pending)) return;
    try {
      onChange(
        changeMonthPrice(room, offer.id, selected, amounts, editing, amounts ? included : null),
      );
      if (amounts) reset();
      else setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.months.changeFailed"));
    }
  };

  return (
    <details className="sm:col-span-2 text-sm">
      <summary className="cursor-pointer">{t("pricing.months.summary", { label })}</summary>
      <p className="mt-2 text-gray-600">{t("pricing.months.intro")}</p>
      <ul className="my-3 space-y-2">
        {offer.price.calendar.months.map((entry) => (
          <li key={entry.month} className="flex flex-wrap items-center gap-3">
            <span>
              {t(`pricing.month.${entry.month}`)}:{" "}
              {baseAmounts(entry.price, t)
                .map(([name, minor]) => `${name} ${decimalAmount(minor, scale)} ${room.currency}`)
                .join("; ")}
              .{recurringAdjustments(entry.price, room.currency, scale, t)}
            </span>
            <button
              type="button"
              className="rounded border px-3 py-1 disabled:opacity-50"
              disabled={disabled || pending}
              aria-label={t("pricing.months.editAria", {
                month: t(`pricing.month.${entry.month}`),
                label,
              })}
              onClick={() => {
                if (disabled || pending) return;
                setIncluded(
                  entry.price.mode === "included_guests" ? includedInput(entry.price, scale) : null,
                );
                setEditing(true);
                setMonth(String(entry.month));
                setValues(baseAmounts(entry.price).map(([, minor]) => decimalAmount(minor, scale)));
                setError("");
                onPending(true);
              }}
            >
              {t("pricing.months.edit")}
            </button>
            <button
              type="button"
              className="rounded border px-3 py-1 disabled:opacity-50"
              disabled={disabled || pending}
              aria-label={t("pricing.months.clearAria", {
                month: t(`pricing.month.${entry.month}`),
                label,
              })}
              onClick={() => apply(String(entry.month), null)}
            >
              {t("pricing.months.clear")}
            </button>
          </li>
        ))}
      </ul>
      {!template ? (
        <p>{t("pricing.months.noTemplate")}</p>
      ) : (
        <>
          <p className="mb-3">
            {editing ? t("pricing.months.editHint") : t("pricing.months.modeHint")}
            {recurringAdjustments(template, room.currency, scale, t)}
            {!editing &&
              template.mode === "included_guests" &&
              ` ${t("pricing.months.includedHint")}`}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label>
              {t("pricing.months.month")}
              <select
                aria-label={t("pricing.months.monthAria", { label })}
                className="mt-1 block rounded border px-3 py-2"
                disabled={disabled || editing}
                value={month}
                onChange={(event) => {
                  if (disabled || editing) return;
                  setMonth(event.target.value);
                  setError("");
                  onPending(!!included || !!event.target.value || values.some(Boolean));
                }}
              >
                <option value="">{t("pricing.choose")}</option>
                {Array.from({ length: 12 }, (_, index) => (
                  <option key={index} value={index + 1}>
                    {t(`pricing.month.${index + 1}`)}
                  </option>
                ))}
              </select>
            </label>
            {baseAmounts(
              activeIncluded && template.mode === "included_guests"
                ? { ...template, baseGuests: Number(activeIncluded.adults) || template.baseGuests }
                : template,
              t,
            ).map(([name], index) => (
              <label key={index}>
                {name} ({room.currency})
                <input
                  aria-label={t("pricing.months.amountAria", { name, label })}
                  className="mt-1 block w-36 rounded border px-3 py-2"
                  disabled={disabled}
                  value={values[index] ?? ""}
                  onChange={(event) => {
                    const next = Array.from({ length: baseAmounts(template).length }, (_, i) =>
                      i === index ? event.target.value : (values[i] ?? ""),
                    );
                    setValues(next);
                    setError("");
                    onPending(!!included || !!month || next.some(Boolean));
                  }}
                />
              </label>
            ))}
            {activeIncluded && (
              <div className="w-full">
                <p>{t("pricing.months.includedBaseHint")}</p>
                <IncludedPricing
                  value={activeIncluded}
                  label={t("pricing.months.includedLabel", { label })}
                  capacity={room.capacity.adults}
                  disabled={disabled}
                  onChange={(next) => {
                    if (disabled) return;
                    setIncluded(next);
                    setError("");
                    onPending(true);
                  }}
                />
              </div>
            )}
            <button
              type="button"
              className="rounded border px-3 py-2 disabled:opacity-50"
              disabled={disabled}
              onClick={() => apply(month, values)}
            >
              {editing ? t("pricing.months.apply") : t("pricing.months.add")}
            </button>
          </div>
        </>
      )}
      {pending && (
        <>
          <button
            type="button"
            className="mt-3 rounded border px-3 py-2 disabled:opacity-50"
            disabled={disabled}
            onClick={reset}
          >
            {t("pricing.months.cancel")}
          </button>
          <p className="mt-2">
            {editing ? t("pricing.months.pendingApply") : t("pricing.months.pendingAdd")}
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-red-700">
          {error}
        </p>
      )}
    </details>
  );
}
