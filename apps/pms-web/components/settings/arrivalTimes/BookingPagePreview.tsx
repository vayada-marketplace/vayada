"use client";

import { useId } from "react";
import { useTranslation } from "@/lib/i18n";
import { adultAge, arrivalDay, type ArrivalForm, type ArrivalFormCheck } from "./arrivalTimesForm";
import { checkInLabel, checkOutLabel } from "./arrivalTimesText";

const valueClass = (set: boolean) => (set ? "text-gray-900" : "text-amber-700");

function Field({
  label,
  placeholder,
  tall = false,
}: {
  label: string;
  placeholder?: string;
  tall?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-gray-700">{label}</div>
      <div
        className={`flex rounded-lg border border-gray-300 px-2.5 text-xs text-gray-500 ${
          tall ? "h-[60px] items-start py-2" : "h-[34px] items-center"
        }`}
      >
        {placeholder}
      </div>
    </div>
  );
}

/** "Booking page preview" (Timo's mockup, VAY-2455): what guests see before they pay, following every edit before
 * it's saved. An illustration, so screen readers skip it: the cards say the same. */
export function BookingPagePreview({
  form,
  check,
  hotel,
}: {
  form: ArrivalForm;
  check: ArrivalFormCheck;
  /** The property's name and town; null when its profile can't be read. */
  hotel: { name: string; city: string } | null;
}) {
  const { t } = useTranslation();
  const id = useId();
  const day = arrivalDay(form, check);
  const age = adultAge(form.adultAge);
  const children = !form.children
    ? t("settings.arrivalTimes.time.notSet")
    : form.children === "no"
      ? t("settings.arrivalTimes.preview.adultsOnly")
      : age === null
        ? t("settings.arrivalTimes.preview.childrenWelcome")
        : t("settings.arrivalTimes.preview.childrenWelcomeAge", { age });
  const times: Array<[string, string, boolean]> = [
    [t("settings.arrivalTimes.preview.checkIn"), checkInLabel(t, day.checkIn), !!day.checkIn],
    [t("settings.arrivalTimes.preview.checkOut"), checkOutLabel(t, day.checkOut), !!day.checkOut],
  ];
  return (
    <aside aria-labelledby={`${id}-title`} className="min-w-0 flex-[1_1_320px]">
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 id={`${id}-title`} className="text-[15px] font-semibold text-gray-900">
            {t("settings.arrivalTimes.preview.title")}
          </h3>
          <span className="flex items-center gap-1.5 text-xs text-green-700">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            {t("settings.arrivalTimes.preview.live")}
          </span>
        </div>
        <p className="mb-4 mt-1 text-[13px] text-gray-500">
          {t("settings.arrivalTimes.preview.subtitle")}
        </p>
        <div aria-hidden="true" className="overflow-hidden rounded-xl border border-gray-200">
          {hotel && (
            <div className="border-b border-gray-200 bg-gray-50 p-4">
              <div className="text-base font-semibold text-gray-900">{hotel.name}</div>
              {hotel.city && <div className="mt-0.5 text-[13px] text-gray-500">{hotel.city}</div>}
            </div>
          )}
          <div className="flex flex-col gap-3.5 p-4">
            <div className="grid grid-cols-2 gap-2.5">
              {times.map(([label, value, set]) => (
                <div key={label} className="rounded-[10px] border border-gray-200 px-3 py-2.5">
                  <div className="text-xs text-gray-500">{label}</div>
                  <div className={`mt-0.5 text-[15px] font-semibold ${valueClass(set)}`}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-between gap-3 text-[13px]">
              <span className="text-gray-500">{t("settings.arrivalTimes.preview.children")}</span>
              <span className={`text-right font-semibold ${valueClass(!!form.children)}`}>
                {children}
              </span>
            </div>
            <div className="h-px bg-gray-200" />
            <div className="text-[13px] font-semibold text-gray-900">
              {t("settings.arrivalTimes.preview.details")}
            </div>
            <Field label={t("settings.arrivalTimes.preview.fullName")} />
            <Field label={t("settings.arrivalTimes.preview.email")} />
            <Field
              label={
                form.phoneRequired
                  ? t("settings.arrivalTimes.preview.phoneRequired")
                  : t("settings.arrivalTimes.preview.phoneOptional")
              }
            />
            {form.arrivalTimeEnabled && (
              <Field
                label={t("settings.arrivalTimes.preview.arrival")}
                placeholder={
                  form.checkInTime
                    ? t("settings.arrivalTimes.preview.arrivalPlaceholder", {
                        time: form.checkInTime,
                      })
                    : t("settings.arrivalTimes.preview.arrivalPlaceholderOpen")
                }
              />
            )}
            {form.specialRequestsEnabled && (
              <Field
                label={t("settings.arrivalTimes.preview.requests")}
                placeholder={t("settings.arrivalTimes.preview.requestsPlaceholder")}
                tall
              />
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
