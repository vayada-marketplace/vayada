"use client";

import type { BookingGuestPolicyChoices } from "@vayada/domain-booking";
import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";
import {
  arrivalDay,
  canSave,
  checkForm,
  formFromChoices,
  type ArrivalFormCheck,
  type ArrivalSaveStatus,
} from "./arrivalTimesForm";
import { checkInLabel, checkOutLabel } from "./arrivalTimesText";
import { GUEST_LANGUAGE_NAMES } from "./GuestsCard";

/** Shown until the property has guest rules: how many required settings are chosen. */
export function SetupBanner({ check }: { check: ArrivalFormCheck }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-[14px] border border-primary-200 bg-primary-50 px-5 py-[18px]">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-white">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#1E3EDB"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 11l3 3 8-8" />
          <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
        </svg>
      </div>
      <div className="min-w-0 flex-[1_1_240px]">
        <div className="text-[15px] font-semibold text-gray-900">
          {t("settings.arrivalTimes.banner.title")}
        </div>
        <div className="mt-0.5 text-sm leading-5 text-gray-700">
          {t("settings.arrivalTimes.banner.text")}
        </div>
      </div>
      <div className="flex flex-[0_1_220px] flex-col gap-2">
        <div className="text-[13px] font-semibold text-primary-700">
          {t("settings.arrivalTimes.banner.progress", {
            done: check.done,
            total: check.required,
          })}
        </div>
        <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-white">
          <div
            className="h-full rounded-full bg-primary-600 transition-[width]"
            style={{ width: `${(check.done / check.required) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}

const DOTS: Record<ArrivalSaveStatus, string> = {
  missing: "bg-amber-500",
  invalid: "bg-red-600",
  dirty: "bg-primary-600",
  ready: "bg-primary-600",
  saved: "bg-green-500",
  clean: "bg-green-500",
};

export function SaveBar({
  status,
  missing,
  dirty,
  onDiscard,
  onReview,
}: {
  status: ArrivalSaveStatus;
  missing: number;
  dirty: boolean;
  onDiscard: () => void;
  onReview: () => void;
}) {
  const { t } = useTranslation();
  const text = {
    missing:
      missing === 1
        ? t("settings.arrivalTimes.status.missingOne")
        : t("settings.arrivalTimes.status.missingOther", { count: missing }),
    invalid: t("settings.arrivalTimes.status.invalid"),
    dirty: t("settings.arrivalTimes.status.dirty"),
    ready: t("settings.arrivalTimes.status.ready"),
    saved: t("settings.arrivalTimes.status.saved"),
    clean: t("settings.arrivalTimes.status.clean"),
  }[status];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 rounded-[14px] border border-gray-200 bg-white px-4 py-3.5 shadow-[0_4px_16px_rgba(16,24,40,0.06)] sm:px-5">
      <div role="status" className="flex items-center gap-2.5 text-sm text-gray-700">
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOTS[status]}`} />
        {text}
      </div>
      <div className="flex flex-wrap gap-2.5">
        <button
          type="button"
          disabled={!dirty}
          onClick={onDiscard}
          className="h-11 rounded-[10px] border border-gray-300 bg-white px-[18px] text-[15px] font-medium text-gray-700 disabled:cursor-not-allowed disabled:text-gray-400"
        >
          {t("settings.arrivalTimes.discard")}
        </button>
        <button
          type="button"
          disabled={!canSave(status)}
          onClick={onReview}
          className="h-11 rounded-[10px] bg-primary-600 px-[18px] text-[15px] font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-primary-300"
        >
          {t("settings.arrivalTimes.review")}
        </button>
      </div>
    </div>
  );
}

/** What guests will see, row by row, before it's saved. */
export function ReviewDialog({
  choices,
  saving,
  onBack,
  onConfirm,
}: {
  choices: BookingGuestPolicyChoices;
  saving: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const form = formFromChoices(choices);
  const day = arrivalDay(form, checkForm(form));
  const rows: Array<[string, string]> = [
    [t("settings.arrivalTimes.dialog.checkIn"), checkInLabel(t, day.checkIn)],
    [t("settings.arrivalTimes.dialog.checkOut"), checkOutLabel(t, day.checkOut)],
    [
      t("settings.arrivalTimes.dialog.language"),
      GUEST_LANGUAGE_NAMES[choices.defaultGuestLanguage],
    ],
    [
      t("settings.arrivalTimes.dialog.children"),
      choices.childrenEnabled
        ? t("settings.arrivalTimes.dialog.yes")
        : t("settings.arrivalTimes.dialog.no"),
    ],
    ...(choices.childrenEnabled && choices.adultAgeThreshold !== null
      ? [
          [
            t("settings.arrivalTimes.dialog.age"),
            t("settings.arrivalTimes.dialog.ageValue", { age: choices.adultAgeThreshold }),
          ] as [string, string],
        ]
      : []),
    [
      t("settings.arrivalTimes.dialog.phone"),
      choices.phoneRequired
        ? t("settings.arrivalTimes.dialog.required")
        : t("settings.arrivalTimes.dialog.optional"),
    ],
    [
      t("settings.arrivalTimes.dialog.arrival"),
      choices.arrivalTimeEnabled
        ? t("settings.arrivalTimes.dialog.asked")
        : t("settings.arrivalTimes.dialog.notAsked"),
    ],
    [
      t("settings.arrivalTimes.dialog.requests"),
      choices.specialRequestsEnabled
        ? t("settings.arrivalTimes.dialog.allowed")
        : t("settings.arrivalTimes.dialog.notAllowed"),
    ],
  ];
  return (
    <Modal
      onClose={() => !saving && onBack()}
      maxWidth="lg"
      ariaLabel={t("settings.arrivalTimes.dialog.title")}
    >
      <h2 className="text-xl font-semibold text-gray-900">
        {t("settings.arrivalTimes.dialog.title")}
      </h2>
      <p className="mb-[18px] mt-1.5 text-sm text-gray-600">
        {t("settings.arrivalTimes.dialog.text")}
      </p>
      <dl className="overflow-hidden rounded-xl border border-gray-200">
        {rows.map(([label, value], index) => (
          <div
            key={label}
            className={`flex justify-between gap-4 px-4 py-3 ${index ? "border-t border-gray-200" : ""}`}
          >
            <dt className="text-sm text-gray-500">{label}</dt>
            <dd className="text-right text-sm font-medium text-gray-900">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-[22px] flex flex-wrap justify-end gap-2.5">
        <button
          type="button"
          disabled={saving}
          onClick={onBack}
          className="h-11 rounded-[10px] border border-gray-300 bg-white px-[18px] text-[15px] font-medium text-gray-700 disabled:opacity-50"
        >
          {t("settings.arrivalTimes.dialog.back")}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onConfirm}
          className="h-11 rounded-[10px] bg-primary-600 px-[18px] text-[15px] font-semibold text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {saving
            ? t("settings.arrivalTimes.dialog.saving")
            : t("settings.arrivalTimes.dialog.confirm")}
        </button>
      </div>
    </Modal>
  );
}
