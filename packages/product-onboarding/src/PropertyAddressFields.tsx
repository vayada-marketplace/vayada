"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PropertyProfileLocation } from "@vayada/domain-hotels";
import { COUNTRY_OPTIONS } from "@vayada/locale-constants";
import GooglePlacesAddressField from "./GooglePlacesAddressField";
import GoogleAddressMap from "./GoogleAddressMap";

/** The property's address and arrival pin: what the shared form edits. */
export type PropertyAddress = Pick<
  PropertyProfileLocation,
  "streetAddress" | "postalCode" | "city" | "countryCode" | "latitude" | "longitude"
>;

export const propertyAddressEnglish = {
  "propertyAddress.search": "Search address",
  "propertyAddress.searchHint":
    "Picking a result fills in the fields below. Every field can be edited by hand.",
  "propertyAddress.street": "Street and number",
  "propertyAddress.postalCode": "Postal code",
  "propertyAddress.city": "City / region",
  "propertyAddress.country": "Country",
  "propertyAddress.chooseCountry": "Choose a country",
  "propertyAddress.pinHint": "Place the pin where guests should arrive",
  "propertyAddress.noPin": "Pick an address, click the map or type coordinates to place the pin.",
  "propertyAddress.coordinates": "Coordinates",
  "propertyAddress.latitude": "Latitude",
  "propertyAddress.longitude": "Longitude",
  "propertyAddress.coordinatesHint":
    "Type them when address search or the map is unavailable, or to place the pin exactly.",
} as const;

type Translate = (key: keyof typeof propertyAddressEnglish) => string;

const inputClass =
  "mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50";
const labelClass = "block text-sm font-medium text-gray-700";
const MAX_LENGTH = { streetAddress: 240, postalCode: 32, city: 120 } as const;

/** The property's address (VAY-2322), shared by Booking Admin's Location settings and the PMS room editor's
 * "Property address" modal so the two can't drift apart: address search, fields that can all be typed by
 * hand (search is often incomplete in Sri Lanka and Bali), and the pin where guests arrive, on the map or as
 * coordinates. Typing the address keeps the pin: it marks the arrival point, which the host places. */
export default function PropertyAddressFields({
  value,
  onChange,
  apiKey,
  disabled = false,
  translate,
  locale = "en",
  markerTitle,
}: {
  value: PropertyAddress;
  onChange: (patch: Partial<PropertyAddress>) => void;
  apiKey: string;
  disabled?: boolean;
  translate?: Translate;
  /** For the country names. */
  locale?: string;
  markerTitle?: string;
}) {
  const t = translate ?? ((key) => propertyAddressEnglish[key]);
  // A pick still loading is dropped once the host types.
  const revision = useRef(0);
  const [mapUnavailable, setMapUnavailable] = useState(false);
  // The map and address search keep the handlers they started with: they read this to ignore picks while saving.
  const disabledRef = useRef(disabled);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);
  const change = (patch: Partial<PropertyAddress>) => {
    revision.current += 1;
    onChange(patch);
  };
  const hasPin = value.latitude !== null && value.longitude !== null;
  const showMap = Boolean(apiKey) && !mapUnavailable;
  const countries = useMemo(() => {
    let name = (_code: string, fallback: string) => fallback;
    try {
      const names = new Intl.DisplayNames([locale], { type: "region" });
      name = (code, fallback) => names.of(code) ?? fallback;
    } catch {
      // An old browser: the English names.
    }
    return COUNTRY_OPTIONS.map((country) => ({
      code: country.code,
      name: name(country.code, country.name),
    })).sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [locale]);
  const text = (key: "streetAddress" | "postalCode" | "city", label: string) => (
    <label className={labelClass}>
      {label}
      <input
        className={inputClass}
        value={value[key]}
        // The property profile's limits.
        maxLength={MAX_LENGTH[key]}
        disabled={disabled}
        onChange={(event) => change({ [key]: event.target.value })}
      />
    </label>
  );
  const coordinate = (key: "latitude" | "longitude") => (
    <label className={labelClass}>
      {t(key === "latitude" ? "propertyAddress.latitude" : "propertyAddress.longitude")}
      <input
        className={inputClass}
        type="number"
        step="any"
        min={key === "latitude" ? -90 : -180}
        max={key === "latitude" ? 90 : 180}
        disabled={disabled}
        value={value[key] ?? ""}
        onChange={(event) =>
          change({ [key]: event.target.value === "" ? null : Number(event.target.value) })
        }
      />
    </label>
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] lg:gap-6">
      <div className="space-y-4">
        {apiKey && (
          <div>
            <GooglePlacesAddressField
              apiKey={apiKey}
              label={t("propertyAddress.search")}
              addressRevision={revision}
              onUnavailable={() => {}}
              onSelect={(address) =>
                !disabledRef.current &&
                change({
                  streetAddress: address.streetAddress,
                  postalCode: address.postalCode,
                  city: address.city || address.region,
                  countryCode: address.countryCode,
                  ...(address.latitude !== null && address.longitude !== null
                    ? { latitude: address.latitude, longitude: address.longitude }
                    : {}),
                })
              }
            />
            <p className="mt-1 text-xs text-gray-500">{t("propertyAddress.searchHint")}</p>
          </div>
        )}
        {text("streetAddress", t("propertyAddress.street"))}
        <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-3">
          {text("postalCode", t("propertyAddress.postalCode"))}
          {text("city", t("propertyAddress.city"))}
        </div>
        <label className={labelClass}>
          {t("propertyAddress.country")}
          <select
            className={inputClass}
            value={value.countryCode}
            disabled={disabled}
            onChange={(event) => change({ countryCode: event.target.value })}
          >
            <option value="">{t("propertyAddress.chooseCountry")}</option>
            {/* A code saved before this list keeps showing as it is. */}
            {value.countryCode && !countries.some((c) => c.code === value.countryCode) && (
              <option value={value.countryCode}>{value.countryCode}</option>
            )}
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="space-y-2">
        {showMap ? (
          <div className="relative h-64 overflow-hidden rounded-xl border border-gray-200 sm:h-80">
            <GoogleAddressMap
              active
              apiKey={apiKey}
              latitude={value.latitude}
              longitude={value.longitude}
              markerTitle={markerTitle}
              onPick={(position) =>
                !disabledRef.current && change({ latitude: position.lat, longitude: position.lng })
              }
              onUnavailable={() => setMapUnavailable(true)}
            />
            <p className="pointer-events-none absolute left-2.5 top-2.5 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-gray-700 shadow">
              {t("propertyAddress.pinHint")}
            </p>
          </div>
        ) : null}
        {!hasPin && <p className="text-xs text-amber-800">{t("propertyAddress.noPin")}</p>}
        {/* Open by itself when the map can't place the pin. */}
        <details open={!showMap} className="group">
          <summary className="flex min-h-11 cursor-pointer select-none items-center text-sm font-medium text-gray-700 sm:min-h-0">
            <span>{t("propertyAddress.coordinates")}</span>
            {hasPin && (
              <span className="ml-2 font-normal text-gray-500">
                {value.latitude}, {value.longitude}
              </span>
            )}
          </summary>
          <div className="mt-3 space-y-2">
            <div className="grid grid-cols-2 gap-3">
              {coordinate("latitude")}
              {coordinate("longitude")}
            </div>
            <p className="text-xs text-gray-500">{t("propertyAddress.coordinatesHint")}</p>
          </div>
        </details>
      </div>
    </div>
  );
}
