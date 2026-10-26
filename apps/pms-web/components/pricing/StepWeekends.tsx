"use client";

import { useState } from "react";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { errorText } from "./pricingAmounts";
import { PricingWeekdays } from "./PricingWeekdays";
import {
  adjustmentText,
  otherWeekdays,
  setWeekend,
  weekendChoice,
  weekendChoices,
} from "./stepPricing";
import * as ui from "./pricingStyles";

type Offer = PricingConfiguration["offers"][number];
/** The weekend row under "Busier dates": one surcharge for Friday and Saturday nights. "Other days…" opens the full
 * weekday editor, which stays mounted while hidden so its unapplied entry and the Save guard survive closing it. */
export function StepWeekends({
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
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  if (offer.price.kind !== "independent") return null;
  const choice = weekendChoice(offer),
    weekdays = offer.price.calendar.weekdays;
  const custom = choice === "other" || otherWeekdays(offer).length > 0;
  const editor = open || choice === "other" || pending;
  const apply = (basisPoints: number | null) => {
    if (disabled || pending) return;
    try {
      onChange(setWeekend(room, offer.id, basisPoints));
      setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.weekdays.changeFailed"));
    }
  };
  return (
    <div className="space-y-3 pt-2">
      <div
        role="group"
        aria-label={t("pricing.steps.weekends.title")}
        className="flex flex-wrap items-center gap-2"
      >
        <span aria-hidden="true" className="mr-2 text-[15px] text-gray-700">
          {t("pricing.steps.weekends.title")}
        </span>
        {([null, ...weekendChoices] as const).map((basisPoints) => {
          const selected = basisPoints === null ? choice === "none" : choice === basisPoints;
          return (
            <button
              key={String(basisPoints)}
              type="button"
              aria-pressed={selected}
              disabled={disabled || pending}
              className={ui.chip(selected)}
              onClick={() => apply(basisPoints)}
            >
              {basisPoints === null
                ? t("pricing.steps.weekends.no")
                : t("pricing.steps.weekends.percent", { percent: basisPoints / 100 })}
            </button>
          );
        })}
        <button
          type="button"
          aria-expanded={editor}
          // With other Friday/Saturday rules the editor must stay open, so the toggle has nothing to do.
          disabled={pending || choice === "other"}
          className={ui.chip(choice === "other")}
          onClick={() => setOpen(!open)}
        >
          {t("pricing.steps.weekends.other")}
        </button>
      </div>
      {custom && (
        <p className="text-[13px] text-gray-500">
          {weekdays
            .map(
              (rule) =>
                `${t(`pricing.weekday.${rule.day}`)} ${adjustmentText(rule.adjustment, room.currency)}`,
            )
            .join(" · ")}
        </p>
      )}
      {error && (
        <p role="alert" className={ui.errorText}>
          {error}
        </p>
      )}
      <div hidden={!editor}>
        <PricingWeekdays
          room={room}
          offer={offer}
          label={label}
          disabled={disabled}
          onChange={onChange}
          onPending={(next) => {
            setPending(next);
            onPending(next);
          }}
        />
      </div>
    </div>
  );
}
