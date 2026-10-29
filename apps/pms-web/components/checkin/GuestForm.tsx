"use client";

import { useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { ArrowLeftIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { nationalityLabel } from "@vayada/locale-constants";
import { NationalitySelect } from "@/components/NationalitySelect";
import type { GuestDocumentType, GuestGender } from "@/services/bookings";
import type { CheckinGuestField, CheckinSettings } from "@/services/settings";
import { guestRegistrationStatus, type GuestRegistrationStatus } from "@/lib/checkin/registration";
import type { CheckinRoom } from "@/lib/checkin/rooms";
import {
  BIRTH_DATE_PLACEHOLDER,
  birthDateInput,
  birthDateText,
  parseBirthDate,
} from "@/lib/checkin/birthDate";
import { guestChanges } from "@/lib/checkin/guestAutosave";
import { guestFieldLabel } from "@/lib/settings/checkinSettings";
import { useTranslation } from "@/lib/i18n";
import { localizedErrorText } from "@/lib/i18n/localizedErrorText";
import { checkinPrimaryButton } from "./CheckinStepCard";

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
/** One label and one input style for every field (VAY-2418). */
const LABEL_CLASS = "text-[13px] font-semibold text-gray-700";
const INPUT_CLASS =
  "mt-1 h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100";

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

const today = () => new Date().toISOString().slice(0, 10);

/** The guest's details as Settings → Check-in asks for them (VAY-2373). Laptop: inline under the
 * guest; phone: its own screen. Each field saves when it loses focus; a guest nobody has entered
 * yet is listed on Done or when staff leave the step, not while they type (VAY-2418). */
export function GuestForm({
  title,
  initial,
  guestId,
  requireNames,
  settings,
  rooms,
  lockedFields: lockedOnOpen,
  canReadIdentity,
  savedFilledFields,
  onSave,
  flush,
  onUnsaved,
  onDone,
}: {
  title: string;
  initial: GuestFormValues;
  /** Null for a guest nobody has entered yet. */
  guestId: string | null;
  /** Everyone but the booker needs both names to be listed. */
  requireNames: boolean;
  settings: CheckinSettings;
  rooms: CheckinRoom[];
  /** Values staff can't change here: an OTA import's, or the booker's when their guest record
   * can't be reached. */
  lockedFields: ReadonlySet<GuestLockableField>;
  canReadIdentity: boolean;
  /** The registration fields on record; the status uses them when the ID fields are hidden. */
  savedFilledFields: readonly string[];
  /** Saves what changed since `saved`; `listed` gets a new guest's id as soon as it is listed. */
  onSave: (
    values: GuestFormValues,
    saved: GuestFormValues,
    guestId: string | null,
    listed: (id: string) => void,
  ) => Promise<void>;
  /** Set to this form's save while it is open: resolves false when something stays unsaved. */
  flush: MutableRefObject<(() => Promise<boolean>) | null>;
  /** True while a save failed or a value can't be saved yet. */
  onUnsaved: (unsaved: boolean) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  // The date of birth is held as typed ("23 / 06 / 1912"); everything else as saved.
  const [values, setValues] = useState(() => ({
    ...initial,
    dateOfBirth: birthDateText(initial.dateOfBirth),
  }));
  const typed = useRef(values);
  const saved = useRef(initial);
  const savedGuestId = useRef(guestId);
  // What came with the booking when the form opened: a value staff fill in now stays editable.
  const [lockedFields] = useState(lockedOnOpen);
  const queue = useRef(Promise.resolve(true));
  /** "creating" while a new guest is being listed. */
  const [saving, setSaving] = useState<null | "saving" | "creating">(null);
  const [problem, setProblem] = useState<{
    text: string;
    retry?: boolean;
    birthDate?: boolean;
  } | null>(null);

  const set = (patch: Partial<GuestFormValues>) => {
    typed.current = { ...typed.current, ...patch };
    setValues(typed.current);
  };

  /** Saves what changed since the last save, one save at a time. An unfinished date of birth
   * isn't sent: the registration keeps the saved one. */
  const save = () => {
    queue.current = queue.current.then(async () => {
      const birthDate = parseBirthDate(typed.current.dateOfBirth, today());
      const next = { ...typed.current, dateOfBirth: birthDate ?? saved.current.dateOfBirth };
      const { contact, registration } = guestChanges(saved.current, next);
      if (contact.length || registration) {
        // The booker can't have a name emptied, but a channel booker without a last name still
        // saves the rest.
        const blankName = (["firstName", "lastName"] as const).some(
          (name) => !next[name].trim() && (requireNames || contact.includes(name)),
        );
        if (blankName) {
          setProblem({ text: t("checkIn.flow.form.namesRequired") });
          return false;
        }
        setSaving(savedGuestId.current === null ? "creating" : "saving");
        try {
          await onSave(next, saved.current, savedGuestId.current, (id) => {
            // The guest list has the names and contact now, even if the registration fails next.
            savedGuestId.current = id;
            const { firstName, lastName, email, phone, nationality } = next;
            saved.current = { ...saved.current, firstName, lastName, email, phone, nationality };
          });
          saved.current = next;
        } catch (err) {
          setProblem({
            text: localizedErrorText(err, t("checkIn.flow.form.saveError"), t),
            retry: true,
          });
          return false;
        } finally {
          setSaving(null);
        }
      }
      if (birthDate === null) {
        setProblem({ text: t("checkIn.flow.form.birthDateInvalid"), birthDate: true });
        return false;
      }
      setProblem(null);
      return true;
    });
    return queue.current;
  };

  useEffect(() => {
    flush.current = save;
    return () => {
      flush.current = null;
    };
  });
  useEffect(() => onUnsaved(problem !== null), [problem, onUnsaved]);
  useEffect(() => () => onUnsaved(false), [onUnsaved]);

  const birthDate = parseBirthDate(values.dateOfBirth, today());
  const current = { ...values, dateOfBirth: birthDate ?? "" };
  const { status } = guestRegistrationStatus(
    current,
    canReadIdentity ? filledRegistrationFields(current) : savedFilledFields,
    settings,
  );
  const shown = settings.guestFields.filter(
    (entry) => entry.show && (canReadIdentity || !REGISTRATION_FIELDS.includes(entry.field)),
  );
  const required = (field: CheckinGuestField) =>
    settings.guestFields.some((entry) => entry.field === field && entry.required);
  const statusLabel = t(`checkIn.flow.status.${status}`);

  const caption = (label: string, isRequired: boolean) => (
    <span className={LABEL_CLASS}>
      {label}
      {isRequired && <span className="text-red-600"> *</span>}
    </span>
  );
  /** A value from the booking: shown as it is, on white, with a lock under it (VAY-2418). */
  const lockedInput = (label: string, isRequired: boolean, value: string) => (
    <label className="block">
      {caption(label, isRequired)}
      <input
        value={value}
        readOnly
        className={`${INPUT_CLASS} cursor-default focus:border-gray-300 focus:ring-0`}
      />
      <span className="mt-1 flex items-center gap-1 text-xs text-gray-500">
        <LockClosedIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("checkIn.flow.form.fromBooking")}
      </span>
    </label>
  );

  const field = (name: CheckinGuestField): ReactNode => {
    const label = guestFieldLabel(name, t);
    switch (name) {
      case "nationality":
        return lockedFields.has("nationality") ? (
          lockedInput(
            label,
            required(name),
            nationalityLabel(values.nationality) ?? values.nationality,
          )
        ) : (
          <NationalitySelect
            label={caption(label, required(name))}
            value={values.nationality}
            onChange={(nationality) => set({ nationality })}
            labelClassName="block"
            inputClassName={INPUT_CLASS}
          />
        );
      case "documentType":
      case "gender": {
        const options = name === "documentType" ? DOCUMENT_TYPES : GENDERS;
        return (
          <label className="block">
            {caption(label, required(name))}
            <select
              value={values[name]}
              onChange={(event) => set({ [name]: event.target.value } as Partial<GuestFormValues>)}
              className={INPUT_CLASS}
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
      case "dateOfBirth": {
        const invalid = problem?.birthDate === true;
        return (
          <label className="block">
            {caption(label, required(name))}
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={values.dateOfBirth}
              placeholder={BIRTH_DATE_PLACEHOLDER}
              aria-invalid={invalid || undefined}
              onChange={(event) => set({ dateOfBirth: birthDateInput(event.target.value) })}
              className={`${INPUT_CLASS} ${invalid ? "border-red-500" : ""}`}
            />
          </label>
        );
      }
      default: {
        const key = name as "email" | "phone" | "documentNumber";
        if ((key === "email" || key === "phone") && lockedFields.has(key))
          return lockedInput(label, required(name), values[key]);
        return (
          <label className="block">
            {caption(label, required(name))}
            <input
              type={key === "email" ? "email" : key === "phone" ? "tel" : "text"}
              value={values[key]}
              maxLength={key === "documentNumber" ? 64 : undefined}
              placeholder={
                key === "documentNumber"
                  ? t("checkIn.flow.form.documentNumberPlaceholder")
                  : required(name)
                    ? undefined
                    : t("checkIn.flow.form.optional")
              }
              onChange={(event) => set({ [key]: event.target.value } as Partial<GuestFormValues>)}
              className={INPUT_CLASS}
            />
          </label>
        );
      }
    }
  };

  const nameInput = (name: "firstName" | "lastName") =>
    lockedFields.has(name) ? (
      lockedInput(t(`settings.checkIn.field.${name}`), true, values[name])
    ) : (
      <label className="block">
        {caption(t(`settings.checkIn.field.${name}`), true)}
        <input
          value={values[name]}
          onChange={(event) => set({ [name]: event.target.value } as Partial<GuestFormValues>)}
          className={INPUT_CLASS}
        />
      </label>
    );

  return (
    <form
      id={formId}
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onBlur={() => {
        // A guest nobody has entered yet is listed on Done or when staff leave the step.
        if (savedGuestId.current !== null) void save();
      }}
      className="fixed inset-0 z-40 flex flex-col overflow-y-auto bg-white md:static md:z-auto md:overflow-visible md:border-t md:border-gray-200 md:bg-gray-50"
    >
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 md:hidden">
        <button
          type="button"
          onClick={onDone}
          aria-label={t("checkIn.flow.guests.done")}
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

      {/* A new guest's fields wait while the guest is being listed. */}
      <fieldset disabled={saving === "creating"} className="flex flex-col gap-5 px-4 py-5 md:px-5">
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
            <legend className={LABEL_CLASS}>{t("checkIn.flow.form.sleepsIn")}</legend>
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
            <span className={`flex items-center gap-2 ${LABEL_CLASS}`}>
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

        {problem ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {problem.text}
            {problem.retry && (
              <button
                type="button"
                onClick={() => void save()}
                className="ml-2 font-semibold underline hover:text-red-800"
              >
                {t("checkIn.flow.form.retry")}
              </button>
            )}
          </p>
        ) : (
          <p className="text-sm text-gray-500">
            {saving
              ? t("common.saving")
              : guestId === null
                ? t("checkIn.flow.form.addedOnDone")
                : t("checkIn.flow.form.autosave")}
          </p>
        )}
      </fieldset>

      <div className="sticky bottom-0 mt-auto border-t border-gray-200 bg-white px-4 py-4 md:hidden">
        <button type="button" onClick={onDone} className={`${checkinPrimaryButton} w-full`}>
          {t("checkIn.flow.guests.done")}
        </button>
      </div>
    </form>
  );
}
