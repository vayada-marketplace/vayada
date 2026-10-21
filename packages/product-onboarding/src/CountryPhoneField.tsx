"use client";

import {
  CheckIcon,
  ChevronDownIcon,
  ExclamationCircleIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/24/outline";
import { COUNTRY_OPTIONS } from "@vayada/locale-constants";
import {
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { SUPPORTED_PHONE_COUNTRIES } from "./setupProfileFields";

export type PhoneCountry = Readonly<{
  code: CountryCode;
  name: string;
  flag: string;
  dial: string;
}>;

const PHONE_COUNTRIES: readonly PhoneCountry[] = COUNTRY_OPTIONS.filter(({ code }) =>
  SUPPORTED_PHONE_COUNTRIES.has(code as CountryCode),
).map(({ code, name, flag }) => ({
  code: code as CountryCode,
  name,
  flag,
  dial: `+${getCountryCallingCode(code as CountryCode)}`,
}));

const FALLBACK_COUNTRY: CountryCode = "DE";

function supported(code: string | null | undefined): CountryCode | null {
  const upper = (code ?? "").trim().toUpperCase() as CountryCode;
  return SUPPORTED_PHONE_COUNTRIES.has(upper) ? upper : null;
}

/** The country a new number starts in: the hotel's, else the browser's region, else Germany. */
export function defaultPhoneCountry(hotelCountry?: string | null, locale?: string): CountryCode {
  const hotel = supported(hotelCountry);
  if (hotel) return hotel;
  try {
    const tag = locale ?? (typeof navigator === "undefined" ? undefined : navigator.language);
    if (tag) return supported(new Intl.Locale(tag).maximize().region) ?? FALLBACK_COUNTRY;
  } catch {
    // An unknown locale tag: fall back below.
  }
  return FALLBACK_COUNTRY;
}

/** Splits a stored international number ("+43 1 234567") into its country and the national part. */
export function phoneParts(
  value: string,
  fallback: CountryCode,
): { country: CountryCode; national: string } {
  const trimmed = value.trim();
  if (!trimmed) return { country: fallback, national: "" };
  const parsed = parsePhoneNumberFromString(trimmed);
  if (parsed?.country) {
    const prefix = `+${parsed.countryCallingCode}`;
    const national = trimmed.startsWith(prefix)
      ? trimmed.slice(prefix.length).trim()
      : parsed.nationalNumber;
    return { country: parsed.country, national };
  }
  const prefix = `+${getCountryCallingCode(fallback)}`;
  if (trimmed.startsWith(prefix))
    return { country: fallback, national: trimmed.slice(prefix.length).trim() };
  return { country: fallback, national: trimmed };
}

/** The international number to store: "+49 30 1234567"; "" while no number is entered. */
export function phoneValue(country: CountryCode, national: string): string {
  const typed = national.trim();
  if (!typed) return "";
  if (typed.startsWith("+")) return typed;
  const parsed = parsePhoneNumberFromString(typed, country);
  if (parsed?.isValid()) return parsed.formatInternational();
  return `+${getCountryCallingCode(country)} ${typed}`;
}

/** The hotel's country first, then every other country by name. */
export function orderedPhoneCountries(first: CountryCode): PhoneCountry[] {
  const top = PHONE_COUNTRIES.find(({ code }) => code === first);
  const rest = PHONE_COUNTRIES.filter(({ code }) => code !== first).sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  );
  return top ? [top, ...rest] : rest;
}

/** Matches a country by name, ISO code or dial code ("aus", "AT", "+43", "43"). */
export function matchPhoneCountries(
  countries: readonly PhoneCountry[],
  query: string,
): PhoneCountry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...countries];
  const digits = q.replace(/^\+/, "");
  return countries.filter(
    ({ code, name, dial }) =>
      name.toLowerCase().includes(q) ||
      code.toLowerCase() === q ||
      (/^\d+$/.test(digits) && dial.slice(1).startsWith(digits)),
  );
}

export type CountryPhoneFieldProps = {
  label: string;
  /** The stored international number, e.g. "+49 30 1234567"; "" when empty. */
  value: string;
  onChange: (value: string) => void;
  /** The hotel's country (ISO 3166-1 alpha-2): a new number starts there, and the list shows it first. */
  defaultCountry?: string | null;
  required?: boolean;
  helper?: string;
  error?: string | null;
  /** Height and type size of the country button and the number input, to match the form around it. */
  inputClassName?: string;
};

/**
 * VAY-2247 (Flamur, 2026-10-21): a phone as a country (flag + dial code, a searchable list) and the national
 * number. Stores one international string, as the old free-text fields did.
 */
export function CountryPhoneField({
  label,
  value,
  onChange,
  defaultCountry,
  required = false,
  helper,
  error,
  inputClassName = "h-12 text-base",
}: CountryPhoneFieldProps) {
  const id = `country-phone-${useId()}`;
  const listId = `${id}-countries`;
  const noteId = error || helper ? `${id}-note` : undefined;
  const fallback = useMemo(() => defaultPhoneCountry(defaultCountry), [defaultCountry]);
  const [parts, setParts] = useState(() => phoneParts(value, fallback));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // A number set from outside (e.g. "Use my details") replaces what's shown.
  useEffect(() => {
    if (value !== phoneValue(parts.country, parts.national)) setParts(phoneParts(value, fallback));
    // Only the stored value decides; the parts follow it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // The hotel's country can arrive after the first render; an empty number follows it.
  useEffect(() => {
    if (!value.trim())
      setParts((now) => (now.national ? now : { country: fallback, national: "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallback]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const close = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const countries = useMemo(() => orderedPhoneCountries(fallback), [fallback]);
  const shown = useMemo(() => matchPhoneCountries(countries, query), [countries, query]);
  const current = PHONE_COUNTRIES.find(({ code }) => code === parts.country) ?? countries[0];

  function update(next: { country: CountryCode; national: string }) {
    setParts(next);
    onChange(phoneValue(next.country, next.national));
  }

  function choose(country: PhoneCountry) {
    update({ country: country.code, national: parts.national });
    setOpen(false);
    setQuery("");
    button.current?.focus();
  }

  function onListKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, shown.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const country = shown[active];
      if (country) choose(country);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    }
  }

  const border = error ? "border-red-600" : "border-gray-300";
  return (
    <div ref={wrapper} className="relative flex min-w-0 flex-col">
      <label htmlFor={id} className="text-sm font-semibold text-gray-950">
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-1 text-red-600">
            *
          </span>
        ) : null}
      </label>
      <div className="mt-2 flex gap-2">
        <button
          ref={button}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={`${label} country: ${current.name} ${current.dial}`}
          onClick={() => {
            setOpen((wasOpen) => !wasOpen);
            setQuery("");
            setActive(0);
          }}
          className={`${inputClassName} flex w-28 shrink-0 items-center justify-between gap-2 rounded-xl border bg-white px-3 text-gray-950 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100 ${
            open ? "border-primary-500 ring-2 ring-primary-100" : border
          }`}
        >
          <span aria-hidden="true">{current.flag}</span>
          <span className="font-medium">{current.dial}</span>
          <ChevronDownIcon className="h-4 w-4 text-gray-500" aria-hidden="true" />
        </button>
        <input
          id={id}
          type="tel"
          autoComplete="tel-national"
          inputMode="tel"
          maxLength={24}
          value={parts.national}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={noteId}
          onChange={(event) => {
            const typed = event.target.value;
            // A pasted international number brings its own country.
            update(
              typed.trim().startsWith("+")
                ? phoneParts(typed, parts.country)
                : { country: parts.country, national: typed },
            );
          }}
          className={`${inputClassName} min-w-0 flex-1 rounded-xl border bg-white px-3.5 text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-100 ${border}`}
        />
      </div>
      {error ? (
        <p id={noteId} className="mt-2 flex items-start gap-1.5 text-[13px] text-red-700">
          <ExclamationCircleIcon className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : helper ? (
        <p id={noteId} className="mt-2 text-[13px] leading-5 text-gray-500">
          {helper}
        </p>
      ) : null}
      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-2 rounded-2xl border border-gray-200 bg-white p-2 shadow-lg">
          <div className="flex h-11 items-center gap-2.5 rounded-lg bg-gray-50 px-3">
            <MagnifyingGlassIcon className="h-[18px] w-[18px] text-gray-400" aria-hidden="true" />
            <input
              autoFocus
              role="combobox"
              aria-label="Search country or code"
              aria-controls={listId}
              aria-expanded
              aria-activedescendant={shown[active] ? `${listId}-${shown[active].code}` : undefined}
              placeholder="Search country or code"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onListKey}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-gray-950 outline-none placeholder:text-gray-400"
            />
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label={`${label} country`}
            className="mt-1 max-h-72 overflow-y-auto"
          >
            {shown.map((country, index) => {
              const selected = country.code === parts.country;
              return (
                <li
                  key={country.code}
                  id={`${listId}-${country.code}`}
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(country)}
                  onMouseEnter={() => setActive(index)}
                  className={`flex h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-[15px] ${
                    index === active || selected ? "bg-primary-50" : ""
                  }`}
                >
                  <span aria-hidden="true">{country.flag}</span>
                  <span className={`flex-1 text-gray-950 ${selected ? "font-semibold" : ""}`}>
                    {country.name}
                  </span>
                  <span className="text-gray-500">{country.dial}</span>
                  {selected ? (
                    <CheckIcon className="h-[18px] w-[18px] text-primary-600" aria-hidden="true" />
                  ) : (
                    <span className="h-[18px] w-[18px]" aria-hidden="true" />
                  )}
                </li>
              );
            })}
            {shown.length === 0 ? (
              <li className="px-3 py-2.5 text-sm text-gray-500">
                No country matches “{query.trim()}”.
              </li>
            ) : null}
          </ul>
          <p className="px-3 pb-0.5 pt-1.5 text-xs text-gray-500">
            Your hotel&apos;s country comes first. Type to find any other.
          </p>
        </div>
      ) : null}
    </div>
  );
}
