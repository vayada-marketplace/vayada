"use client";

import { useId } from "react";
import type { BookingGuestLanguage } from "@vayada/domain-booking";
import { useTranslation } from "@/lib/i18n";
import {
  ADULT_AGES,
  MAX_ADULT_AGE,
  adultAge,
  ageCounts,
  type ArrivalForm,
  type ArrivalFormCheck,
} from "./arrivalTimesForm";
import { fieldError } from "./arrivalTimesText";
import { Card, Chips, FieldAlert, RequiredLabel, SwitchRow, inputClass } from "./controls";

/** Each language the guest rules accept, in its own name. */
export const GUEST_LANGUAGE_NAMES: Record<BookingGuestLanguage, string> = {
  en: "English",
  id: "Bahasa Indonesia",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  nl: "Nederlands",
};

/** Card 2, "Guests": the guest language, whether children may stay and from which age a guest is an adult. The age
 * only matters while children are welcome: the guest rules keep none for adults-only hotels. */
export function GuestsCard({
  form,
  check,
  onChange,
}: {
  form: ArrivalForm;
  check: ArrivalFormCheck;
  onChange: (patch: Partial<ArrivalForm>) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const required = t("settings.arrivalTimes.required");
  const age = adultAge(form.adultAge);
  const ageError = check.errors.adultAge;
  const children = [
    {
      value: "yes" as const,
      title: t("settings.arrivalTimes.guests.childrenYes"),
      text: t("settings.arrivalTimes.guests.childrenYesText"),
    },
    {
      value: "no" as const,
      title: t("settings.arrivalTimes.guests.childrenNo"),
      text: t("settings.arrivalTimes.guests.childrenNoText"),
    },
  ];
  return (
    <Card
      title={t("settings.arrivalTimes.guests.title")}
      subtitle={t("settings.arrivalTimes.guests.subtitle")}
    >
      <div className="mt-[22px] flex flex-col gap-[22px]">
        <div className="flex flex-col gap-1.5">
          <RequiredLabel htmlFor={`${id}-language`} required={required}>
            {t("settings.arrivalTimes.guests.language")}
          </RequiredLabel>
          <select
            id={`${id}-language`}
            value={form.language}
            onChange={(event) =>
              onChange({ language: event.target.value as ArrivalForm["language"] })
            }
            className={`${inputClass(form.language ? "ok" : "open")} max-w-[360px]`}
          >
            <option value="">{t("settings.arrivalTimes.guests.languageChoose")}</option>
            {(Object.keys(GUEST_LANGUAGE_NAMES) as BookingGuestLanguage[]).map((language) => (
              <option key={language} value={language}>
                {GUEST_LANGUAGE_NAMES[language]}
              </option>
            ))}
          </select>
          <div className="text-[13px] text-gray-500">
            {t("settings.arrivalTimes.guests.languageHelp")}
          </div>
        </div>
        <fieldset className="flex flex-col">
          <legend className="mb-2.5 text-sm font-medium text-gray-700">
            {t("settings.arrivalTimes.guests.children")}{" "}
            <span className="font-normal text-gray-500">· {required}</span>
          </legend>
          <div className="flex flex-wrap gap-2.5">
            {children.map((option) => {
              const on = form.children === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex flex-[1_1_180px] cursor-pointer items-start gap-3 rounded-xl border px-4 py-3.5 ${
                    on
                      ? "border-primary-600 bg-primary-50 ring-1 ring-primary-600"
                      : form.children
                        ? "border-gray-300 bg-white"
                        : "border-amber-500 bg-white"
                  }`}
                >
                  <input
                    type="radio"
                    name={`${id}-children`}
                    value={option.value}
                    checked={on}
                    onChange={() => onChange({ children: option.value })}
                    className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-primary-600"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-semibold text-gray-900">{option.title}</span>
                    <span className="text-[13px] leading-[18px] text-gray-500">{option.text}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {ageCounts(form) && (
          <div className="flex flex-col gap-2">
            <RequiredLabel htmlFor={`${id}-age`} required={required}>
              {t("settings.arrivalTimes.guests.age")}
            </RequiredLabel>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
              <div className="flex items-center gap-2.5">
                <input
                  id={`${id}-age`}
                  type="number"
                  min={1}
                  max={MAX_ADULT_AGE}
                  step={1}
                  inputMode="numeric"
                  value={form.adultAge}
                  onChange={(event) => onChange({ adultAge: event.target.value })}
                  aria-describedby={`${id}-age-hint`}
                  aria-invalid={ageError ? true : undefined}
                  className={`${inputClass(ageError ? "error" : form.adultAge.trim() ? "ok" : "open")} !w-[88px] text-center`}
                />
                <span className="text-sm text-gray-600">
                  {t("settings.arrivalTimes.guests.ageSuffix")}
                </span>
              </div>
              <Chips
                label={t("settings.arrivalTimes.guests.ageChips")}
                options={ADULT_AGES}
                value={form.adultAge.trim()}
                onPick={(value) => onChange({ adultAge: value })}
              />
            </div>
            <div id={`${id}-age-hint`} className="text-[13px] leading-[18px] text-gray-500">
              {age === null
                ? t("settings.arrivalTimes.guests.ageHint")
                : t("settings.arrivalTimes.guests.ageHintChildren", { age })}
            </div>
            {ageError && <FieldAlert>{fieldError(t, ageError)}</FieldAlert>}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Card 3, "Booking form": what guests fill in when they book. */
export function BookingFormCard({
  form,
  onChange,
}: {
  form: ArrivalForm;
  onChange: (patch: Partial<ArrivalForm>) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const rows = [
    {
      key: "phoneRequired" as const,
      title: t("settings.arrivalTimes.form.phone"),
      hint: t("settings.arrivalTimes.form.phoneText"),
    },
    {
      key: "arrivalTimeEnabled" as const,
      title: t("settings.arrivalTimes.form.arrival"),
      hint: t("settings.arrivalTimes.form.arrivalText"),
    },
    {
      key: "specialRequestsEnabled" as const,
      title: t("settings.arrivalTimes.form.requests"),
      hint: t("settings.arrivalTimes.form.requestsText"),
    },
  ];
  return (
    <Card
      title={t("settings.arrivalTimes.form.title")}
      subtitle={t("settings.arrivalTimes.form.subtitle")}
      className="!pb-2"
    >
      <div className="mt-2">
        {rows.map((row) => (
          <SwitchRow
            key={row.key}
            id={`${id}-${row.key}`}
            title={row.title}
            hint={row.hint}
            checked={form[row.key]}
            onChange={(next) => onChange({ [row.key]: next } as Partial<ArrivalForm>)}
            className="border-t border-gray-200 py-3.5"
            large
          />
        ))}
      </div>
    </Card>
  );
}
