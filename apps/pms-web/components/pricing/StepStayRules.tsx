"use client";

import { useId, useState } from "react";
import { MinusIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { errorText } from "./pricingAmounts";
import { mainOffer, ownRuleOptions, setMinimumNights } from "./stepPricing";
import { MoreGroup } from "./SimpleMoreOptions";
import * as ui from "./pricingStyles";

/** More options' "Length of stay": the main option's minimum nights (options that follow its stay rules too). Options
 * with their own stay rules are named, not changed. Children's prices moved to "Prices and seasons" (VAY-2280). */
export function StepStayRules({
  room,
  names,
  disabled,
  onChange,
}: {
  room: PricingConfiguration;
  names: Readonly<Record<string, string>>;
  disabled: boolean;
  onChange: (room: PricingConfiguration) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const minimumId = useId();
  const main = mainOffer(room);
  const rules = main.restrictions.kind === "own" ? main.restrictions.rules : null;
  const own = ownRuleOptions(room);
  const step = (nights: number) => {
    if (disabled) return;
    try {
      onChange(setMinimumNights(room, nights));
      setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.stayRules.changeFailed"));
    }
  };
  const nights = rules?.minArrivalNights ?? 1;
  return (
    <>
      <MoreGroup title={t("pricing.simple.more.stay")}>
        <div className="w-60 space-y-1.5">
          <p id={minimumId} className="text-[13px] font-medium text-gray-700">
            {t("pricing.steps.rules.minimum")}
          </p>
          <div
            role="group"
            aria-labelledby={minimumId}
            className="flex h-[54px] items-center justify-between rounded-[10px] bg-gray-100 px-2"
          >
            <button
              type="button"
              aria-label={t("pricing.steps.rules.fewer")}
              disabled={disabled || !rules || nights <= 1}
              onClick={() => step(nights - 1)}
              className="rounded-lg p-2 text-gray-500 hover:bg-gray-200 disabled:opacity-40"
            >
              <MinusIcon aria-hidden="true" className="h-4 w-4" />
            </button>
            <output aria-live="polite" className="text-[15px] font-semibold text-gray-900">
              {nights}
            </output>
            <button
              type="button"
              aria-label={t("pricing.steps.rules.more")}
              disabled={
                disabled ||
                !rules ||
                (rules.maxStayNights !== null && nights >= rules.maxStayNights)
              }
              onClick={() => step(nights + 1)}
              className="rounded-lg p-2 text-gray-500 hover:bg-gray-200 disabled:opacity-40"
            >
              <PlusIcon aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
        {own.length > 0 && (
          <p className={ui.stepHint}>
            {t("pricing.steps.rules.own", {
              names: own.map((offer) => names[offer.id] ?? "").join(", "),
            })}
          </p>
        )}
        {error && (
          <p role="alert" className={ui.errorText}>
            {error}
          </p>
        )}
      </MoreGroup>
    </>
  );
}
