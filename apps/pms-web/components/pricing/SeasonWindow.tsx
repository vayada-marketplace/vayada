"use client";

import { useState } from "react";
import {
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";
import { baseAmounts, decimalAmount, errorText, PricingError } from "./pricingAmounts";
import { changeSeasonPrice } from "./PricingSeasons";
import { IncludedPricing, includedInput, type IncludedInput } from "./IncludedPricing";
import { recurringTemplate } from "./recurringPricingInputs";
import { seasonsOverlap } from "./stepPricing";
import * as ui from "./pricingStyles";

type Offer = PricingConfiguration["offers"][number];
type Day = { day: string; month: string };
const split = (value?: string): Day =>
  value
    ? { month: String(Number(value.slice(0, 2))), day: String(Number(value.slice(3))) }
    : { month: "", day: "" };
/** "MM-DD" for a real day of the leap year 2000 (the engine's season calendar), or null. */
function monthDay({ day, month }: Day) {
  if (!/^\d{1,2}$/.test(day) || !/^\d{1,2}$/.test(month)) return null;
  const value = `${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`2000-${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(5, 10) === value
    ? value
    : null;
}

/** Adds, edits or deletes one season of `offer` (step 2). The engine's `changeSeasonPrice` makes the change; this
 * window adds plain checks for the days first. Closing it drops what was typed. `prefill` starts a new season with a
 * season's name, tier and price: another date range of that season (VAY-2280). */
export function SeasonWindow({
  room,
  offer,
  label,
  index,
  disabled,
  prefill,
  onChange,
  onClose,
}: {
  room: PricingConfiguration;
  offer: Offer;
  label: string;
  prefill?: { name: string; tier: string; values: string[] };
  /** The season to edit, or null to add one. */
  index: number | null;
  disabled: boolean;
  onChange: (room: PricingConfiguration) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const calendar = offer.price.kind === "independent" ? offer.price.calendar : null;
  const season = index === null ? null : (calendar?.seasons[index] ?? null);
  const template = season?.price ?? recurringTemplate(offer);
  const scale = pricingCurrencyScale(room.currency)!;
  const [name, setName] = useState(season?.name ?? prefill?.name ?? ""),
    [tier, setTier] = useState(season?.tier ?? prefill?.tier ?? "");
  const [from, setFrom] = useState(split(season?.from)),
    [through, setThrough] = useState(split(season?.through));
  const [values, setValues] = useState<string[]>(
    season
      ? baseAmounts(season.price).map(([, minor]) => decimalAmount(minor, scale))
      : (prefill?.values ?? []),
  );
  const [included, setIncluded] = useState<IncludedInput | null>(
    template?.mode === "included_guests" ? includedInput(template, scale) : null,
  );
  const [error, setError] = useState("");
  if (!calendar || !template) return null;
  const fields = baseAmounts(
    template.mode === "included_guests" && included
      ? { ...template, baseGuests: Number(included.adults) || template.baseGuests }
      : template,
    t,
  );
  const original = season && {
    name: season.name,
    tier: season.tier,
    from: season.from,
    through: season.through,
  };
  const title = t(season ? "pricing.steps.seasons.editTitle" : "pricing.steps.seasons.addTitle");
  function save() {
    if (disabled) return;
    try {
      if (!name.trim()) throw new PricingError("pricing.seasons.errorName");
      const start = monthDay(from),
        end = monthDay(through);
      if (!start || !end) throw new PricingError("pricing.steps.seasons.errorDays");
      const next = { name: name.trim(), tier: tier.trim(), from: start, through: end };
      if (calendar!.seasons.some((other, i) => i !== index && seasonsOverlap(next, other)))
        throw new PricingError("pricing.steps.seasons.errorOverlap");
      const amounts = Array.from({ length: fields.length }, (_, i) => values[i] ?? "");
      onChange(changeSeasonPrice(room, offer.id, next, amounts, original, included));
    } catch (cause) {
      setError(errorText(cause, t, "pricing.seasons.changeFailed"));
    }
  }
  function remove() {
    if (disabled || !original) return;
    try {
      onChange(changeSeasonPrice(room, offer.id, original, null));
    } catch (cause) {
      setError(errorText(cause, t, "pricing.seasons.changeFailed"));
    }
  }
  const day = (legend: string, value: Day, set: (value: Day) => void) => (
    <fieldset>
      <legend className={ui.fieldLabel}>{legend}</legend>
      <div className="mt-1.5 flex gap-2">
        <input
          aria-label={t("pricing.steps.seasons.dayAria", { name: legend })}
          inputMode="numeric"
          maxLength={2}
          placeholder={t("pricing.steps.seasons.dayPlaceholder")}
          disabled={disabled}
          value={value.day}
          onChange={(event) => {
            set({ ...value, day: event.target.value });
            setError("");
          }}
          className={`w-16 ${ui.field}`}
        />
        <select
          aria-label={t("pricing.steps.seasons.monthAria", { name: legend })}
          disabled={disabled}
          value={value.month}
          onChange={(event) => {
            set({ ...value, month: event.target.value });
            setError("");
          }}
          className={`grow ${ui.field}`}
        >
          <option value="">{t("pricing.choose")}</option>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i} value={String(i + 1)}>
              {t(`pricing.month.${i + 1}`)}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
  return (
    <Modal
      onClose={onClose}
      ariaLabel={title}
      maxWidth="lg"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {original && (
            <button
              type="button"
              disabled={disabled}
              onClick={remove}
              className="mr-auto text-[13px] font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
            >
              {t("pricing.steps.seasons.delete")}
            </button>
          )}
          <button type="button" onClick={onClose} className={ui.secondaryButton}>
            {t("common.cancel")}
          </button>
          <button type="button" disabled={disabled} onClick={save} className={ui.primaryButton}>
            {t("pricing.steps.seasons.save")}
          </button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <h2 className={ui.stepTitle}>{title}</h2>
        <label className={ui.fieldLabel}>
          {t("pricing.steps.seasons.name")}
          <input
            aria-label={t("pricing.steps.seasons.name")}
            placeholder={t("pricing.steps.seasons.namePlaceholder")}
            disabled={disabled}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
            className={`mt-1.5 ${ui.input}`}
          />
        </label>
        {/* The engine's optional season category ("High", "Peak"); kept as it is unless changed here. */}
        <label className={ui.fieldLabel}>
          {t("pricing.seasons.tier")}
          <input
            aria-label={t("pricing.seasons.tier")}
            disabled={disabled}
            value={tier}
            onChange={(event) => {
              setTier(event.target.value);
              setError("");
            }}
            className={`mt-1.5 ${ui.input}`}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          {day(t("pricing.steps.seasons.starts"), from, setFrom)}
          {day(t("pricing.steps.seasons.ends"), through, setThrough)}
        </div>
        <div className="flex flex-wrap gap-3">
          {fields.map(([field], i) => (
            <label key={i} className={ui.fieldLabel}>
              {t("pricing.steps.seasons.price", { name: field, currency: room.currency })}
              <input
                aria-label={t("pricing.steps.seasons.priceAria", { name: field })}
                inputMode="decimal"
                disabled={disabled}
                value={values[i] ?? ""}
                onChange={(event) => {
                  setValues(
                    Array.from({ length: fields.length }, (_, j) =>
                      j === i ? event.target.value : (values[j] ?? ""),
                    ),
                  );
                  setError("");
                }}
                className={`mt-1.5 block w-40 ${ui.field}`}
              />
            </label>
          ))}
        </div>
        {included && (
          <IncludedPricing
            value={included}
            label={t("pricing.seasons.includedLabel", { label })}
            capacity={room.capacity.adults}
            disabled={disabled}
            onChange={(next) => {
              setIncluded(next);
              setError("");
            }}
          />
        )}
        {error && (
          <p role="alert" className={ui.errorText}>
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
