"use client";

import { useEffect, useRef, useState } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { errorText, PricingError } from "./pricingAmounts";
import { addClosedPeriod, closedPeriods, rangeDays, removeClosedPeriods } from "./stayRuleSeasons";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

type Room = PricingConfiguration;
type Day = { day: string; month: string };
const empty: Day = { day: "", month: "" };
/** "MM-DD" for a real day of the leap year 2000 (the engine's season calendar), or null. */
function monthDay({ day, month }: Day) {
  if (!/^\d{1,2}$/.test(day) || !/^\d{1,2}$/.test(month)) return null;
  const value = `${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`2000-${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(5, 10) === value
    ? value
    : null;
}

/** Step "When guests can book" (VAY-2280, approved board): open all year, or closed every year in some periods. A
 * closed period is a stay-rule season that stops sales on the main option (other options that inherit its rules
 * follow), so its nights show as Closed in "Prices by date". */
export function StepOpening({
  room,
  disabled,
  onChange,
  onPending,
}: {
  room: Room;
  disabled: boolean;
  onChange: (room: Room) => void;
  onPending: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false),
    [from, setFrom] = useState(empty),
    [through, setThrough] = useState(empty),
    [error, setError] = useState("");
  const report = useRef(onPending);
  useEffect(() => {
    report.current = onPending;
  });
  useEffect(() => {
    report.current(adding);
  }, [adding]);
  let closed: { from: string; through: string }[];
  try {
    closed = closedPeriods(room);
  } catch {
    return null;
  } // Options with their own stay rules are edited in their window.
  const closedNights = closed.reduce((sum, range) => sum + rangeDays(range), 0);
  const allYear = closed.length === 0;
  const day = (monthDayValue: string) =>
    `${Number(monthDayValue.slice(3))} ${t(`pricing.steps.monthShort.${Number(monthDayValue.slice(0, 2))}`)}`;
  const apply = (change: () => Room) => {
    if (disabled) return;
    try {
      onChange(change());
      setError("");
      return true;
    } catch (cause) {
      setError(errorText(cause, t, "pricing.opening.changeFailed"));
      return false;
    }
  };
  const close = () => {
    setAdding(false);
    setFrom(empty);
    setThrough(empty);
    setError("");
  };
  const add = () => {
    const start = monthDay(from),
      end = monthDay(through);
    if (!start || !end) {
      setError(
        errorText(
          new PricingError("pricing.steps.seasons.errorDays"),
          t,
          "pricing.opening.changeFailed",
        ),
      );
      return;
    }
    if (apply(() => addClosedPeriod(room, { from: start, through: end }))) close();
  };
  const dayField = (legend: string, value: Day, set: (value: Day) => void) => (
    <fieldset>
      <legend className="text-[12px] font-semibold text-gray-900">{legend}</legend>
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
    <StepCard title={t("pricing.opening.title")} hint={t("pricing.opening.hint")}>
      <div className="space-y-3.5 rounded-xl border border-gray-200 p-4">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-gray-900">
              {t(allYear ? "pricing.opening.allYear" : "pricing.opening.mostYear")}
            </p>
            <p className="text-[13px] text-gray-500">
              {allYear
                ? t("pricing.opening.nightsAll", { count: 365 })
                : t("pricing.opening.nights", {
                    open: Math.max(0, 365 - closedNights),
                    closed: closedNights,
                  })}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={allYear}
            aria-label={t("pricing.opening.allYear")}
            disabled={disabled}
            onClick={() =>
              allYear ? setAdding(true) : apply(() => removeClosedPeriods(room, closed))
            }
            className={ui.switchTrack(allYear)}
          >
            <span className="h-[18px] w-[18px] rounded-full bg-white shadow-sm" />
          </button>
        </div>
        {(!allYear || adding) && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[13px] text-gray-600">
              {t("pricing.opening.closedEvery")}
            </span>
            {closed.map((range) => {
              const days = `${day(range.from)} – ${day(range.through)}`;
              return (
                <span
                  key={`${range.from}-${range.through}`}
                  className="inline-flex h-[30px] items-center gap-1.5 rounded-full bg-gray-100 pl-3 pr-1.5 text-[13px] font-medium text-gray-800"
                >
                  {days}
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={t("pricing.opening.remove", { days })}
                    onClick={() => apply(() => removeClosedPeriods(room, [range]))}
                    className="rounded-full p-0.5 text-gray-500 hover:bg-gray-200 disabled:opacity-50"
                  >
                    <XMarkIcon aria-hidden="true" className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
            {!adding && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => setAdding(true)}
                className="inline-flex h-[30px] items-center gap-1 rounded-full border border-dashed border-primary-300 px-3 text-[13px] font-medium text-primary-600 disabled:opacity-50"
              >
                <PlusIcon aria-hidden="true" className="h-3 w-3" /> {t("pricing.opening.add")}
              </button>
            )}
          </div>
        )}
        {adding && (
          <div className={`space-y-3 ${ui.draftCard}`}>
            <div className="grid gap-3 sm:grid-cols-2">
              {dayField(t("pricing.opening.from"), from, setFrom)}
              {dayField(t("pricing.opening.through"), through, setThrough)}
            </div>
            <p className="text-[12px] text-gray-500">{t("pricing.opening.repeats")}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={ui.primaryButton} disabled={disabled} onClick={add}>
                {t("pricing.opening.close")}
              </button>
              <button
                type="button"
                className={ui.secondaryButton}
                disabled={disabled}
                onClick={close}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className={ui.errorText}>
            {error}
          </p>
        )}
      </div>
    </StepCard>
  );
}
