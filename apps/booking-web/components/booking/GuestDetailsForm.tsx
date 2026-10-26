"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { PublicQuoteGuestDisclosure } from "@vayada/domain-booking/replacement-pricing";
import { COUNTRY_OPTIONS } from "@vayada/locale-constants";
import {
  defaultPhoneCountry,
  orderedPhoneCountries,
  phoneParts,
  phonePossible,
  phoneValue,
} from "@vayada/product-onboarding/CountryPhoneField";
import { hotelCountryName } from "@/lib/checkoutTerms";
import type { PricingAcceptanceGuest } from "@/services/api/pricingAcceptance";

export type GuestDetails = {
  firstName: string;
  lastName: string;
  email: string;
  /** As the form shows it ("+49 151 2345 6789"); the booking sends it as E.164. */
  phone: string;
  /** The guest's country of residence (ISO 3166-1 alpha-2). */
  countryCode: string;
  arrivalTime: string;
  specialRequests: string;
};
export const emptyGuest: GuestDetails = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  countryCode: "",
  arrivalTime: "",
  specialRequests: "",
};
type Rules = PublicQuoteGuestDisclosure["choices"] | null | undefined;
export type GuestField = "firstName" | "lastName" | "email" | "phone" | "countryCode";

/** Until this quote's rules are known, the phone is required and the optional fields stay hidden
 * (VAY-2163). */
export const phoneRequired = (rules: Rules) => rules?.phoneRequired ?? true;

/** The fields the guest still has to fix, in the form's order (VAY-2347). */
export function guestErrors(guest: GuestDetails, rules: Rules): GuestField[] {
  const errors: GuestField[] = [];
  if (!guest.firstName.trim()) errors.push("firstName");
  if (!guest.lastName.trim()) errors.push("lastName");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email.trim())) errors.push("email");
  const phone = guest.phone.trim();
  // A number with its code must be long enough to be one; an older draft's is sent as typed.
  if (phone ? phone.startsWith("+") && !phonePossible(phone) : phoneRequired(rules))
    errors.push("phone");
  if (!/^([A-Za-z]{2})?$/.test(guest.countryCode.trim())) errors.push("countryCode");
  return errors;
}

export function guestComplete(guest: GuestDetails, rules: Rules): boolean {
  return guestErrors(guest, rules).length === 0;
}

/** The number in E.164 ("+4915123456789"), as the booking stores it; a number typed without a
 * country code (an older draft) is sent as typed. */
export function phoneE164(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed.startsWith("+")) return trimmed;
  const { country, national } = phoneParts(trimmed, defaultPhoneCountry(null));
  return phoneValue(country, national).replace(/[^\d+]/g, "");
}

/** What the booking sends: the optional fields only when the hotel's rules ask for them. */
export function acceptanceGuest(guest: GuestDetails, rules: Rules): PricingAcceptanceGuest {
  return {
    firstName: guest.firstName,
    lastName: guest.lastName,
    email: guest.email,
    phone: phoneE164(guest.phone),
    countryCode: guest.countryCode,
    arrivalTime: rules?.arrivalTimeEnabled ? guest.arrivalTime : "",
    specialRequests: rules?.specialRequestsEnabled ? guest.specialRequests : "",
  };
}

/** The country the guest's browser says they're in (its language's region), for the first guess. */
function browserRegion(): string | null {
  if (typeof navigator === "undefined") return null;
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      if (region && COUNTRY_OPTIONS.some(({ code }) => code === region)) return region;
    } catch {
      // An unknown tag: try the next one.
    }
  }
  return null;
}

const box = (invalid: boolean) =>
  `rounded-[10px] border bg-white text-base text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-100 ${
    invalid ? "border-red-600 ring-1 ring-red-600" : "border-gray-300 focus:border-primary-500"
  }`;
const input = (invalid: boolean) => `w-full h-12 px-3.5 placeholder:text-gray-400 ${box(invalid)}`;
const chevron = (
  <svg
    className="h-4 w-4 text-gray-500"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
  </svg>
);
const alertIcon = (
  <svg
    className="mt-0.5 h-4 w-4 shrink-0"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);

type FieldProps = { id: string; describedBy: string | undefined; invalid: boolean };
const DIAL = new Map(orderedPhoneCountries("DE").map(({ code, dial }) => [code as string, dial]));
/** What the form stores while the guest types: the code and the number as typed. */
const typedPhone = ({ country, national }: { country: string; national: string }) => {
  const number = national.trim();
  if (!number) return "";
  return number.startsWith("+") ? number : `${DIAL.get(country) ?? ""} ${number}`;
};
type Parts = ReturnType<typeof phoneParts>;
// For the codes several countries share (+1, +44, +7), the country most numbers belong to.
const SHARED_CODE_HOME = new Set(["US", "GB", "RU"]);
/** A stored number back into its code and the rest. A number libphonenumber can't place yet keeps
 * its own code (the browser's country when that shares it), never the browser's. */
function splitPhone(value: string, fallback: Parts["country"]): Parts {
  const parts = phoneParts(value, fallback);
  if (!parts.national.startsWith("+")) return parts;
  const matches = Array.from(DIAL).filter(([, dial]) => parts.national.startsWith(`${dial} `));
  const match =
    matches.find(([code]) => code === fallback) ??
    matches.find(([code]) => SHARED_CODE_HOME.has(code)) ??
    matches.sort((a, b) => b[1].length - a[1].length)[0];
  return match
    ? {
        country: match[0] as Parts["country"],
        national: parts.national.slice(match[1].length).trim(),
      }
    : parts;
}

function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required: boolean;
  hint?: string;
  /** Shown instead of the hint once the guest tried to continue with this field wrong. */
  error?: string | null;
  children: (props: FieldProps) => ReactNode;
}) {
  const t = useTranslations("guestDetails");
  const id = useId();
  const noteId = `${id}-note`;
  const note = error || hint;
  // The asterisk stays outside the label, so the field's name is just its label.
  return (
    <div className="min-w-0 md:flex-1">
      <div className="mb-2 flex items-baseline gap-1 text-[15px] font-semibold text-gray-900">
        <label htmlFor={id}>
          {label}
          {!required && <span className="font-normal text-gray-500"> {t("optional")}</span>}
        </label>
        {required && <span aria-hidden="true">*</span>}
      </div>
      {children({ id, describedBy: note ? noteId : undefined, invalid: !!error })}
      {error ? (
        <p id={noteId} className="mt-2 flex items-start gap-1.5 text-sm font-semibold text-red-700">
          {alertIcon}
          {error}
        </p>
      ) : (
        hint && (
          <p id={noteId} className="mt-2 text-sm text-gray-600">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** The phone as a country code joined to the number (VAY-2347); it starts in the country the
 * guest's browser points to, and stores one international number. */
function PhoneInput({
  id,
  describedBy,
  invalid,
  value,
  onChange,
  required,
  disabled,
}: FieldProps & {
  value: string;
  onChange: (value: string) => void;
  required: boolean;
  disabled: boolean;
}) {
  const t = useTranslations("guestDetails");
  const locale = useLocale();
  const fallback = useMemo(() => defaultPhoneCountry(browserRegion()), []);
  const [parts, setParts] = useState(() => splitPhone(value, fallback));
  // A number set from outside (a restored draft) replaces what's shown.
  useEffect(() => {
    if (value !== typedPhone(parts)) setParts(splitPhone(value, fallback));
    // Only the stored value decides; the parts follow it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames([locale], { type: "region" });
    return orderedPhoneCountries(fallback)
      .map((country) => ({ ...country, name: names.of(country.code) ?? country.name }))
      .sort((a, b) =>
        a.code === fallback ? -1 : b.code === fallback ? 1 : a.name.localeCompare(b.name, locale),
      );
  }, [fallback, locale]);
  const update = (next: typeof parts) => {
    setParts(next);
    onChange(typedPhone(next));
  };
  return (
    <div className={`flex h-12 ${box(invalid)} focus-within:ring-2 focus-within:ring-primary-500`}>
      <div className="relative w-28 shrink-0 rounded-l-[10px] border-r border-gray-300 bg-gray-50">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-between pl-3.5 pr-3 font-medium"
        >
          {parts.country} {DIAL.get(parts.country)}
          {chevron}
        </span>
        <select
          aria-label={t("phoneCountry")}
          name="phoneCountry"
          autoComplete="tel-country-code"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
          disabled={disabled}
          value={parts.country}
          onChange={(event) =>
            update({ ...parts, country: event.target.value as typeof parts.country })
          }
        >
          {countries.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name} ({country.dial})
            </option>
          ))}
        </select>
      </div>
      <input
        id={id}
        className="min-w-0 flex-1 rounded-r-[10px] bg-transparent px-3.5 placeholder:text-gray-400 focus:outline-none"
        name="phone"
        type="tel"
        autoComplete="tel-national"
        maxLength={40}
        required={required}
        disabled={disabled}
        placeholder={t("phonePlaceholder")}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={parts.national}
        onChange={(event) => update({ ...parts, national: event.target.value })}
        // A number typed or pasted with its own code moves that code into the dropdown.
        onBlur={() => {
          if (parts.national.trim().startsWith("+"))
            update(splitPhone(parts.national.trim(), parts.country));
        }}
      />
    </div>
  );
}

/** Step 2's form (VAY-2347): who is staying, with placeholders, autofill names and, once the
 * guest tried to continue, what each wrong field needs. Kept in the tab's draft. */
export default function GuestDetailsForm({
  value,
  onChange,
  rules,
  locked = false,
  showErrors = false,
}: {
  value: GuestDetails;
  onChange: (value: GuestDetails) => void;
  rules: Rules;
  /** A booking attempt is open: its details can't change until it is settled. */
  locked?: boolean;
  /** The guest pressed Continue with fields missing or wrong: they are marked until fixed. */
  showErrors?: boolean;
}) {
  const t = useTranslations("guestDetails");
  const locale = useLocale();
  const headingId = useId();
  const set = (field: keyof GuestDetails) => (event: { target: { value: string } }) =>
    onChange({ ...value, [field]: event.target.value });
  const phone = phoneRequired(rules);
  const errors = showErrors ? guestErrors(value, rules) : [];
  const error = (field: GuestField, message: string) => (errors.includes(field) ? message : null);
  const countries = useMemo(
    () =>
      COUNTRY_OPTIONS.map(({ code }) => ({
        code,
        name: hotelCountryName(code, locale) ?? code,
      })).sort((a, b) => a.name.localeCompare(b.name, locale)),
    [locale],
  );
  // The country of residence starts as the browser's guess (an unknown code from an older draft
  // too); the guest can change or clear it.
  useEffect(() => {
    const current = value.countryCode.trim().toUpperCase();
    if (locked || (current && countries.some(({ code }) => code === current))) return;
    // Only for a guest who hasn't filled anything in yet: a cleared choice stays cleared.
    const fresh = !value.firstName.trim() && !value.lastName.trim() && !value.email.trim();
    const guess = (fresh && browserRegion()) || "";
    if (guess !== value.countryCode) onChange({ ...value, countryCode: guess });
    // Only when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section
      aria-labelledby={headingId}
      className="bg-white rounded-2xl border border-gray-200 p-5 md:p-8"
    >
      <h2 id={headingId} className="text-xl font-bold text-gray-900">
        {t("heading")}
      </h2>
      <p className="mt-1 text-[15px] text-gray-600">{t("intro")}</p>
      {errors.length > 0 && (
        // Not a live region: focus moves to the first wrong field, whose message is read with
        // it, and fixing fields doesn't interrupt the screen reader.
        <p className="mt-5 flex items-start gap-2 rounded-[10px] bg-red-50 px-3.5 py-3 text-[15px] font-semibold text-red-700">
          {alertIcon}
          {t("errorSummary", { count: errors.length })}
        </p>
      )}
      <div className="mt-6 space-y-6">
        <div className="flex flex-col gap-6 md:flex-row md:gap-5">
          <Field label={t("firstName")} required error={error("firstName", t("errorFirstName"))}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className={input(invalid)}
                name="firstName"
                autoComplete="given-name"
                maxLength={100}
                required
                disabled={locked}
                placeholder={t("firstNamePlaceholder")}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                value={value.firstName}
                onChange={set("firstName")}
              />
            )}
          </Field>
          <Field label={t("lastName")} required error={error("lastName", t("errorLastName"))}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className={input(invalid)}
                name="lastName"
                autoComplete="family-name"
                maxLength={100}
                required
                disabled={locked}
                placeholder={t("lastNamePlaceholder")}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                value={value.lastName}
                onChange={set("lastName")}
              />
            )}
          </Field>
        </div>
        <Field
          label={t("email")}
          required
          hint={t("emailHint")}
          error={error("email", t("errorEmail"))}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={input(invalid)}
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              disabled={locked}
              placeholder={t("emailPlaceholder")}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              value={value.email}
              onChange={set("email")}
            />
          )}
        </Field>
        <div className="flex flex-col gap-6 md:flex-row md:gap-5">
          <Field
            label={t("phone")}
            required={phone}
            hint={t("phoneHint")}
            error={error("phone", value.phone.trim() ? t("errorPhoneInvalid") : t("errorPhone"))}
          >
            {(props) => (
              <PhoneInput
                {...props}
                value={value.phone}
                onChange={(next) => onChange({ ...value, phone: next })}
                required={phone}
                disabled={locked}
              />
            )}
          </Field>
          <Field
            label={t("countryOfResidence")}
            required={false}
            error={error("countryCode", t("errorCountry"))}
          >
            {({ id, describedBy, invalid }) => (
              <div className="relative">
                <select
                  id={id}
                  className={`${input(invalid)} appearance-none pr-10`}
                  name="countryCode"
                  autoComplete="country-name"
                  disabled={locked}
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  value={value.countryCode.toUpperCase()}
                  onChange={set("countryCode")}
                >
                  <option value="">{t("noCountry")}</option>
                  {countries.map((country) => (
                    <option key={country.code} value={country.code}>
                      {country.name}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center">
                  {chevron}
                </span>
              </div>
            )}
          </Field>
        </div>
        {rules?.arrivalTimeEnabled && (
          <Field label={t("arrivalTime")} required={false}>
            {({ id, describedBy }) => (
              <input
                id={id}
                className={input(false)}
                name="arrivalTime"
                type="time"
                disabled={locked}
                aria-describedby={describedBy}
                value={value.arrivalTime}
                onChange={set("arrivalTime")}
              />
            )}
          </Field>
        )}
        {rules?.specialRequestsEnabled && (
          <Field label={t("specialRequests")} required={false} hint={t("specialRequestsHint")}>
            {({ id, describedBy }) => (
              <textarea
                id={id}
                className={`w-full px-3.5 py-3 placeholder:text-gray-400 ${box(false)}`}
                name="specialRequests"
                maxLength={2000}
                rows={4}
                placeholder={t("specialRequestsPlaceholder")}
                disabled={locked}
                aria-describedby={describedBy}
                value={value.specialRequests}
                onChange={set("specialRequests")}
              />
            )}
          </Field>
        )}
      </div>
    </section>
  );
}
