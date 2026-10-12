"use client";

import { useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { AcceptedPaymentMethods } from "./AcceptedPaymentMethods";
import { firstPricingInput, type SetupRoom } from "./FirstPricingSetup";
import { IncludedPricing } from "./IncludedPricing";
import { errorText } from "./pricingAmounts";
import { currencySymbol } from "./stepPricing";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

type Values = Parameters<typeof firstPricingInput>[3];
type Field = Exclude<keyof Values, "occupancy" | "included" | "methods">;
const modes = ["flat", "occupancy", "per_person", "included_guests"] as const;

/** "Set prices" for a room without prices, as the Paper design's numbered questions. It builds the room with the
 * shared `firstPricingInput` (the same configuration the old form made); "Continue" hands it to the editor, which shows
 * the full steps, unsaved, so seasons, weekends and more options can be added before "Save prices". */
export function StepFirstPrices({
  propertyId,
  rooms,
  fixedCurrency,
  disabled,
  onDirty,
  onCreate,
}: {
  propertyId: string;
  /** The room page's room (the first; the page offers only its own room). */
  rooms: readonly SetupRoom[];
  fixedCurrency?: string;
  disabled: boolean;
  onDirty: () => void;
  onCreate: (input: ReturnType<typeof firstPricingInput>) => void;
}) {
  const { t } = useTranslation();
  const room = rooms[0]!;
  const [values, setValues] = useState<Values>({
    mode: "flat",
    occupancy: [],
    included: { adults: "", adjustments: [] },
    methods: [],
    room: room.roomTypeId,
    currency: fixedCurrency ?? "",
    base: "",
    // Like the first-price form before it, nothing the guest agrees to is preselected: cancellation, payment methods
    // and the children rules are explicit choices. One night is the engine's "no minimum".
    adultAge: "",
    childPrice: "",
    countChildren: "",
    minimum: "1",
    maximum: "",
    cancellation: "",
    freeDays: "",
    payment: "full",
  });
  const [guestPrices, setGuestPrices] = useState(false);
  const [error, setError] = useState("");
  const change = (next: Partial<Values>) => {
    setValues({ ...values, ...next });
    setError("");
    onDirty();
  };
  const currency = fixedCurrency ?? values.currency.trim().toUpperCase();
  const symbol = currency ? currencySymbol(currency) : null;
  const field = (
    key: Field,
    label: string,
    className = "w-28",
    inputMode: "numeric" | "decimal" = "numeric",
  ) => (
    <label className={ui.fieldLabel}>
      {label}
      <input
        aria-label={label}
        inputMode={inputMode}
        disabled={disabled}
        value={values[key]}
        onChange={(event) => change({ [key]: event.target.value })}
        className={`mt-1.5 block ${className} ${ui.field}`}
      />
    </label>
  );
  const choice = (selected: boolean, label: string, onClick: () => void) => (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={ui.chip(selected)}
    >
      {label}
    </button>
  );
  function submit() {
    if (disabled) return;
    try {
      onCreate(firstPricingInput(propertyId, room, crypto.randomUUID(), { ...values, currency }));
    } catch (cause) {
      setError(errorText(cause, t, "pricing.setup.errorCheck"));
    }
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h2 className={ui.stepTitle}>{t("pricing.steps.first.title")}</h2>
      <p className={ui.stepHint}>{t("pricing.steps.first.intro")}</p>
      <StepCard
        number={1}
        title={t("pricing.steps.price.title")}
        hint={t("pricing.steps.first.priceHint")}
      >
        <div className="flex flex-wrap items-end gap-3">
          {(values.mode === "flat" ||
            values.mode === "per_person" ||
            values.mode === "included_guests") && (
            <label className="block">
              <span className="sr-only">
                {t(
                  values.mode === "per_person"
                    ? "pricing.setup.adultPrice"
                    : "pricing.setup.roomPrice",
                )}
              </span>
              <span className="flex h-12 w-[200px] items-center gap-2 rounded-[10px] bg-gray-100 px-4 focus-within:ring-2 focus-within:ring-primary-500">
                {symbol && (
                  <span aria-hidden="true" className="text-[16px] text-gray-500">
                    {symbol}
                  </span>
                )}
                <input
                  aria-label={t(
                    values.mode === "per_person"
                      ? "pricing.setup.adultPrice"
                      : "pricing.setup.roomPrice",
                  )}
                  inputMode="decimal"
                  disabled={disabled}
                  value={values.base}
                  onChange={(event) => change({ base: event.target.value })}
                  className="min-w-0 grow bg-transparent text-[18px] font-semibold text-gray-900 outline-none disabled:cursor-not-allowed"
                />
              </span>
            </label>
          )}
          {values.mode === "occupancy" &&
            Array.from({ length: room.capacity.adults }, (_, index) => {
              const label = t(
                index ? "pricing.setup.occupancyPrice.other" : "pricing.setup.occupancyPrice.one",
                { count: index + 1 },
              );
              return (
                <label key={index} className={ui.fieldLabel}>
                  {label}
                  <input
                    aria-label={label}
                    inputMode="decimal"
                    disabled={disabled}
                    value={values.occupancy[index] ?? ""}
                    onChange={(event) =>
                      change({
                        occupancy: Array.from({ length: room.capacity.adults }, (_, i) =>
                          i === index ? event.target.value : (values.occupancy[i] ?? ""),
                        ),
                      })
                    }
                    className={`mt-1.5 block w-36 ${ui.field}`}
                  />
                </label>
              );
            })}
          <span className="flex h-12 items-center text-[15px] text-gray-700">
            {t(
              values.mode === "per_person"
                ? "pricing.steps.price.perAdultNight"
                : "pricing.steps.price.perNight",
            )}
          </span>
          {fixedCurrency ? (
            <span className="flex h-12 items-center rounded-[10px] border border-gray-200 px-3.5 text-[14px] text-gray-700">
              {fixedCurrency}
            </span>
          ) : null}
          <label className={fixedCurrency ? "sr-only" : ui.fieldLabel}>
            {t("pricing.setup.currency")}
            <input
              aria-label={t("pricing.setup.currency")}
              disabled={disabled || !!fixedCurrency}
              value={fixedCurrency ?? values.currency}
              onChange={(event) => change({ currency: event.target.value })}
              className={`mt-1.5 block w-28 ${ui.field}`}
            />
          </label>
        </div>
        {!guestPrices ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setGuestPrices(true)}
            className={ui.stepLink}
          >
            {t("pricing.steps.first.guestPrices")}
          </button>
        ) : (
          <div className="space-y-3">
            <label className={ui.fieldLabel}>
              {t("pricing.setup.mode")}
              <select
                aria-label={t("pricing.setup.mode")}
                disabled={disabled}
                value={values.mode}
                onChange={(event) =>
                  change({
                    mode: event.target.value,
                    base: "",
                    occupancy: [],
                    included: { adults: "", adjustments: [] },
                  })
                }
                className={`mt-1.5 block ${ui.field}`}
              >
                {modes.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(
                      `pricing.setup.mode${mode === "flat" ? "Flat" : mode === "occupancy" ? "Occupancy" : mode === "per_person" ? "PerPerson" : "Included"}`,
                    )}
                  </option>
                ))}
              </select>
            </label>
            {values.mode === "included_guests" && (
              <IncludedPricing
                value={values.included}
                capacity={room.capacity.adults}
                disabled={disabled}
                onChange={(included) => change({ included })}
              />
            )}
          </div>
        )}
      </StepCard>
      <StepCard
        number={2}
        title={t("pricing.steps.first.cancelTitle")}
        hint={t("pricing.steps.first.cancelHint")}
      >
        <div className="flex flex-wrap items-center gap-2">
          {choice(values.cancellation === "flexible", t("pricing.steps.first.flexible"), () =>
            change({ cancellation: "flexible" }),
          )}
          {choice(
            values.cancellation === "non_refundable",
            t("pricing.steps.first.nonRefundable"),
            () => change({ cancellation: "non_refundable" }),
          )}
        </div>
        {values.cancellation === "flexible" && field("freeDays", t("pricing.freeCancellationDays"))}
        <AcceptedPaymentMethods
          methods={values.methods}
          disabled={disabled}
          onChange={(methods) => change({ methods })}
        />
      </StepCard>
      <StepCard
        number={3}
        title={t("pricing.steps.rules.title")}
        hint={t("pricing.steps.first.rulesHint")}
      >
        <div className="flex flex-wrap items-end gap-4">
          {field("minimum", t("pricing.steps.rules.minimum"))}
          {field("maximum", t("pricing.setup.maximum"), "w-40")}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          {field("adultAge", t("pricing.setup.adultAge"))}
          {field("childPrice", t("pricing.setup.childPrice"), "w-36", "decimal")}
        </div>
        <fieldset className="space-y-2">
          <legend className={ui.fieldLabel}>{t("pricing.setup.countChildren")}</legend>
          <div className="flex flex-wrap gap-2">
            {choice(values.countChildren === "yes", t("pricing.setup.yes"), () =>
              change({ countChildren: "yes" }),
            )}
            {choice(values.countChildren === "no", t("pricing.setup.no"), () =>
              change({ countChildren: "no" }),
            )}
          </div>
        </fieldset>
      </StepCard>
      {error && (
        <p role="alert" className={ui.errorText}>
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className={`mr-auto ${ui.help}`}>{t("pricing.steps.first.continueHint")}</p>
        <button type="submit" disabled={disabled} className={ui.primaryButton}>
          {t("pricing.steps.first.continue")}
        </button>
      </div>
    </form>
  );
}
