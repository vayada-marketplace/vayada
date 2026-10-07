"use client";

import { useId } from "react";
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";
import { COUNTRY_OPTIONS } from "@vayada/locale-constants";
import { cn } from "@/lib/utils";

// Same country list and calling-code source as the shared onboarding phone field.
const SUPPORTED = new Set<string>(getCountries());
const PHONE_COUNTRIES = COUNTRY_OPTIONS.filter(({ code }) => SUPPORTED.has(code)).map(
  (country) => ({
    ...country,
    callingCode: `+${getCountryCallingCode(country.code as CountryCode)}`,
  }),
);
const PHONE_COUNTRY_CODES = new Set(PHONE_COUNTRIES.map(({ code }) => code));
// Mirrors the manual-booking route's phoneE164 rule.
const E164 = /^\+[1-9]\d{7,14}$/;

export function phoneCountryOrEmpty(code: string | null | undefined): string {
  const normalized = code?.trim().toUpperCase() ?? "";
  return PHONE_COUNTRY_CODES.has(normalized) ? normalized : "";
}

// Letters and extensions are rejected rather than silently dropped.
function validPhone(country: string, number: string) {
  if (/[a-z]/i.test(number)) return undefined;
  const parsed = parsePhoneNumberFromString(
    number,
    (phoneCountryOrEmpty(country) || undefined) as CountryCode | undefined,
  );
  return parsed?.isValid() && !parsed.ext && E164.test(parsed.number) ? parsed : undefined;
}

/** E.164 for a filled number, "" when empty, null when it is not a valid phone number. */
export function phoneToE164(country: string, number: string): string | null {
  if (!number.trim()) return "";
  return validPhone(country, number)?.number ?? null;
}

type Props = {
  label: string;
  countryLabel: string;
  countryPlaceholder: string;
  country: string;
  number: string;
  onChange: (value: { country: string; number: string }) => void;
  className?: string;
  labelClassName?: string;
  inputClassName: string;
};

export default function PhoneNumberInput({
  label,
  countryLabel,
  countryPlaceholder,
  country,
  number,
  onChange,
  className,
  labelClassName,
  inputClassName,
}: Props) {
  const inputId = useId();
  const selected = PHONE_COUNTRIES.find(({ code }) => code === country);
  return (
    <div className={className}>
      <label htmlFor={inputId} className={labelClassName}>
        {label}
      </label>
      <div className="mt-1 flex gap-2">
        {/* Options start with the country name so native type-ahead works; the closed
            select shows only flag + calling code through the overlay. */}
        <div className="relative w-28 shrink-0">
          <select
            aria-label={countryLabel}
            value={country}
            onChange={(event) => onChange({ country: event.target.value, number })}
            className={cn(inputClassName, "text-transparent disabled:text-transparent")}
          >
            <option value="" className="text-gray-900">
              {countryPlaceholder}
            </option>
            {PHONE_COUNTRIES.map((option) => (
              <option key={option.code} value={option.code} className="text-gray-900">
                {option.name} {option.flag} {option.callingCode}
              </option>
            ))}
          </select>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-between gap-1 px-3 text-sm text-gray-900"
          >
            <span className="truncate">
              {selected ? `${selected.flag} ${selected.callingCode}` : countryPlaceholder}
            </span>
            <svg
              width="16"
              height="16"
              viewBox="0 0 20 20"
              fill="none"
              className="shrink-0 text-gray-500"
            >
              <path
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
                d="m6 8 4 4 4-4"
              />
            </svg>
          </span>
        </div>
        <input
          id={inputId}
          name="phone"
          type="tel"
          autoComplete="off"
          value={number}
          onChange={(event) => onChange({ country, number: event.target.value })}
          onBlur={() => {
            // A pasted valid international number selects its own country code.
            const parsed = validPhone("", number);
            const pasted = phoneCountryOrEmpty(parsed?.country);
            if (parsed && pasted) onChange({ country: pasted, number: parsed.formatNational() });
          }}
          className={cn(inputClassName, "min-w-0 flex-1")}
        />
      </div>
    </div>
  );
}
