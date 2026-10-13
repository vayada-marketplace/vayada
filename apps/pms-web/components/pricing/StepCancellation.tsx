"use client";

import { useState } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  cancellationDays,
  cancellationEdits,
  defaultFreeDays,
  type SimpleCancellation,
  type SimpleRoom,
} from "./simplePricing";
import type { OptionTerms } from "./stepPricing";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

/** The card's cancellation: free until a number of days before arrival, or non-refundable. It sets the main option's
 * terms and the breakfast switch's, which follows them. The hotel's own terms (a partial refund or a text) stay as they
 * are; their Edit opens the main option's window. Non-refundable waits until the non-refundable switch is off, so
 * guests never see two non-refundable choices. */
export function StepCancellation({
  simple,
  terms,
  failed,
  disabled,
  onTerms,
  onRetry,
  onEditOwn,
}: {
  /** Null while the options' terms load (or failed). */
  simple: SimpleRoom | null;
  terms: Readonly<Record<string, OptionTerms | undefined>>;
  failed: boolean;
  disabled: boolean;
  onTerms: (edits: ReturnType<typeof cancellationEdits>) => void;
  onRetry: () => void;
  onEditOwn: () => void;
}) {
  const { t } = useTranslation();
  const title = t("pricing.simple.cancellation.title");
  const current = simple?.cancellation;
  const [blocked, setBlocked] = useState(false);
  const choose = (choice: Exclude<SimpleCancellation, { kind: "own" }>) => {
    if (!simple || disabled || JSON.stringify(choice) === JSON.stringify(current)) return;
    setBlocked(choice.kind === "non_refundable" && !!simple.nonRefundable);
    if (choice.kind !== "non_refundable" || !simple.nonRefundable)
      onTerms(cancellationEdits(simple, terms, choice));
  };
  const days = current?.kind === "free" ? current.days : defaultFreeDays;
  const choices = Array.from(new Set<number>([...cancellationDays, days])).sort((a, b) => a - b);
  return (
    <StepCard title={title}>
      {!simple || !current ? (
        failed ? (
          <p role="status" className="text-[14px] text-amber-700">
            {t("pricing.simple.cancellation.failed")}{" "}
            <button type="button" onClick={onRetry} className={ui.stepLink}>
              {t("pricing.steps.options.retry")}
            </button>
          </p>
        ) : (
          <p role="status" className={ui.stepHint}>
            {t("pricing.simple.cancellation.loading")}
          </p>
        )
      ) : current.kind === "own" ? (
        <p className="text-[14px] text-gray-700">
          {t("pricing.simple.cancellation.own")}{" "}
          <button type="button" disabled={disabled} onClick={onEditOwn} className={ui.stepLink}>
            {t("pricing.steps.options.edit")}
          </button>
        </p>
      ) : (
        <>
          <div role="group" aria-label={title} className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={current.kind === "free"}
              disabled={disabled}
              onClick={() => choose({ kind: "free", days })}
              className={ui.chip(current.kind === "free")}
            >
              {t("pricing.simple.cancellation.free")}
            </button>
            <button
              type="button"
              aria-pressed={current.kind === "non_refundable"}
              disabled={disabled}
              onClick={() => choose({ kind: "non_refundable" })}
              className={ui.chip(current.kind === "non_refundable")}
            >
              {t("pricing.simple.cancellation.nonRefundable")}
            </button>
          </div>
          {current.kind === "free" && (
            <label className="flex flex-wrap items-center gap-2.5 text-[15px] text-gray-700">
              {t("pricing.simple.cancellation.until")}
              <select
                aria-label={t("pricing.simple.cancellation.daysLabel")}
                disabled={disabled}
                value={days}
                onChange={(event) => choose({ kind: "free", days: Number(event.target.value) })}
                className="h-10 rounded-[10px] border border-gray-300 bg-white px-3 text-[15px] font-medium text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {choices.map((value) => (
                  <option key={value} value={value}>
                    {t(
                      value === 1
                        ? "pricing.simple.cancellation.days.one"
                        : "pricing.simple.cancellation.days.other",
                      { count: value },
                    )}
                  </option>
                ))}
              </select>
              {t("pricing.simple.cancellation.before")}
            </label>
          )}
        </>
      )}
      {simple?.breakfast && current && current.kind !== "own" && (
        <p className={ui.stepHint}>{t("pricing.simple.cancellation.withBreakfast")}</p>
      )}
      {blocked && simple?.nonRefundable && (
        <p role="alert" className={ui.errorText}>
          {t("pricing.simple.cancellation.switchFirst")}
        </p>
      )}
    </StepCard>
  );
}
