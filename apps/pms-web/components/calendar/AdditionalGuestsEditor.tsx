"use client";

import { useEffect, useRef } from "react";
import { NationalitySelect } from "@vayada/locale-ui/NationalitySelect";
import PhoneNumberInput, { phoneToE164 } from "@/components/PhoneNumberInput";
import { useTranslation } from "@/lib/i18n";

export type AdditionalGuestDraft = {
  key: number;
  firstName: string;
  lastName: string;
  email: string;
  phoneCountry: string;
  phone: string;
  countryCode: string;
  open: boolean;
};

// Same pattern as the API's zod 4 `.email()`, so the modal never accepts what the server rejects.
const EMAIL =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;
/** Mirrors the API's per-booking limit. */
export const MAX_ADDITIONAL_GUESTS = 100;

/** True when the card can be submitted: names present, optional email and phone valid. */
export function additionalGuestValid(guest: AdditionalGuestDraft): boolean {
  const email = guest.email.trim();
  return (
    Boolean(guest.firstName.trim() && guest.lastName.trim()) &&
    (!email || EMAIL.test(email)) &&
    phoneToE164(guest.phoneCountry, guest.phone) !== null
  );
}

type Props = {
  guests: AdditionalGuestDraft[];
  onChange: (guests: AdditionalGuestDraft[]) => void;
  defaultPhoneCountry: string;
  /** Lowest nightly maximum occupancy of the selected rooms; exceeding it only warns (VAY-1422 §2.3). */
  guestCapacity: number;
  /** Adults + children across the stays, which pricing and Booking Detail use. */
  partySize: number;
  /** Set to a new object to focus the first name of the guest that failed validation. */
  focusGuest: { key: number } | null;
  inputClass: string;
  labelClass: string;
};

export default function AdditionalGuestsEditor({
  guests,
  onChange,
  defaultPhoneCountry,
  guestCapacity,
  partySize,
  focusGuest,
  inputClass,
  labelClass,
}: Props) {
  const { t } = useTranslation();
  const nextKey = useRef(1);
  const firstNames = useRef(new Map<number, HTMLInputElement>());
  useEffect(() => {
    if (focusGuest) firstNames.current.get(focusGuest.key)?.focus();
  }, [focusGuest]);
  const update = (key: number, patch: Partial<AdditionalGuestDraft>) =>
    onChange(guests.map((guest) => (guest.key === key ? { ...guest, ...patch } : guest)));
  const totalGuests = guests.length + 1;

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-gray-700">{t("bookings.detail.additionalGuests")}</h4>
      {guests.map((guest, index) => {
        const number = index + 1;
        const name = `${guest.firstName} ${guest.lastName}`.trim();
        return (
          <details
            key={guest.key}
            data-additional-guest
            open={guest.open}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              if (open !== guest.open) update(guest.key, { open });
            }}
            className="rounded-xl border border-gray-200 bg-gray-50/60"
          >
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-gray-900">
              {t("calendar.targetManualBooking.guestNumber", { number })}
              {name ? ` · ${name}` : ""}
            </summary>
            <div className="grid grid-cols-1 gap-3 border-t border-gray-200 p-3 sm:grid-cols-2">
              <label className={labelClass}>
                {t("calendar.newBookingModal.firstNameLabel")} *
                <input
                  ref={(node) => {
                    if (node) firstNames.current.set(guest.key, node);
                    else firstNames.current.delete(guest.key);
                  }}
                  aria-label={t("calendar.targetManualBooking.guestFirstName", { number })}
                  maxLength={200}
                  value={guest.firstName}
                  onChange={(event) => update(guest.key, { firstName: event.target.value })}
                  className={inputClass}
                />
              </label>
              <label className={labelClass}>
                {t("calendar.newBookingModal.lastNameLabel")} *
                <input
                  aria-label={t("calendar.targetManualBooking.guestLastName", { number })}
                  maxLength={200}
                  value={guest.lastName}
                  onChange={(event) => update(guest.key, { lastName: event.target.value })}
                  className={inputClass}
                />
              </label>
              <label className={`${labelClass} sm:col-span-2`}>
                {t("bookings.detail.emailOptional")}
                {/* Text input: native email validation cannot focus a field in a closed card. */}
                <input
                  aria-label={t("calendar.targetManualBooking.guestEmail", { number })}
                  inputMode="email"
                  autoComplete="off"
                  maxLength={320}
                  value={guest.email}
                  onChange={(event) => update(guest.key, { email: event.target.value })}
                  className={inputClass}
                />
              </label>
              <PhoneNumberInput
                label={t("calendar.targetManualBooking.guestPhone", { number })}
                countryLabel={t("calendar.targetManualBooking.guestPhoneCountryCode", { number })}
                countryPlaceholder={t("calendar.targetManualBooking.phoneCountryPlaceholder")}
                country={guest.phoneCountry}
                number={guest.phone}
                onChange={(next) =>
                  update(guest.key, { phoneCountry: next.country, phone: next.number })
                }
                labelClassName="block text-xs font-medium text-gray-700"
                inputClassName={inputClass}
              />
              <NationalitySelect
                label={t("calendar.targetManualBooking.guestNationality", { number })}
                value={guest.countryCode}
                onChange={(countryCode) => update(guest.key, { countryCode })}
                placeholder={t("calendar.targetManualBooking.searchNationality")}
                containerClassName="space-y-1"
                labelClassName={labelClass}
                inputClassName={inputClass}
              />
              <button
                type="button"
                onClick={() => onChange(guests.filter((item) => item.key !== guest.key))}
                className="justify-self-start text-xs font-medium text-red-600 hover:text-red-700"
              >
                {t("calendar.targetManualBooking.removeGuest", { number })}
              </button>
            </div>
          </details>
        );
      })}
      {guests.length > 0 && totalGuests > partySize && (
        <p role="status" className="text-xs text-amber-700">
          {t("calendar.targetManualBooking.guestsOverParty", {
            count: totalGuests,
            party: partySize,
          })}
        </p>
      )}
      {guests.length > 0 && totalGuests > guestCapacity && (
        <p role="status" className="text-xs text-amber-700">
          {t("calendar.targetManualBooking.guestsOverCapacity", {
            count: totalGuests,
            capacity: guestCapacity,
          })}
        </p>
      )}
      <button
        type="button"
        disabled={guests.length >= MAX_ADDITIONAL_GUESTS}
        onClick={() =>
          onChange([
            ...guests,
            {
              key: nextKey.current++,
              firstName: "",
              lastName: "",
              email: "",
              phoneCountry: defaultPhoneCountry,
              phone: "",
              countryCode: "",
              open: true,
            },
          ])
        }
        className="w-full rounded-lg border border-dashed border-primary-300 px-3 py-2 text-sm font-medium text-primary-700 hover:bg-primary-50 disabled:border-gray-200 disabled:text-gray-400"
      >
        {t("calendar.targetManualBooking.addGuest")}
      </button>
      {guests.length >= MAX_ADDITIONAL_GUESTS && (
        <p className="text-xs text-gray-500">
          {t("calendar.targetManualBooking.guestLimitReached", { count: MAX_ADDITIONAL_GUESTS })}
        </p>
      )}
    </div>
  );
}
