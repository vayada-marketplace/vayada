"use client";
import { useState } from "react";
import {
  parsePricingConfiguration,
  pricingAmountStep,
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { decimalAmount, errorText, parseMinorInput, PricingError } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
export function changeMealCharges(
  room: PricingConfiguration,
  offerId: string,
  amounts: readonly string[],
): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.meal.kind === "room_only")
    throw new PricingError("pricing.mealCharges.errorOffer");
  const charge = offer.meal.charge,
    scale = pricingCurrencyScale(room.currency);
  if (scale === null) throw new PricingError("pricing.error.currencyUnavailable");
  if (amounts.length !== (charge.kind === "room" ? 1 : room.children.bands.length + 1))
    throw new PricingError("pricing.mealCharges.errorAmounts");
  const values = Array.from(amounts, (amount) =>
    parseMinorInput(amount, scale, true, pricingAmountStep(room.currency)),
  );
  const next =
    charge.kind === "room"
      ? { ...charge, amountMinor: values[0] }
      : { ...charge, adultMinor: values[0], childBandAmountsMinor: values.slice(1) };
  const result = parsePricingConfiguration({
    ...room,
    offers: room.offers.map((value) =>
      value.id === offerId ? { ...value, meal: { ...value.meal, charge: next } } : value,
    ),
  });
  if (!result) throw new PricingError("pricing.error.mealConfigInvalid");
  return result;
}

export function PricingMealCharges({
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
  const [entry, setEntry] = useState<string[] | null>(null),
    [error, setError] = useState("");
  const { t } = useTranslation();
  if (offer.meal.kind === "room_only")
    return <p className="sm:col-span-2 text-sm">{t("pricing.mealCharges.roomOnly", { label })}</p>;
  const charge = offer.meal.charge,
    scale = pricingCurrencyScale(room.currency)!;
  const values =
    charge.kind === "room"
      ? [charge.amountMinor]
      : [charge.adultMinor, ...charge.childBandAmountsMinor];
  const labels =
    charge.kind === "room"
      ? [t("pricing.perRoom")]
      : [
          t("pricing.perAdult"),
          ...room.children.bands.map((band) =>
            t("pricing.perChildAges", { from: band.fromAge, through: band.throughAge }),
          ),
        ];
  const cancel = () => {
    setEntry(null);
    setError("");
    onPending(false);
  };
  return (
    <details className="sm:col-span-2 text-sm">
      <summary className="cursor-pointer">{t("pricing.mealCharges.title", { label })}</summary>
      <p className="mt-2">
        {t(
          charge.kind === "room"
            ? "pricing.mealCharges.perRoomBasis"
            : "pricing.mealCharges.perPersonBasis",
          { meal: t(`pricing.meal.${offer.meal.kind}`) },
        )}
      </p>
      <p className="mt-2 text-gray-600">
        {t("pricing.mealCharges.description")}{" "}
        {charge.kind === "person" && (
          <>{t("pricing.mealCharges.childAges", { age: room.children.adultFromAge })} </>
        )}{" "}
        {t("pricing.mealCharges.enterZero")}
      </p>
      <ul className="mt-3 space-y-3">
        {values.map((minor, index) => (
          <li key={labels[index]}>
            <p>
              {t("pricing.mealCharges.amount", {
                charge: labels[index],
                amount: decimalAmount(minor, scale),
                currency: room.currency,
              })}
            </p>
            {entry && (
              <label className="mt-2 block">
                {labels[index]} ({room.currency})
                <input
                  aria-label={t("pricing.mealCharges.inputLabel", { charge: labels[index], label })}
                  inputMode="decimal"
                  className="mt-1 block w-36 rounded border px-3 py-2"
                  disabled={disabled}
                  value={entry[index]}
                  onChange={(event) => {
                    setEntry(entry.map((value, i) => (i === index ? event.target.value : value)));
                    setError("");
                  }}
                />
              </label>
            )}
          </li>
        ))}
      </ul>
      {!entry ? (
        <button
          type="button"
          className="mt-3 rounded border px-3 py-2 disabled:opacity-50"
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            setEntry(values.map((minor) => decimalAmount(minor, scale)));
            setError("");
            onPending(true);
          }}
        >
          {t("pricing.mealCharges.edit")}
        </button>
      ) : (
        <>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              className="rounded border px-3 py-2 disabled:opacity-50"
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                try {
                  onChange(changeMealCharges(room, offer.id, entry));
                  cancel();
                } catch (cause) {
                  setError(errorText(cause, t, "pricing.mealCharges.changeFailed"));
                }
              }}
            >
              {t("pricing.mealCharges.apply")}
            </button>
            <button
              type="button"
              className="rounded border px-3 py-2 disabled:opacity-50"
              disabled={disabled}
              onClick={cancel}
            >
              {t("pricing.mealCharges.cancel")}
            </button>
          </div>
          <p className="mt-2">{t("pricing.applyOrCancelEdit")}</p>
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
