"use client";

import { useState } from "react";
import {
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";
import { paidInAdvance } from "@vayada/product-onboarding/AcceptedPaymentMethods";
import { AcceptedPaymentMethods, type PaymentMethod } from "./AcceptedPaymentMethods";
import { decimalAmount, errorText } from "./pricingAmounts";
import { mainOffer, presetOption, presets, type OptionTerms, type PresetKey } from "./stepPricing";
import * as ui from "./pricingStyles";

/** A quick-add preset's short form (step 4): how much cheaper a non-refundable option is, the meal price, and the
 * payment methods. Everything else comes from the main option: the new option is based on it and follows its stay
 * rules; its cancellation is the main option's unless the preset is non-refundable. */
export function PresetWindow({
  room,
  preset,
  names,
  mainTerms,
  disabled,
  onAdd,
  onClose,
}: {
  room: PricingConfiguration;
  preset: PresetKey;
  names: Readonly<Record<string, string>>;
  mainTerms: OptionTerms | undefined;
  disabled: boolean;
  /** Adds the option; returns why it couldn't (shown here, in front of the page's own banner). */
  onAdd: (input: ReturnType<typeof presetOption>) => unknown;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { meal, nonRefundable } = presets[preset];
  const main = mainOffer(room);
  // A second breakfast option starts at the breakfast price an option already charges per room.
  const known = room.offers.find(
    (offer) => offer.meal.kind === meal && offer.meal.charge.kind === "room",
  )?.meal.charge;
  const [discount, setDiscount] = useState("10");
  const [mealAmount, setMealAmount] = useState(
    known?.kind === "room"
      ? decimalAmount(known.amountMinor, pricingCurrencyScale(room.currency)!)
      : "",
  );
  const [mealBasis, setMealBasis] = useState<"room" | "person">(
    meal === "breakfast" ? "room" : "person",
  );
  // A non-refundable option is paid in advance: it starts without pay at property (VAY-2280).
  const paidAhead = nonRefundable || mainTerms?.cancellation.kind === "non_refundable";
  const [methods, setMethods] = useState<PaymentMethod[]>(() => {
    const main = mainTerms?.payment.acceptedMethods ?? [];
    return paidAhead ? paidInAdvance(main) : [...main];
  });
  const [error, setError] = useState("");
  const title = t("pricing.steps.preset.title", {
    name: t(`pricing.steps.name.${nonRefundable ? "non_refundable" : "flexible"}.${meal}`),
  });
  function add() {
    if (disabled || !mainTerms) return;
    try {
      const failure = onAdd(
        presetOption(
          room,
          crypto.randomUUID(),
          preset,
          { discount, mealAmount, mealBasis, methods },
          mainTerms,
        ),
      );
      if (failure) setError(errorText(failure, t, "pricing.linkedOffer.errorCheck"));
    } catch (cause) {
      setError(errorText(cause, t, "pricing.linkedOffer.errorCheck"));
    }
  }
  return (
    <Modal
      onClose={onClose}
      ariaLabel={title}
      maxWidth="lg"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={ui.secondaryButton}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={disabled || !mainTerms}
            onClick={add}
            className={ui.primaryButton}
          >
            {t("pricing.steps.preset.add")}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <h2 className={ui.stepTitle}>{title}</h2>
        <p className={ui.help}>
          {t(
            nonRefundable
              ? "pricing.steps.preset.explainNonRefundable"
              : "pricing.steps.preset.explainMeal",
            { name: names[main.id] ?? "" },
          )}
        </p>
        {!mainTerms && <p className={ui.help}>{t("pricing.steps.preset.termsMissing")}</p>}
        {nonRefundable && (
          <label className={ui.fieldLabel}>
            {t("pricing.steps.preset.discount")}
            <span className="mt-1.5 flex items-center gap-2">
              <input
                aria-label={t("pricing.steps.preset.discount")}
                inputMode="decimal"
                disabled={disabled}
                value={discount}
                onChange={(event) => {
                  setDiscount(event.target.value);
                  setError("");
                }}
                className={`w-24 ${ui.field}`}
              />
              <span className={ui.text}>%</span>
            </span>
          </label>
        )}
        {meal !== "room_only" && (
          <div className="flex flex-wrap items-end gap-3">
            <label className={ui.fieldLabel}>
              {t("pricing.steps.preset.mealPrice", {
                meal: t(`pricing.steps.meal.${meal}`),
                currency: room.currency,
              })}
              <input
                aria-label={t("pricing.steps.preset.mealPriceAria", {
                  meal: t(`pricing.steps.meal.${meal}`),
                })}
                inputMode="decimal"
                disabled={disabled}
                value={mealAmount}
                onChange={(event) => {
                  setMealAmount(event.target.value);
                  setError("");
                }}
                className={`mt-1.5 block w-36 ${ui.field}`}
              />
            </label>
            <label className={ui.fieldLabel}>
              {t("pricing.steps.preset.basis")}
              <select
                aria-label={t("pricing.steps.preset.basis")}
                disabled={disabled}
                value={mealBasis}
                onChange={(event) => setMealBasis(event.target.value as "room" | "person")}
                className={`mt-1.5 block ${ui.field}`}
              >
                <option value="room">{t("pricing.steps.preset.perRoom")}</option>
                <option value="person">{t("pricing.steps.preset.perAdult")}</option>
              </select>
            </label>
            {mealBasis === "person" && (
              <p className={`w-full ${ui.hint}`}>{t("pricing.steps.preset.childrenHint")}</p>
            )}
          </div>
        )}
        <AcceptedPaymentMethods
          methods={methods}
          disabled={disabled}
          nonRefundable={paidAhead}
          onChange={(next) => {
            setMethods(next);
            setError("");
          }}
        />
        {error && (
          <p role="alert" className={ui.errorText}>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
