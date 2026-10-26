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
import { PricingSection } from "./PricingSection";
import * as ui from "./pricingStyles";

export function changeChildCharges(
  room: PricingConfiguration,
  amounts: readonly string[],
): PricingConfiguration {
  if (amounts.length !== room.children.bands.length)
    throw new PricingError("pricing.childCharges.errorBands");
  const scale = pricingCurrencyScale(room.currency);
  if (scale === null) throw new PricingError("pricing.error.currencyUnavailable");
  const bands = room.children.bands.map((band, index) => ({
    ...band,
    nightlyMinor: parseMinorInput(amounts[index], scale, true, pricingAmountStep(room.currency)),
  }));
  const result = parsePricingConfiguration({ ...room, children: { ...room.children, bands } });
  if (!result) throw new PricingError("pricing.childCharges.errorInvalid");
  return result;
}

/** "Children under {age}" (VAY-2305): a room's one age band from 0 moves with the age guests count as adults from. */
export function changeChildAge(room: PricingConfiguration, age: string): PricingConfiguration {
  const [band] = room.children.bands;
  if (room.children.bands.length !== 1 || band.fromAge !== 0)
    throw new PricingError("pricing.childCharges.errorInvalid");
  if (!/^\d{1,2}$/.test(age.trim())) throw new PricingError("pricing.seasonTable.childrenAgeError");
  const adultFromAge = Number(age.trim());
  const result = parsePricingConfiguration({
    ...room,
    children: {
      ...room.children,
      adultFromAge,
      bands: [{ ...band, throughAge: adultFromAge - 1 }],
    },
  });
  if (!result) throw new PricingError("pricing.seasonTable.childrenAgeError");
  return result;
}

export function PricingChildCharges({
  room,
  label,
  disabled,
  onChange,
  onPending,
}: {
  room: PricingConfiguration;
  label: string;
  disabled: boolean;
  onChange: (room: PricingConfiguration) => void;
  onPending: (pending: boolean) => void;
}) {
  const [entry, setEntry] = useState<string[] | null>(null),
    [error, setError] = useState("");
  const { t } = useTranslation();
  const scale = pricingCurrencyScale(room.currency)!;
  const cancel = () => {
    setEntry(null);
    setError("");
    onPending(false);
  };
  return (
    <PricingSection
      title={t("pricing.childCharges.section")}
      label={t("pricing.childCharges.title", { label })}
      keepOpen={!!entry}
    >
      <p className={ui.help}>
        {t("pricing.childCharges.description", { age: room.children.adultFromAge })}
      </p>
      <ul className="mt-3 space-y-3">
        {room.children.bands.map((band, index) => (
          <li key={band.fromAge}>
            <p>
              {t("pricing.childCharges.band", {
                from: band.fromAge,
                through: band.throughAge,
                amount: decimalAmount(band.nightlyMinor, scale),
                currency: room.currency,
              })}{" "}
              {t(
                band.countsTowardCapacity
                  ? "pricing.childCharges.countsTowardCapacity"
                  : "pricing.childCharges.notCountsTowardCapacity",
              )}{" "}
              {t("pricing.childCharges.childLimit")}
            </p>
            {entry && (
              <label className={`mt-2 ${ui.fieldLabel}`}>
                {t("pricing.childCharges.nightlyCharge", { currency: room.currency })}
                <input
                  aria-label={t("pricing.childCharges.inputLabel", {
                    from: band.fromAge,
                    through: band.throughAge,
                    label,
                  })}
                  inputMode="decimal"
                  className={`mt-1.5 block w-36 ${ui.field}`}
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
          className={ui.secondaryButton}
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            setEntry(room.children.bands.map((band) => decimalAmount(band.nightlyMinor, scale)));
            setError("");
            onPending(true);
          }}
        >
          {t("pricing.childCharges.edit")}
        </button>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={ui.secondaryButton}
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                try {
                  onChange(changeChildCharges(room, entry));
                  cancel();
                } catch (cause) {
                  setError(errorText(cause, t, "pricing.childCharges.changeFailed"));
                }
              }}
            >
              {t("pricing.childCharges.apply")}
            </button>
            <button
              type="button"
              className={ui.secondaryButton}
              disabled={disabled}
              onClick={cancel}
            >
              {t("pricing.childCharges.cancel")}
            </button>
          </div>
          <p className="mt-2">{t("pricing.applyOrCancelEdit")}</p>
        </>
      )}
      {error && (
        <p role="alert" className={ui.errorText}>
          {error}
        </p>
      )}
    </PricingSection>
  );
}
