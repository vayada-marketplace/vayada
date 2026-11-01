import {
  getAllTimezones,
  getCountry,
  getTimezone,
  type CountryCode,
} from "countries-and-timezones";
import tzlookup from "tz-lookup";

import { TIMEZONE_OPTIONS } from "@vayada/locale-constants";

const COUNTRY_DEFAULT_OVERRIDES: Record<string, string> = {
  AU: "Australia/Sydney",
  BR: "America/Sao_Paulo",
  CA: "America/Toronto",
  ID: "Asia/Jakarta",
  MX: "America/Mexico_City",
  RU: "Europe/Moscow",
  US: "America/New_York",
};

export function timezoneForCoordinates(latitude: number, longitude: number): string {
  return tzlookup(latitude, longitude);
}

/** The country a pin is in when its time zone belongs to one country only (Asia/Colombo → LK), else "". A guess
 * for a pin without an address (VAY-2444); the owner can change it. */
export function countryForCoordinates(latitude: number, longitude: number): string {
  const countries = getTimezone(timezoneForCoordinates(latitude, longitude))?.countries ?? [];
  return countries.length === 1 ? countries[0]! : "";
}

export function defaultTimezoneForCountry(countryCode: string): string {
  const code = countryCode.trim().toUpperCase();
  if (!code) return "";
  const overridden = COUNTRY_DEFAULT_OVERRIDES[code];
  if (overridden) return overridden;
  return getCountry(code as CountryCode)?.timezones[0] ?? "";
}

export function availableTimezones(): string[] {
  const baseline = ["Etc/UTC", ...Object.keys(getAllTimezones()), ...TIMEZONE_OPTIONS];
  try {
    return Array.from(new Set([...baseline, ...Intl.supportedValuesOf("timeZone")]));
  } catch {
    return Array.from(new Set(baseline));
  }
}

export function filterTimezones(options: string[], query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return options;
  return options.filter((timezone) => timezone.toLowerCase().includes(normalized));
}
