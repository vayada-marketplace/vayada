"use client";

import { useId, useState, type ReactNode } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { NationalitySelect } from "@/components/NationalitySelect";
import type { GuestDocumentType, GuestGender } from "@/services/bookings";
import type { CheckinGuestField, CheckinSettings } from "@/services/settings";
import { guestRegistrationStatus, type GuestRegistrationStatus } from "@/lib/checkin/registration";
import type { CheckinRoom } from "@/lib/checkin/rooms";
import { guestFieldLabel } from "@/lib/settings/checkinSettings";
import { useTranslation } from "@/lib/i18n";
import { checkinPrimaryButton, checkinSecondaryButton } from "./CheckinStepCard";

export type GuestLockableField = "firstName" | "lastName" | "email" | "phone" | "nationality";

export interface GuestFormValues {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  nationality: string;
  dateOfBirth: string;
  documentType: GuestDocumentType | "";
  documentNumber: string;
  gender: GuestGender | "";
  staffNotes: string;
  assignmentId: string | null;
}

const DOCUMENT_TYPES: GuestDocumentType[] = ["passport", "national_id", "driving_licence", "other"];
const GENDERS: GuestGender[] = ["female", "male", "other", "prefer_not_to_say"];
/** Recorded on the guest's registration rather than the booking's guest list (VAY-2373 D1). */
const REGISTRATION_FIELDS: CheckinGuestField[] = [
  "dateOfBirth",
  "documentType",
  "documentNumber",
  "gender",
];

export function filledRegistrationFields(values: GuestFormValues): string[] {
  return (
    ["dateOfBirth", "documentType", "documentNumber", "gender", "staffNotes"] as const
  ).filter((field) => values[field].trim().length > 0);
}

export const statusTone: Record<GuestRegistrationStatus, string> = {
  registered: "text-green-700",
  id_missing: "text-amber-700",
  details_missing: "text-amber-700",
};

/** The guest's details as Settings → Check-in asks for them (VAY-2373). Laptop: inline under the
 * guest; phone: its own screen, Save returns to the list. */
export function GuestForm({
  title,
  initial,
  settings,
  rooms,
  lockedFields,
  canReadIdentity,
  savedFilledFields,
  saving,
  error,
  onSave,
  onCancel,
}: {
  title: string;
  initial: GuestFormValues;
  settings: CheckinSettings;
  rooms: CheckinRoom[];
  /** Name and contact taken from the booking or an OTA import. */
  lockedFields: ReadonlySet<GuestLockableField>;
  canReadIdentity: boolean;
  /** The registration fields on record; the status uses them when the ID fields are hidden. */
  savedFilledFields: readonly string[];
  saving: boolean;
  error: string | null;
  onSave: (values: GuestFormValues) => void;
  onCancel: () => void;
}) {
  const { locale, t } = useTranslation();
  const formId = useId();
  const [values, setValues] = useState(initial);
  const set = (patch: Partial<GuestFormValues>) =>
    setValues((current) => ({ ...current, ...patch }));
  const { status, missing } = guestRegistrationStatus(
    values,
    canReadIdentity ? filledRegistrationFields(values) : savedFilledFields,
    settings,
  );
  const fieldLabel = (field: CheckinGuestField | "firstName" | "lastName") =>
    t(`settings.checkIn.field.${field}`);
  const shown = settings.guestFields.filter(
    (entry) => entry.show && (canReadIdentity || !REGISTRATION_FIELDS.includes(entry.field)),
  );
  const required = (field: CheckinGuestField) =>
    settings.guestFields.some((entry) => entry.field === field && entry.required);
  const statusLabel = t(`checkIn.flow.status.${status}`);

  const field = (name: CheckinGuestField): ReactNode => {
    const label = guestFieldLabel(name, t);
    const inputClass =
      "mt-1 h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100 disabled:bg-gray-100 disabled:text-gray-500";
    const caption = (
      <span className="text-sm font-semibold text-gray-700">
        {label}
        {required(name) && <span className="text-red-600"> *</span>}
      </span>
    );
    switch (name) {
      case "nationality":
        return (
          <NationalitySelect
            label={required(name) ? `${label} *` : label}
            value={values.nationality}
            disabled={lockedFields.has("nationality")}
            onChange={(nationality) => set({ nationality })}
          />
        );
      case "documentType":
      case "gender": {
        const options = name === "documentType" ? DOCUMENT_TYPES : GENDERS;
        return (
          <label className="block">
            {caption}
            <select
              value={values[name]}
              onChange={(event) => set({ [name]: event.target.value } as Partial<GuestFormValues>)}
              className={inputClass}
            >
              <option value="">{t("checkIn.flow.form.choose")}</option>
              {options.map((option) => (
                <option key={option} value={option}>
                  {t(`checkIn.flow.${name === "documentType" ? "document" : "gender"}.${option}`)}
                </option>
              ))}
            </select>
          </label>
        );
      }
      default: {
        const locked = (name === "email" || name === "phone") && lockedFields.has(name);
        const key = name as "email" | "phone" | "dateOfBirth" | "documentNumber";
        return (
          <label className="block">
            {caption}
            <input
              type={
                name === "email"
                  ? "email"
                  : name === "phone"
                    ? "tel"
                    : name === "dateOfBirth"
                      ? "date"
                      : "text"
              }
              value={values[key]}
              disabled={locked}
              max={name === "dateOfBirth" ? new Date().toISOString().slice(0, 10) : undefined}
              maxLength={name === "documentNumber" ? 64 : undefined}
              placeholder={
                name === "documentNumber"
                  ? t("checkIn.flow.form.documentNumberPlaceholder")
                  : required(name)
                    ? undefined
                    : t("checkIn.flow.form.optional")
              }
              onChange={(event) => set({ [key]: event.target.value } as Partial<GuestFormValues>)}
              className={inputClass}
            />
          </label>
        );
      }
    }
  };

  const nameInput = (name: "firstName" | "lastName") => (
    <label className="block">
      <span className="text-sm font-semibold text-gray-700">
        {fieldLabel(name)}
        <span className="text-red-600"> *</span>
      </span>
      <input
        value={values[name]}
        disabled={lockedFields.has(name)}
        onChange={(event) => set({ [name]: event.target.value } as Partial<GuestFormValues>)}
        className="mt-1 h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100 disabled:bg-gray-100 disabled:text-gray-500"
      />
    </label>
  );

  return (
    <form
      id={formId}
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(values);
      }}
      className="fixed inset-0 z-40 flex flex-col overflow-y-auto bg-white md:static md:z-auto md:overflow-visible md:border-t md:border-gray-200 md:bg-gray-50"
    >
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 md:hidden">
        <button
          type="button"
          onClick={onCancel}
          aria-label={t("common.cancel")}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-900"
        >
          <ArrowLeftIcon className="h-5 w-5" aria-hidden="true" />
        </button>
        <p className="min-w-0 flex-1 truncate text-lg font-bold text-gray-900">{title}</p>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
            status === "registered" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-800"
          }`}
        >
          {statusLabel}
        </span>
      </div>

      <div className="flex flex-col gap-5 px-4 py-5 md:px-5">
        <div className="grid gap-4 md:grid-cols-4">
          {nameInput("firstName")}
          {nameInput("lastName")}
          {shown.map((entry) => (
            <div key={entry.field}>{field(entry.field)}</div>
          ))}
        </div>
        {!canReadIdentity && (
          <p className="text-sm text-gray-600">{t("checkIn.flow.form.identityHidden")}</p>
        )}

        {canReadIdentity && rooms.length > 1 && (
          <fieldset>
            <legend className="text-sm font-semibold text-gray-700">
              {t("checkIn.flow.form.sleepsIn")}
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {rooms.map((room) => {
                const on = values.assignmentId === room.assignmentId;
                return (
                  <button
                    key={room.key}
                    type="button"
                    aria-pressed={on}
                    disabled={!room.assignmentId}
                    onClick={() => set({ assignmentId: room.assignmentId })}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${
                      on
                        ? "bg-primary-50 text-primary-800 shadow-[inset_0_0_0_2px] shadow-primary-600"
                        : "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
                    }`}
                  >
                    {room.unit ? t("dashboard.popup.roomNumber", { number: room.unit }) : room.type}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {canReadIdentity && settings.guestNotes && (
          <label className="block">
            <span className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              {t("checkIn.flow.form.notes")}
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                {t("checkIn.flow.form.staffOnly")}
              </span>
            </span>
            <textarea
              value={values.staffNotes}
              maxLength={2000}
              rows={3}
              placeholder={t("checkIn.flow.form.notesPlaceholder")}
              onChange={(event) => set({ staffNotes: event.target.value })}
              className="mt-1 w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>
        )}

        {status !== "registered" && (
          <p className="text-sm text-amber-700">
            {t("checkIn.flow.form.stillMissing", {
              fields: new Intl.ListFormat(locale, { type: "conjunction" }).format(
                missing.map((name) => fieldLabel(name)),
              ),
              status: statusLabel,
            })}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm font-medium text-red-700">
            {error}
          </p>
        )}
      </div>

      <div className="sticky bottom-0 mt-auto grid grid-cols-2 gap-3 border-t border-gray-200 bg-white px-4 py-4 md:static md:flex md:border-0 md:bg-transparent md:px-5 md:pb-5 md:pt-0">
        <button type="button" onClick={onCancel} className={`${checkinSecondaryButton} md:order-2`}>
          {t("common.cancel")}
        </button>
        <button type="submit" disabled={saving} className={`${checkinPrimaryButton} md:order-1`}>
          {saving ? t("common.saving") : t("checkIn.flow.form.save")}
        </button>
      </div>
    </form>
  );
}
