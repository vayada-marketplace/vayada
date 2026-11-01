"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import CountryPicker, { NATIONALITY_PICKER_OPTIONS } from "@/components/CountryPicker";
import { useTranslation } from "@/lib/i18n";

/** What staff type on a guest card other than the lead guest's; a child's age belongs to its stay. */
export type GuestDraft = { firstName: string; lastName: string; countryCode: string };
export const EMPTY_GUEST: GuestDraft = { firstName: "", lastName: "", countryCode: "" };

/** One card per guest the stays count, in room order, adults before children; the lead guest is
 * room 1's first adult. A guest isn't tied to a room (check-in seats them), but a child's age prices
 * its own room, so every child of every room has a card. */
export type GuestSlot = { id: string; stayIndex: number; child: number | null; number: number };

export function guestSlots(stays: { key: number; adults: number; childAges: string[] }[]) {
  const slots: GuestSlot[] = [];
  const add = (id: string, stayIndex: number, child: number | null) =>
    // The booker is guest 1, so the first card is guest 2, as on check-in (VAY-2364).
    slots.push({ id, stayIndex, child, number: slots.length + 2 });
  stays.forEach((stay, stayIndex) => {
    const adults = Number.isInteger(stay.adults) ? stay.adults : 0;
    for (let adult = stayIndex === 0 ? 1 : 0; adult < adults; adult++)
      add(`${stay.key}:a${adult}`, stayIndex, null);
    stay.childAges.forEach((_, child) => add(`${stay.key}:c${child}`, stayIndex, child));
  });
  return slots;
}

export const guestNamed = (draft: GuestDraft | undefined) =>
  Boolean(draft?.firstName.trim() && draft.lastName.trim());

/** The name a started card still needs: a guest is saved with both names or not at all. */
export function guestMissingName(draft: GuestDraft | undefined): "firstName" | "lastName" | null {
  if (!draft || guestNamed(draft)) return null;
  if (!draft.firstName.trim() && !draft.lastName.trim() && !draft.countryCode) return null;
  return draft.firstName.trim() ? "lastName" : "firstName";
}

type Props = {
  stays: { key: number; adults: number; childAges: string[] }[];
  drafts: Record<string, GuestDraft>;
  onDraft: (id: string, patch: Partial<GuestDraft>) => void;
  /** The lead guest's fields, shown as guest 1. */
  lead: ReactNode;
  leadCountry: string;
  /** A child's age field; the stay keeps the ages because offers price children by them. */
  childAge: (stayIndex: number, child: number) => ReactNode;
  suggestedCountries: readonly string[];
  /** Set to a new object to focus a name the card still needs. */
  focus: { id: string; field: "firstName" | "lastName" } | null;
  inputClass: string;
  labelClass: string;
};

export default function GuestCards({
  stays,
  drafts,
  onDraft,
  lead,
  leadCountry,
  childAge,
  suggestedCountries,
  focus,
  inputClass,
  labelClass,
}: Props) {
  const { t } = useTranslation();
  const id = useId();
  const fields = useRef(new Map<string, HTMLInputElement>());
  const slots = guestSlots(stays);
  useEffect(() => {
    if (focus) fields.current.get(`${focus.id}:${focus.field}`)?.focus();
  }, [focus]);
  const field = (slotId: string, name: "firstName" | "lastName") => (node: HTMLInputElement) => {
    if (node) fields.current.set(`${slotId}:${name}`, node);
    else fields.current.delete(`${slotId}:${name}`);
  };
  // The buttons below disappear once used; keep keyboard focus inside the dialog.
  const focusNationality = (slotId: string) =>
    globalThis.document?.getElementById(`${id}-${slotId}-nationality`)?.focus();
  const leadCard = (
    <section
      data-guest-card
      aria-labelledby={`${id}-lead`}
      className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 sm:p-4"
    >
      <h4 id={`${id}-lead`} className="mb-3 text-sm font-semibold text-gray-900">
        {t("calendar.targetManualBooking.guestNumber", { number: 1 })}
        <span className="font-normal text-gray-500">
          {" · "}
          {t("calendar.targetManualBooking.leadGuestTag")}
        </span>
      </h4>
      {lead}
    </section>
  );

  return (
    <div className="space-y-3">
      {leadCard}
      {slots.map((slot) => {
        const draft = drafts[slot.id] ?? EMPTY_GUEST;
        const started = Boolean(
          draft.firstName.trim() || draft.lastName.trim() || draft.countryCode,
        );
        // Marked once Create pointed at it, so typing a first name doesn't flag the last.
        const missing = guestMissingName(draft);
        const invalid = focus?.id === slot.id ? missing : null;
        const number = slot.number;
        return (
          <section
            key={slot.id}
            data-guest-card
            aria-labelledby={`${id}-${slot.id}`}
            className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 sm:p-4"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h4 id={`${id}-${slot.id}`} className="text-sm font-semibold text-gray-900">
                {t("calendar.targetManualBooking.guestNumber", { number })}
                {slot.child !== null && (
                  <span className="font-normal text-gray-500">
                    {" · "}
                    {t("calendar.targetManualBooking.childTag")}
                  </span>
                )}
              </h4>
              {started && (
                <button
                  type="button"
                  aria-label={t("calendar.targetManualBooking.clearGuest", { number })}
                  onClick={() => {
                    onDraft(slot.id, EMPTY_GUEST);
                    fields.current.get(`${slot.id}:firstName`)?.focus();
                  }}
                  className="-my-3 min-h-11 px-2 text-xs font-medium text-gray-600 hover:text-gray-900"
                >
                  {t("calendar.targetManualBooking.clear")}
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className={labelClass}>
                {t("calendar.newBookingModal.firstNameLabel")}
                <input
                  ref={field(slot.id, "firstName")}
                  aria-label={t("calendar.targetManualBooking.guestFirstName", { number })}
                  aria-invalid={invalid === "firstName" || undefined}
                  maxLength={200}
                  value={draft.firstName}
                  onChange={(event) => onDraft(slot.id, { firstName: event.target.value })}
                  className={inputClass}
                />
              </label>
              <label className={labelClass}>
                {t("calendar.newBookingModal.lastNameLabel")}
                <input
                  ref={field(slot.id, "lastName")}
                  aria-label={t("calendar.targetManualBooking.guestLastName", { number })}
                  aria-invalid={invalid === "lastName" || undefined}
                  maxLength={200}
                  value={draft.lastName}
                  onChange={(event) => onDraft(slot.id, { lastName: event.target.value })}
                  className={inputClass}
                />
              </label>
              <div>
                <label
                  htmlFor={`${id}-${slot.id}-nationality`}
                  className="block text-xs font-medium text-gray-700"
                >
                  {t("bookings.detail.nationality")}
                </label>
                <CountryPicker
                  id={`${id}-${slot.id}-nationality`}
                  label={t("calendar.targetManualBooking.guestNationality", { number })}
                  options={NATIONALITY_PICKER_OPTIONS}
                  value={draft.countryCode}
                  onChange={(countryCode) => onDraft(slot.id, { countryCode })}
                  placeholder={t("common.countryPicker.choose")}
                  suggested={suggestedCountries}
                  display="name"
                  clearable
                  className="mt-1"
                  triggerClassName={inputClass}
                />
                {leadCountry && !draft.countryCode && (
                  <button
                    type="button"
                    aria-label={t("calendar.targetManualBooking.sameAsGuest1For", { number })}
                    onClick={() => {
                      onDraft(slot.id, { countryCode: leadCountry });
                      focusNationality(slot.id);
                    }}
                    className="mt-1 min-h-11 rounded-full border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {t("calendar.targetManualBooking.sameAsGuest1")}
                  </button>
                )}
              </div>
              {slot.child !== null && childAge(slot.stayIndex, slot.child)}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {t("calendar.targetManualBooking.optionalUntilCheckIn")}
            </p>
          </section>
        );
      })}
      <p className="text-xs text-gray-500">
        {t("calendar.targetManualBooking.idDetailsAtCheckIn")}
      </p>
    </div>
  );
}
