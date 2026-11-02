"use client";

import { useId, type ReactNode } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  CHECK_IN_TIMES,
  CHECK_OUT_TIMES,
  MIDNIGHT,
  arrivalDay,
  type ArrivalForm,
  type ArrivalFormCheck,
} from "./arrivalTimesForm";
import {
  checkInLabel,
  checkOutLabel,
  daySummary,
  duration,
  fieldError,
  type Translate,
} from "./arrivalTimesText";
import { Card, Chips, FieldAlert, RequiredLabel, SwitchRow, inputClass } from "./controls";

const icon = (path: string, color: string) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
);

/** Card 1, "Arrival & departure": when guests may arrive and must leave, and the day those times leave the team. */
export function TimesCard({
  form,
  check,
  timeZone,
  onChange,
}: {
  form: ArrivalForm;
  check: ArrivalFormCheck;
  /** "Central Indonesia Time (UTC+8)"; null when the property's time zone can't be read. */
  timeZone: string | null;
  onChange: (patch: Partial<ArrivalForm>) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const required = t("settings.arrivalTimes.required");
  const lateHint = !form.checkInUntilOn
    ? form.checkInTime
      ? t("settings.arrivalTimes.checkIn.untilOff", { time: form.checkInTime })
      : t("settings.arrivalTimes.checkIn.untilOffOpen")
    : form.checkInUntil === MIDNIGHT
      ? t("settings.arrivalTimes.checkIn.untilMidnight")
      : t("settings.arrivalTimes.checkIn.untilOn");
  const earlyHint = !form.checkOutFromOn
    ? form.checkOutTime
      ? t("settings.arrivalTimes.checkOut.fromOff", { time: form.checkOutTime })
      : t("settings.arrivalTimes.checkOut.fromOffOpen")
    : t("settings.arrivalTimes.checkOut.fromOn");
  return (
    <Card
      title={t("settings.arrivalTimes.times.title")}
      subtitle={t("settings.arrivalTimes.times.subtitle")}
      aside={
        timeZone && (
          <div className="flex h-[30px] items-center gap-1.5 rounded-full bg-gray-100 px-2.5 text-[13px] text-gray-700">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            {timeZone}
          </div>
        )
      }
    >
      <div className="mt-5 flex flex-wrap gap-5">
        <Window
          icon={icon("M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3", "#1E3EDB")}
          iconClass="bg-primary-50"
          title={t("settings.arrivalTimes.checkIn.title")}
          label={t("settings.arrivalTimes.checkIn.from")}
          required={required}
          fieldId={`${id}-check-in`}
          value={form.checkInTime}
          onValue={(checkInTime) => onChange({ checkInTime })}
          chipsLabel={t("settings.arrivalTimes.checkIn.chips")}
          chips={CHECK_IN_TIMES}
          switchId={`${id}-check-in-until`}
          switchTitle={t("settings.arrivalTimes.checkIn.until")}
          hint={lateHint}
          on={form.checkInUntilOn}
          onToggle={(checkInUntilOn) => onChange({ checkInUntilOn })}
          boundLabel={t("settings.arrivalTimes.checkIn.untilInput")}
          bound={form.checkInUntil}
          onBound={(checkInUntil) => onChange({ checkInUntil })}
          error={check.errors.checkInUntil && fieldError(t, check.errors.checkInUntil)}
        />
        <Window
          icon={icon("M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9", "#B45309")}
          iconClass="bg-amber-100"
          title={t("settings.arrivalTimes.checkOut.title")}
          label={t("settings.arrivalTimes.checkOut.by")}
          required={required}
          fieldId={`${id}-check-out`}
          value={form.checkOutTime}
          onValue={(checkOutTime) => onChange({ checkOutTime })}
          chipsLabel={t("settings.arrivalTimes.checkOut.chips")}
          chips={CHECK_OUT_TIMES}
          switchId={`${id}-check-out-from`}
          switchTitle={t("settings.arrivalTimes.checkOut.from")}
          hint={earlyHint}
          on={form.checkOutFromOn}
          onToggle={(checkOutFromOn) => onChange({ checkOutFromOn })}
          boundLabel={t("settings.arrivalTimes.checkOut.fromInput")}
          bound={form.checkOutFrom}
          onBound={(checkOutFrom) => onChange({ checkOutFrom })}
          error={check.errors.checkOutFrom && fieldError(t, check.errors.checkOutFrom)}
        />
      </div>
      <DayAtAGlance t={t} form={form} check={check} />
    </Card>
  );
}

function Window(props: {
  icon: ReactNode;
  iconClass: string;
  title: string;
  label: string;
  required: string;
  fieldId: string;
  value: string;
  onValue: (value: string) => void;
  chipsLabel: string;
  chips: string[];
  switchId: string;
  switchTitle: string;
  hint: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  boundLabel: string;
  bound: string;
  onBound: (value: string) => void;
  error?: string;
}) {
  return (
    <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-3 rounded-xl border border-gray-200 p-[18px]">
      <div className="flex items-center gap-2.5">
        <div
          className={`flex h-[30px] w-[30px] items-center justify-center rounded-lg ${props.iconClass}`}
        >
          {props.icon}
        </div>
        <h4 className="text-base font-semibold text-gray-900">{props.title}</h4>
      </div>
      <div className="flex flex-col gap-1.5">
        <RequiredLabel htmlFor={props.fieldId} required={props.required}>
          {props.label}
        </RequiredLabel>
        <input
          id={props.fieldId}
          type="time"
          value={props.value}
          onChange={(event) => props.onValue(event.target.value)}
          className={inputClass(props.value ? "ok" : "open")}
        />
      </div>
      <Chips
        label={props.chipsLabel}
        options={props.chips}
        value={props.value}
        onPick={props.onValue}
      />
      <div className="my-1 h-px bg-gray-200" />
      <SwitchRow
        id={props.switchId}
        title={props.switchTitle}
        hint={props.hint}
        checked={props.on}
        onChange={props.onToggle}
      />
      {props.on && (
        <div className="flex flex-col gap-1.5">
          <input
            type="time"
            aria-label={props.boundLabel}
            aria-invalid={props.error ? true : undefined}
            aria-describedby={props.error ? `${props.switchId}-error` : undefined}
            value={props.bound}
            onChange={(event) => props.onBound(event.target.value)}
            className={inputClass(props.error ? "error" : "ok")}
          />
          {props.error && <FieldAlert id={`${props.switchId}-error`}>{props.error}</FieldAlert>}
        </div>
      )}
    </div>
  );
}

const percent = (minutes: number) => `${(Math.max(minutes, 0) / (24 * 60)) * 100}%`;

function Segment({
  start,
  end,
  className,
  children,
}: {
  start: number;
  end: number;
  className: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`absolute inset-y-0 flex items-center overflow-hidden whitespace-nowrap text-xs font-semibold ${className}`}
      style={{ left: percent(start), width: percent(end - start) }}
    >
      {children}
    </div>
  );
}

function Legend({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-[3px] ${className}`} />
      {children}
    </span>
  );
}

/** "Your day at a glance": check-out, turnover and check-in on one 24-hour bar, plus the same in a sentence. */
function DayAtAGlance({
  t,
  form,
  check,
}: {
  t: Translate;
  form: ArrivalForm;
  check: ArrivalFormCheck;
}) {
  const day = arrivalDay(form, check);
  const summary = daySummary(t, day);
  return (
    <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-[18px] sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
        <div className="text-sm font-semibold text-gray-900">
          {t("settings.arrivalTimes.day.title")}
        </div>
        <div className="flex flex-wrap gap-3.5 text-xs text-gray-600">
          <Legend className="bg-amber-300">{t("settings.arrivalTimes.day.legendCheckOut")}</Legend>
          <Legend className="bg-gray-300">{t("settings.arrivalTimes.day.legendTurnover")}</Legend>
          <Legend className="bg-primary-600">{t("settings.arrivalTimes.day.legendCheckIn")}</Legend>
        </div>
      </div>
      <div
        role="img"
        aria-label={summary}
        className="relative mt-3.5 h-11 overflow-hidden rounded-[10px] border border-gray-200 bg-white"
      >
        {day.checkOut && (
          <Segment
            start={day.checkOut.start}
            end={day.checkOut.end}
            className="justify-end bg-amber-300 px-2.5 text-amber-900"
          >
            {checkOutLabel(t, day.checkOut)}
          </Segment>
        )}
        {day.checkOut && day.checkIn && day.turnover !== null && day.turnover > 0 && (
          <Segment
            start={day.checkOut.end}
            end={day.checkIn.start}
            className="justify-center bg-gray-200 px-0.5 text-gray-700"
          >
            {duration(t, day.turnover, true)}
          </Segment>
        )}
        {day.checkIn && (
          <Segment
            start={day.checkIn.start}
            end={day.checkIn.end}
            className="justify-start bg-primary-600 px-2.5 text-white"
          >
            {checkInLabel(t, day.checkIn)}
          </Segment>
        )}
      </div>
      <div aria-hidden="true" className="mt-1.5 flex justify-between text-[11px] text-gray-500">
        {["00:00", "06:00", "12:00", "18:00", "24:00"].map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
      <p className="mt-3 text-sm text-gray-700">{summary}</p>
      {day.turnover !== null && day.turnover <= 0 && (
        <p className="mt-2 text-[13px] text-amber-700">{t("settings.arrivalTimes.day.overlap")}</p>
      )}
    </div>
  );
}
