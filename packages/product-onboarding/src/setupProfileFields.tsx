"use client";

import { type ComponentType, type SVGProps, useEffect, useId, useState } from "react";
import {
  BuildingOffice2Icon,
  BuildingOfficeIcon,
  BuildingStorefrontIcon,
  CakeIcon,
  CheckIcon,
  EllipsisHorizontalIcon,
  HomeModernIcon,
  KeyIcon,
  MapPinIcon,
  PhotoIcon,
  SunIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { COUNTRY_OPTIONS } from "@vayada/locale-constants";
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";

import { HotelIcon } from "./HotelIcon";
import type { SharedPropertyTypeOption } from "./sharedHotelSetupApi";

// Moved out of SharedFirstRunPropertySetupWizard.tsx unchanged (VAY-2247), so the new first run
// can reuse the profile fields without the wizard.

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

const PROPERTY_TYPE_ICONS = new Map<string, IconComponent>([
  ["hotel", HotelIcon],
  ["resort", SunIcon],
  ["hostel", UsersIcon],
  ["apartment", BuildingOffice2Icon],
  ["aparthotel", BuildingOfficeIcon],
  ["guesthouse", BuildingStorefrontIcon],
  ["bed_and_breakfast", CakeIcon],
  ["villa", HomeModernIcon],
  ["vacation_rental", KeyIcon],
  ["motel", MapPinIcon],
  ["other", EllipsisHorizontalIcon],
]);

export function TextField({
  label,
  value,
  onChange,
  error,
  helper,
  placeholder,
  type = "text",
  readOnly = false,
  required = false,
  listOptions,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  placeholder?: string;
  type?: string;
  readOnly?: boolean;
  required?: boolean;
  listOptions?: string[];
}) {
  const generatedId = useId();
  const inputId = `setup-${generatedId}`;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div>
      <label
        htmlFor={inputId}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
      >
        <span>{label}</span>
        {!required && (
          <span aria-hidden="true" className="text-xs text-gray-400">
            Optional
          </span>
        )}
      </label>
      {helper && (
        <p id={helperId} className="mt-1 text-xs text-gray-500">
          {helper}
        </p>
      )}
      <input
        id={inputId}
        type={type}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        aria-required={required}
        list={listOptions ? `${inputId}-options` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 w-full rounded-xl border px-4 py-2.5 text-base outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100 sm:text-sm ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        } ${readOnly ? "bg-gray-50 text-gray-600" : ""}`}
      />
      {listOptions && (
        <datalist id={`${inputId}-options`}>
          {listOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const SUPPORTED_PHONE_COUNTRIES = new Set(getCountries());
const PHONE_COUNTRY_OPTIONS = COUNTRY_OPTIONS.filter(({ code }) =>
  SUPPORTED_PHONE_COUNTRIES.has(code as CountryCode),
).map((country) => ({
  ...country,
  callingCode: `+${getCountryCallingCode(country.code as CountryCode)}`,
}));

function phoneCountry(value: string, fallback: string): CountryCode {
  const parsed = parsePhoneNumberFromString(value);
  if (parsed?.country) return parsed.country;
  const normalizedFallback = fallback.trim().toUpperCase() as CountryCode;
  return SUPPORTED_PHONE_COUNTRIES.has(normalizedFallback) ? normalizedFallback : "US";
}

export function normalizedPhoneNumber(value: string, countryCode?: CountryCode): string {
  const parsed = parsePhoneNumberFromString(value, countryCode);
  return parsed?.isValid() ? parsed.formatInternational() : value;
}

export function isValidInternationalPhone(value: string): boolean {
  return value.trim().startsWith("+") && Boolean(parsePhoneNumberFromString(value)?.isValid());
}

export function phoneWithCountryCallingCode(
  value: string,
  countryCode: CountryCode,
  previousCountryCode?: CountryCode,
): string {
  const callingCode = `+${getCountryCallingCode(countryCode)}`;
  const parsed = parsePhoneNumberFromString(value);
  if (parsed?.nationalNumber) return `${callingCode} ${parsed.nationalNumber}`;

  const digits = value.replace(/\D/g, "");
  const previousCallingCode = previousCountryCode
    ? getCountryCallingCode(previousCountryCode)
    : undefined;
  const nationalNumber =
    previousCallingCode && digits.startsWith(previousCallingCode)
      ? digits.slice(previousCallingCode.length)
      : digits.replace(/^0+/, "");
  return nationalNumber ? `${callingCode} ${nationalNumber}` : `${callingCode} `;
}

export function PhoneField({
  label,
  value,
  countryCode,
  onChange,
  error,
  helper,
  placeholder,
  required = false,
}: {
  label: string;
  value: string;
  countryCode: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  placeholder: string;
  required?: boolean;
}) {
  const generatedId = useId();
  const inputId = `setup-${generatedId}`;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;
  const [selectedCountry, setSelectedCountry] = useState<CountryCode>(() =>
    phoneCountry(value, countryCode),
  );

  useEffect(() => {
    const parsedCountry = parsePhoneNumberFromString(value)?.country;
    if (parsedCountry) {
      setSelectedCountry((current) => (current === parsedCountry ? current : parsedCountry));
    } else if (!value.trim()) {
      const fallbackCountry = phoneCountry("", countryCode);
      setSelectedCountry((current) => (current === fallbackCountry ? current : fallbackCountry));
    }
  }, [countryCode, value]);

  return (
    <div>
      <label
        htmlFor={inputId}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
      >
        <span>{label}</span>
        {!required && (
          <span aria-hidden="true" className="text-xs text-gray-400">
            Optional
          </span>
        )}
      </label>
      {helper && (
        <p id={helperId} className="mt-1 text-xs text-gray-500">
          {helper}
        </p>
      )}
      <div
        className={`mt-2 flex overflow-hidden rounded-xl border transition focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-100 ${
          error ? "border-red-300 bg-red-50" : "border-gray-200 bg-white"
        }`}
      >
        <select
          aria-label={`${label} country code`}
          value={selectedCountry}
          onChange={(event) => {
            const nextCountry = event.target.value as CountryCode;
            const previousCountry = selectedCountry;
            setSelectedCountry(nextCountry);
            onChange(phoneWithCountryCallingCode(value, nextCountry, previousCountry));
          }}
          className="w-32 shrink-0 border-0 border-r border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none"
        >
          {PHONE_COUNTRY_OPTIONS.map((country) => (
            <option key={country.code} value={country.code}>
              {country.flag} {country.callingCode}
            </option>
          ))}
        </select>
        <input
          id={inputId}
          type="tel"
          value={value}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          aria-required={required}
          onChange={(event) => onChange(normalizedPhoneNumber(event.target.value, selectedCountry))}
          onBlur={() => {
            const normalized = normalizedPhoneNumber(value, selectedCountry);
            if (normalized !== value) onChange(normalized);
          }}
          className="min-w-0 flex-1 border-0 bg-transparent px-4 py-2.5 text-base outline-none sm:text-sm"
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function PropertyLogoField({
  previewUrl,
  pending,
  error,
  onChange,
}: {
  previewUrl: string;
  pending: boolean;
  error?: string;
  onChange: (file: File) => void;
}) {
  const inputId = `property-logo-${useId()}`;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div>
      <p className="text-sm font-medium text-gray-700">
        Hotel logo
        <span className="ml-1 text-red-500" aria-hidden="true">
          *
        </span>
        <span className="sr-only"> (required)</span>
      </p>
      <label
        htmlFor={inputId}
        className={`mt-2 flex cursor-pointer items-center gap-4 rounded-xl border bg-white p-3 transition hover:border-primary-300 focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        }`}
      >
        <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-100 text-gray-500">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Hotel logo preview"
              className="h-full w-full object-contain"
            />
          ) : pending ? (
            <CheckIcon className="h-7 w-7 text-primary-700" aria-hidden="true" />
          ) : (
            <PhotoIcon className="h-7 w-7" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-gray-900">
            {previewUrl
              ? "Change hotel logo"
              : pending
                ? "Logo ready to finish"
                : "Choose hotel logo"}
          </span>
          <span className="mt-1 block text-xs leading-5 text-gray-500">
            JPG, PNG, or WebP. Max 10 MB. The logo is published only after assignment.
          </span>
        </span>
        <input
          id={inputId}
          type="file"
          aria-label="Hotel logo file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          aria-invalid={Boolean(error)}
          aria-describedby={errorId}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onChange(file);
            event.target.value = "";
          }}
        />
      </label>
      {error && (
        <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function PropertyTypeField({
  value,
  options,
  onChange,
  error,
  required = false,
}: {
  value: string;
  options: SharedPropertyTypeOption[];
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
}) {
  const generatedId = useId();
  const groupName = `property-type-${generatedId}`;
  const errorId = error ? `${groupName}-error` : undefined;

  return (
    <fieldset aria-describedby={errorId} aria-invalid={Boolean(error)}>
      <legend className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700">
        <span>Property type</span>
        {!required && (
          <span aria-hidden="true" className="text-xs text-gray-400">
            Optional
          </span>
        )}
      </legend>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {options.map((option) => {
          const checked = value === option.value;
          const Icon = PROPERTY_TYPE_ICONS.get(option.value) ?? EllipsisHorizontalIcon;

          return (
            <label key={option.value} className="relative block cursor-pointer">
              <input
                type="radio"
                name={groupName}
                value={option.value}
                checked={checked}
                required={required}
                aria-invalid={Boolean(error)}
                aria-describedby={errorId}
                onChange={(event) => onChange(event.target.value)}
                className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
              />
              <span
                className={`relative flex min-h-16 items-center gap-2 rounded-xl border p-2.5 transition peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary-600 peer-focus-visible:ring-offset-2 ${
                  checked
                    ? "border-primary-500 bg-primary-50 shadow-[0_12px_30px_-24px_rgba(30,62,219,0.8)]"
                    : "border-gray-200 bg-white hover:border-primary-300 hover:bg-primary-50/40"
                }`}
              >
                <span
                  className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    checked ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-700"
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {checked && (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary-700 text-white ring-2 ring-white">
                      <CheckIcon className="h-3 w-3" aria-hidden="true" />
                    </span>
                  )}
                </span>
                <span className="text-sm font-medium leading-5 text-gray-900">{option.label}</span>
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p id={errorId} className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function SelectField({
  label,
  value,
  placeholder,
  options,
  onChange,
  error,
  required = false,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
}) {
  const generatedId = useId();
  const inputId = `setup-${generatedId}`;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div>
      <label
        htmlFor={inputId}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
      >
        <span>{label}</span>
        {!required && (
          <span aria-hidden="true" className="text-xs text-gray-400">
            Optional
          </span>
        )}
      </label>
      <select
        id={inputId}
        value={value}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={errorId}
        aria-required={required}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 w-full rounded-xl border bg-white px-4 py-2.5 text-base outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100 sm:text-sm ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        }`}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
