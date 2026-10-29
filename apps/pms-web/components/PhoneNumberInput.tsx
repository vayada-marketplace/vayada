"use client";

import { useId } from "react";
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";
import { COUNTRY_OPTIONS } from "@vayada/locale-constants";
import CountryPicker from "@/components/CountryPicker";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Same country list and calling-code source as the shared onboarding phone field.
const SUPPORTED = new Set<string>(getCountries());
const PHONE_COUNTRIES = COUNTRY_OPTIONS.filter(({ code }) => SUPPORTED.has(code)).map(
  ({ code, name }) => ({
    code,
    name,
    callingCode: `+${getCountryCallingCode(code as CountryCode)}`,
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
  /** Countries listed first in the picker, e.g. the property's. */
  suggestedCountries?: readonly string[];
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
  suggestedCountries,
  className,
  labelClassName,
  inputClassName,
}: Props) {
  const { t } = useTranslation();
  const inputId = useId();
  const savedId = useId();
  // The E.164 number the booking stores, spaced for reading (VAY-2417).
  const saved = number.trim() ? validPhone(country, number)?.formatInternational() : undefined;
  return (
    <div className={className}>
      <label htmlFor={inputId} className={labelClassName}>
        {label}
      </label>
      <div className="mt-1 flex gap-2">
        <CountryPicker
          label={countryLabel}
          options={PHONE_COUNTRIES}
          value={country}
          onChange={(next) => onChange({ country: next, number })}
          placeholder={countryPlaceholder}
          suggested={suggestedCountries}
          display="dial"
          className="w-28 shrink-0"
          triggerClassName={cn(inputClassName, "w-full")}
        />
        <input
          id={inputId}
          name="phone"
          type="tel"
          autoComplete="off"
          value={number}
          aria-describedby={saved ? savedId : undefined}
          onChange={(event) => onChange({ country, number: event.target.value })}
          onBlur={() => {
            // A pasted valid international number selects its own country code.
            const parsed = validPhone("", number);
            const pasted = phoneCountryOrEmpty(parsed?.country);
            if (parsed && pasted) onChange({ country: pasted, number: parsed.formatNational() });
          }}
          className={cn(inputClassName, "min-h-11 min-w-0 flex-1")}
        />
      </div>
      {saved && (
        <p id={savedId} className="mt-1 text-xs text-gray-500">
          {t("common.phoneSavedAs", { number: saved })}
        </p>
      )}
    </div>
  );
}
