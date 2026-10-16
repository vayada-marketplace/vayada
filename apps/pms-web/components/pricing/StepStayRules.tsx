"use client";

import { useId, useState, type ReactNode } from "react";
import { MinusIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { errorText } from "./pricingAmounts";
import { childrenSummary, mainOffer, ownRuleOptions, setMinimumNights } from "./stepPricing";
import { MoreGroup } from "./SimpleMoreOptions";
import * as ui from "./pricingStyles";

/** More options' "Length of stay" and "Children": the main option's minimum nights (options that follow its stay rules
 * too) and the child prices. Options with their own stay rules are named, not changed. `children` is the child-price
 * window, opened by its Edit; a room that takes no children doesn't mention them. */
export function StepStayRules({
  room,
  names,
  disabled,
  onChange,
  onEditChildren,
  children,
}: {
  room: PricingConfiguration;
  names: Readonly<Record<string, string>>;
  disabled: boolean;
  onChange: (room: PricingConfiguration) => void;
  onEditChildren: () => void;
  children: ReactNode;
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
  const bands = room.children.bands;
  const counted = bands.every((band) => band.countsTowardCapacity)
    ? t("pricing.simple.more.childrenCounted", { count: room.capacity.total })
    : bands.every((band) => !band.countsTowardCapacity)
      ? t("pricing.simple.more.childrenNotCounted")
      : null;
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
      {room.capacity.children > 0 && (
        <MoreGroup title={t("pricing.steps.rules.children")}>
          <div className="flex h-[54px] items-center justify-between gap-3 rounded-[10px] bg-gray-100 px-[18px]">
            <span className="truncate text-[14px] text-gray-900">{childrenSummary(room, t)}</span>
            <button
              type="button"
              aria-label={t("pricing.steps.rules.childrenEdit")}
              disabled={disabled}
              onClick={onEditChildren}
              className={`shrink-0 ${ui.stepLink}`}
            >
              {t("pricing.steps.options.edit")}
            </button>
          </div>
          {counted && <p className={ui.stepHint}>{counted}</p>}
        </MoreGroup>
      )}
      {children}
    </>
  );
}
