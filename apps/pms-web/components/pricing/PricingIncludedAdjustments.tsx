"use client";
import { useState } from "react";
import {
  parsePricingConfiguration,
  pricingAmountStep,
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import {
  IncludedPricing,
  includedPrice,
  includedInput,
  type IncludedInput,
} from "./IncludedPricing";
import { useTranslation } from "@/lib/i18n";
import { decimalAmount, errorText, PricingError } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
export function changeIncludedAdjustments(
  room: PricingConfiguration,
  offerId: string,
  entry: IncludedInput,
  baseValue: string,
): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (
    !offer ||
    offer.price.kind !== "independent" ||
    offer.price.calendar.base?.mode !== "included_guests"
  )
    throw new PricingError("pricing.includedAdjustments.errorOffer");
  const scale = pricingCurrencyScale(room.currency);
  if (scale === null) throw new PricingError("pricing.includedAdjustments.errorCurrency");
  const base = includedPrice(
    entry,
    baseValue,
    room.capacity.adults,
    scale,
    pricingAmountStep(room.currency),
  );
  const price = { ...offer.price, calendar: { ...offer.price.calendar, base } };
  const result = parsePricingConfiguration({
    ...room,
    offers: room.offers.map((value) => (value.id === offerId ? { ...value, price } : value)),
  });
  if (!result) throw new PricingError("pricing.includedAdjustments.errorInvalid");
  return result;
}

export function PricingIncludedAdjustments({
  room,
  offer,
  label,
  baseValue,
  disabled,
  blocked,
  onChange,
  onPending,
}: {
  room: PricingConfiguration;
  offer: Offer;
  label: string;
  baseValue?: string;
  disabled: boolean;
  blocked: boolean;
  onChange: (room: PricingConfiguration) => void;
  onPending: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const [entry, setEntry] = useState<IncludedInput | null>(null),
    [error, setError] = useState("");
  if (offer.price.kind !== "independent" || offer.price.calendar.base?.mode !== "included_guests")
    return null;
  const base = offer.price.calendar.base,
    scale = pricingCurrencyScale(room.currency)!;
  const amount = baseValue ?? decimalAmount(base.baseMinor, scale);
  const cancel = () => {
    setEntry(null);
    setError("");
    onPending(false);
  };
  return (
    <details className="sm:col-span-2 text-sm">
      <summary className="cursor-pointer">
        {t("pricing.includedAdjustments.summary", { label })}
      </summary>
      <p className="mt-2">
        {t("pricing.includedAdjustments.intro", {
          count: base.baseGuests,
          adults: t(base.baseGuests === 1 ? "pricing.adults.one" : "pricing.adults.other", {
            count: base.baseGuests,
          }),
        })}
      </p>
      {!entry ? (
        <button
          type="button"
          className="mt-3 rounded border px-3 py-2 disabled:opacity-50"
          disabled={disabled || blocked}
          onClick={() => {
            if (disabled || blocked) return;
            setEntry(includedInput(base, scale));
            setError("");
            onPending(true);
          }}
        >
          {t("pricing.includedAdjustments.edit")}
        </button>
      ) : (
        <div className="mt-3 space-y-3">
          <p>{t("pricing.includedAdjustments.baseUsed", { amount, currency: room.currency })}</p>
          <IncludedPricing
            value={entry}
            capacity={room.capacity.adults}
            disabled={disabled}
            onChange={(value) => {
              setEntry(value);
              setError("");
            }}
          />
          <div className="flex gap-3">
            <button
              type="button"
              className="rounded border px-3 py-2 disabled:opacity-50"
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                try {
                  onChange(changeIncludedAdjustments(room, offer.id, entry, amount));
                  cancel();
                } catch (cause) {
                  setError(errorText(cause, t, "pricing.includedAdjustments.changeFailed"));
                }
              }}
            >
              {t("pricing.includedAdjustments.apply")}
            </button>
            <button
              type="button"
              className="rounded border px-3 py-2 disabled:opacity-50"
              disabled={disabled}
              onClick={cancel}
            >
              {t("pricing.includedAdjustments.cancel")}
            </button>
          </div>
          <p>{t("pricing.applyOrCancelBeforeOtherRules")}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-red-700">
          {error}
        </p>
      )}
    </details>
  );
}
