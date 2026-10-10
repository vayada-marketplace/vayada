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
type SeasonInput = { name: string; tier: string; from: string; through: string };
export function changeSeasonPrice(
  room: PricingConfiguration,
  offerId: string,
  season: SeasonInput,
  values: string[] | null,
  original: SeasonInput | null = null,
  included: IncludedInput | null = null,
): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "independent")
    throw new PricingError("pricing.seasons.errorIndependent");
  const calendar = offer.price.calendar;
  let seasons = calendar.seasons;
  const target = original ?? season;
  const index = seasons.findIndex(
    (entry) =>
      entry.from === target.from &&
      entry.through === target.through &&
      entry.name === target.name &&
      entry.tier === target.tier,
  );
  if (original) {
    if (!season.name.trim()) throw new PricingError("pricing.seasons.errorName");
    if (index < 0 || !values) throw new PricingError("pricing.seasons.errorEditMissing");
    if (included && (seasons[index].price.mode !== "included_guests" || values.length !== 1))
      throw new PricingError("pricing.seasons.errorIncludedExisting");
    const price = included
      ? includedPrice(
          included,
          values[0],
          room.capacity.adults,
          pricingCurrencyScale(room.currency)!,
          pricingAmountStep(room.currency),
        )
      : recurringPrice(offer, values, room.currency, seasons[index].price);
    seasons = seasons.map((entry, i) => (i === index ? { ...entry, ...season, price } : entry));
  } else if (values) {
    if (included && (recurringTemplate(offer)?.mode !== "included_guests" || values.length !== 1))
      throw new PricingError("pricing.seasons.errorIncludedRequired");
    if (!season.name.trim()) throw new PricingError("pricing.seasons.errorName");
    seasons = [
      ...seasons,
      {
        ...season,
        price: included
          ? includedPrice(
              included,
              values[0],
              room.capacity.adults,
              pricingCurrencyScale(room.currency)!,
              pricingAmountStep(room.currency),
            )
          : recurringPrice(offer, values, room.currency),
      },
    ];
  } else {
    if (index < 0) throw new PricingError("pricing.seasons.errorUnavailable");
    seasons = seasons.filter((_, i) => i !== index);
  }
  const price = { ...offer.price, calendar: { ...calendar, seasons } };
  const result = parsePricingConfiguration({
    ...room,
    offers: room.offers.map((value) => (value.id === offerId ? { ...offer, price } : value)),
  });
  if (!result) throw new PricingError("pricing.seasons.errorInvalid");
  return result;
}

export function PricingSeasons({
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
  const [entry, setEntry] = useState<SeasonInput>({ name: "", tier: "", from: "", through: "" }),
    [values, setValues] = useState<string[]>([]),
    [error, setError] = useState(""),
    [editing, setEditing] = useState<SeasonInput | null>(null);
  if (offer.price.kind !== "independent") return null;
  const template = editing
      ? offer.price.calendar.seasons.find(
          (season) =>
            season.from === editing.from &&
            season.through === editing.through &&
            season.name === editing.name &&
            season.tier === editing.tier,
        )?.price
      : recurringTemplate(offer),
    scale = pricingCurrencyScale(room.currency)!;
  const activeIncluded =
    included ??
    (!editing && template?.mode === "included_guests" ? includedInput(template, scale) : null);
  const pending =
    !!included || !!editing || Object.values(entry).some(Boolean) || values.some(Boolean);
  const reset = () => {
    setEntry({ name: "", tier: "", from: "", through: "" });
    setValues([]);
    setIncluded(null);
    setEditing(null);
    setError("");
    onPending(false);
  };
  const apply = (season: SeasonInput, amounts: string[] | null) => {
    if (disabled || (!amounts && pending)) return;
    try {
      onChange(
        changeSeasonPrice(room, offer.id, season, amounts, editing, amounts ? included : null),
      );
      if (amounts) reset();
      else setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.seasons.changeFailed"));
    }
  };
  return (
    <details className="sm:col-span-2 text-sm">
      <summary className="cursor-pointer">{t("pricing.seasons.summary", { label })}</summary>
      <p className="mt-2 text-gray-600">{t("pricing.seasons.intro")}</p>
      <ul className="my-3 space-y-2">
        {offer.price.calendar.seasons.map((season) => (
          <li key={season.from} className="flex flex-wrap items-center gap-3">
            <span>
              {season.name}
              {season.tier && ` (${season.tier})`} · {season.from}–{season.through}:{" "}
              {baseAmounts(season.price, t)
                .map(([name, minor]) => `${name} ${decimalAmount(minor, scale)} ${room.currency}`)
                .join("; ")}
              .{recurringAdjustments(season.price, room.currency, scale, t)}
            </span>
            <button
              type="button"
              className="rounded border px-3 py-1 disabled:opacity-50"
              disabled={disabled || pending}
              aria-label={t("pricing.seasons.editAria", {
                from: season.from,
                through: season.through,
                label,
              })}
              onClick={() => {
                if (disabled || pending) return;
                setIncluded(
                  season.price.mode === "included_guests"
                    ? includedInput(season.price, scale)
                    : null,
                );
                const selected = {
                  name: season.name,
                  tier: season.tier,
                  from: season.from,
                  through: season.through,
                };
                setEditing(selected);
                setEntry(selected);
                setValues(
                  baseAmounts(season.price).map(([, minor]) => decimalAmount(minor, scale)),
                );
                setError("");
                onPending(true);
              }}
            >
              {t("pricing.seasons.edit")}
            </button>
            <button
              type="button"
              className="rounded border px-3 py-1 disabled:opacity-50"
              disabled={disabled || pending}
              aria-label={t("pricing.seasons.clearAria", {
                from: season.from,
                through: season.through,
                label,
              })}
              onClick={() => apply(season, null)}
            >
              {t("pricing.seasons.clear")}
            </button>
          </li>
        ))}
      </ul>
      {!template ? (
        <p>{t("pricing.seasons.noTemplate")}</p>
      ) : (
        <>
          <p className="mb-3">
            {editing ? t("pricing.seasons.editHint") : t("pricing.seasons.modeHint")}
            {recurringAdjustments(template, room.currency, scale, t)}
            {!editing &&
              template.mode === "included_guests" &&
              ` ${t("pricing.seasons.includedHint")}`}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            {(
              [
                ["name", t("pricing.seasons.name")],
                ["tier", t("pricing.seasons.tier")],
                ["from", t("pricing.seasonStart")],
                ["through", t("pricing.seasonEnd")],
              ] as const
            ).map(([key, name]) => (
              <label key={key}>
                {name}
                <input
                  aria-label={t("pricing.seasons.fieldAria", { name, label })}
                  className="mt-1 block w-40 rounded border px-3 py-2"
                  disabled={disabled}
                  value={entry[key]}
                  onChange={(event) => {
                    if (disabled) return;
                    const next = { ...entry, [key]: event.target.value };
                    setEntry(next);
                    setError("");
                    onPending(
                      !!included ||
                        !!editing ||
                        Object.values(next).some(Boolean) ||
                        values.some(Boolean),
                    );
                  }}
                />
              </label>
            ))}
            {baseAmounts(
              activeIncluded && template.mode === "included_guests"
                ? { ...template, baseGuests: Number(activeIncluded.adults) || template.baseGuests }
                : template,
              t,
            ).map(([name], index) => (
              <label key={index}>
                {name} ({room.currency})
                <input
                  aria-label={t("pricing.seasons.amountAria", { name, label })}
                  className="mt-1 block w-36 rounded border px-3 py-2"
                  disabled={disabled}
                  value={values[index] ?? ""}
                  onChange={(event) => {
                    const next = Array.from({ length: baseAmounts(template).length }, (_, i) =>
                      i === index ? event.target.value : (values[i] ?? ""),
                    );
                    setValues(next);
                    setError("");
                    onPending(
                      !!included ||
                        !!editing ||
                        Object.values(entry).some(Boolean) ||
                        next.some(Boolean),
                    );
                  }}
                />
              </label>
            ))}
            {activeIncluded && (
              <div className="w-full">
                <p>{t("pricing.seasons.includedBaseHint")}</p>
                <IncludedPricing
                  value={activeIncluded}
                  label={t("pricing.seasons.includedLabel", { label })}
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
              onClick={() => apply(entry, values)}
            >
              {editing ? t("pricing.seasons.apply") : t("pricing.seasons.add")}
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
            {t("pricing.seasons.cancel")}
          </button>
          <p className="mt-2">
            {editing ? t("pricing.seasons.pendingApply") : t("pricing.seasons.pendingAdd")}
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
