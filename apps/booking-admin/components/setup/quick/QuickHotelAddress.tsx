"use client";

import { CheckCircleIcon, MapPinIcon, PencilSquareIcon } from "@heroicons/react/24/outline";
import GoogleAddressMap from "@vayada/product-onboarding/GoogleAddressMap";
import GooglePlacesAddressField, {
  type GooglePlacesAddress,
} from "@vayada/product-onboarding/GooglePlacesAddressField";
import { findAddressOnMap } from "@vayada/product-onboarding/googleMaps";
import TimezoneField from "@vayada/product-onboarding/TimezoneField";
import {
  availableTimezones,
  defaultTimezoneForCountry,
  timezoneForCoordinates,
} from "@vayada/product-onboarding/timezones";
import { COUNTRY_OPTIONS } from "@vayada/locale-constants";
import { useEffect, useMemo, useRef, useState } from "react";

import { QUICK_SETUP_INPUT, QuickSetupField, QuickSetupFieldError } from "./QuickSetupField";
import type { QuickHotelDraft } from "./quickHotelDraft";

type AddressDraft = Pick<
  QuickHotelDraft,
  "streetAddress" | "postalCode" | "city" | "countryCode" | "latitude" | "longitude" | "timezone"
>;

export type QuickHotelAddressProps = {
  draft: AddressDraft;
  onChange: (patch: Partial<AddressDraft>) => void;
  error?: string;
  /** Google Maps key; without it the address is typed in and the map is left out. */
  apiKey?: string | null;
  /** The hotel's currency once the country is known, e.g. { label: "EUR (€)", note: "From Germany" }. */
  currency?: { label: string; note: string } | null;
  onChangeCurrency?: (() => void) | null;
};

export function formattedAddress(draft: AddressDraft): string {
  const country = COUNTRY_OPTIONS.find((option) => option.code === draft.countryCode)?.name;
  const town = [draft.postalCode.trim(), draft.city.trim()].filter(Boolean).join(" ");
  return [draft.streetAddress.trim(), town, country].filter(Boolean).join(", ");
}

const hasPin = (draft: AddressDraft) =>
  typeof draft.latitude === "number" && typeof draft.longitude === "number";

/**
 * VAY-2247 "Where it is" (Paper rev 4): search for the address (Google Places) or enter it by hand,
 * the pin on a small map, then the time zone and currency it implies, each with Change.
 */
export function QuickHotelAddress({
  draft,
  onChange,
  error,
  apiKey,
  currency,
  onChangeCurrency,
}: QuickHotelAddressProps) {
  const key = apiKey?.trim() || null;
  const addressRevision = useRef(0);
  const complete = Boolean(draft.streetAddress.trim() && draft.city.trim() && draft.countryCode);
  const [mode, setMode] = useState<"search" | "manual" | "summary">(() =>
    complete ? "summary" : key ? "search" : "manual",
  );
  const [adjusting, setAdjusting] = useState(false);
  const [changingTimezone, setChangingTimezone] = useState(false);
  const timezones = useMemo(() => availableTimezones(), []);
  const timezoneFollowsAddress = useRef(!draft.timezone);

  // Typed addresses are looked up once they are complete, to place the first pin.
  const lookupFor =
    complete && !hasPin(draft) && mode === "manual" && key ? formattedAddress(draft) : null;
  useEffect(() => {
    if (!lookupFor || !key) return;
    let current = true;
    const timer = setTimeout(() => {
      void findAddressOnMap(key, lookupFor)
        .then((found) => {
          if (!current || !found) return;
          onChange({
            latitude: found.position.lat,
            longitude: found.position.lng,
            ...(timezoneFollowsAddress.current
              ? { timezone: timezoneForCoordinates(found.position.lat, found.position.lng) }
              : {}),
          });
        })
        .catch(() => {
          /* No pin yet: the owner can still place it by clicking the map. */
        });
    }, 600);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key, lookupFor, onChange]);

  const select = (address: GooglePlacesAddress) => {
    const timezone =
      typeof address.latitude === "number" && typeof address.longitude === "number"
        ? timezoneForCoordinates(address.latitude, address.longitude)
        : defaultTimezoneForCountry(address.countryCode);
    timezoneFollowsAddress.current = true;
    onChange({
      streetAddress: address.streetAddress,
      postalCode: address.postalCode,
      city: address.city,
      countryCode: address.countryCode,
      latitude: address.latitude,
      longitude: address.longitude,
      timezone,
    });
    setMode(address.streetAddress && address.city ? "summary" : "manual");
  };

  const editTyped = (patch: Partial<AddressDraft>) => {
    addressRevision.current += 1;
    onChange({
      ...patch,
      latitude: null,
      longitude: null,
      ...(timezoneFollowsAddress.current && patch.countryCode
        ? { timezone: defaultTimezoneForCountry(patch.countryCode) }
        : {}),
    });
  };

  const pick = ({ lat, lng }: { lat: number; lng: number }) => {
    addressRevision.current += 1;
    onChange({
      latitude: lat,
      longitude: lng,
      ...(timezoneFollowsAddress.current ? { timezone: timezoneForCoordinates(lat, lng) } : {}),
    });
  };

  const switchLink = (label: string, next: "search" | "manual") => (
    <button
      type="button"
      onClick={() => setMode(next)}
      className="rounded text-[13px] font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-5">
      {mode === "search" && key ? (
        <div>
          <p className="text-sm font-semibold text-gray-950">
            Address
            <span aria-hidden="true" className="ml-1 text-red-600">
              *
            </span>
          </p>
          <div className={`mt-2 rounded-[10px] ${error ? "ring-1 ring-red-600" : ""}`}>
            <GooglePlacesAddressField
              addressRevision={addressRevision}
              apiKey={key}
              onUnavailable={() => setMode("manual")}
              onSelect={(address) => select(address)}
            />
          </div>
          {error ? (
            <QuickSetupFieldError message={error} />
          ) : (
            <p className="mt-2 text-[13px] text-gray-500">
              We place your hotel on the map and pick the time zone and currency for you.
            </p>
          )}
          <p className="mt-2 flex items-center gap-1.5">
            <PencilSquareIcon className="h-4 w-4 text-primary-600" aria-hidden="true" />
            {switchLink("Can't find it? Enter the address manually", "manual")}
          </p>
        </div>
      ) : null}

      {mode === "summary" ? (
        <div>
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-950">
              Address
              <span aria-hidden="true" className="ml-1 text-red-600">
                *
              </span>
            </p>
            {switchLink("Change", key ? "search" : "manual")}
          </div>
          <p
            className={`${QUICK_SETUP_INPUT} mt-2 flex items-center gap-2 border-gray-300 !h-auto min-h-11 py-2.5`}
          >
            <MapPinIcon className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
            {formattedAddress(draft)}
          </p>
        </div>
      ) : null}

      {mode === "manual" ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-950">
              Address
              <span aria-hidden="true" className="ml-1 text-red-600">
                *
              </span>
            </p>
            {key ? switchLink("Search instead", "search") : null}
          </div>
          <QuickSetupField
            label="Street and number"
            required
            value={draft.streetAddress}
            inputProps={{ autoComplete: "address-line1", maxLength: 200 }}
            onChange={(streetAddress) => editTyped({ streetAddress })}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <QuickSetupField
              label="Postal code"
              required
              value={draft.postalCode}
              inputProps={{ autoComplete: "postal-code", maxLength: 20 }}
              onChange={(postalCode) => editTyped({ postalCode })}
            />
            <QuickSetupField
              label="City"
              required
              value={draft.city}
              inputProps={{ autoComplete: "address-level2", maxLength: 120 }}
              onChange={(city) => editTyped({ city })}
            />
          </div>
          <label className="flex flex-col text-sm font-semibold text-gray-950">
            <span>
              Country
              <span aria-hidden="true" className="ml-1 text-red-600">
                *
              </span>
            </span>
            <select
              value={draft.countryCode}
              onChange={(event) => editTyped({ countryCode: event.target.value })}
              className={`${QUICK_SETUP_INPUT} mt-2 border-gray-300 font-normal`}
            >
              <option value="">Choose a country</option>
              {COUNTRY_OPTIONS.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </select>
          </label>
          {error ? <QuickSetupFieldError message={error} /> : null}
        </div>
      ) : null}

      {key && complete ? (
        <div>
          <div className="mb-2 flex items-center justify-between">
            {hasPin(draft) ? (
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-green-700">
                <CheckCircleIcon className="h-4 w-4" aria-hidden="true" />
                Pin placed on the map
              </p>
            ) : (
              <p className="text-[13px] text-gray-500">Click the map where your entrance is.</p>
            )}
            {hasPin(draft) && !adjusting ? (
              <button
                type="button"
                onClick={() => setAdjusting(true)}
                className="rounded text-[13px] font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
              >
                Adjust
              </button>
            ) : null}
          </div>
          <div
            className={`relative overflow-hidden rounded-xl border border-gray-200 bg-gray-100 ${
              adjusting || !hasPin(draft) ? "h-56" : "h-24"
            }`}
          >
            <GoogleAddressMap
              active
              apiKey={key}
              latitude={draft.latitude}
              longitude={draft.longitude}
              onPick={adjusting || !hasPin(draft) ? pick : undefined}
            />
          </div>
          {adjusting ? (
            <p className="mt-2 text-[13px] text-gray-500">
              Drag the pin to your entrance. Needed for the map on your page.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2 lg:gap-4">
        <div>
          <p className="text-sm font-semibold text-gray-950">Time zone</p>
          {changingTimezone ? (
            <div className="mt-2">
              <TimezoneField
                value={draft.timezone}
                options={timezones}
                onChange={(timezone) => {
                  timezoneFollowsAddress.current = false;
                  onChange({ timezone });
                  setChangingTimezone(false);
                }}
              />
            </div>
          ) : draft.timezone ? (
            <ReadOnlyBox
              value={draft.timezone}
              note="Detected from your address"
              onChange={() => setChangingTimezone(true)}
            />
          ) : (
            <p className="mt-2 text-[13px] text-gray-400">Set from your address</p>
          )}
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-950">Currency</p>
          {currency ? (
            <ReadOnlyBox
              value={currency.label}
              note={`${currency.note} · used for every price`}
              onChange={onChangeCurrency ?? null}
            />
          ) : (
            <p className="mt-2 text-[13px] text-gray-400">Set from your country</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ReadOnlyBox({
  value,
  note,
  onChange,
}: {
  value: string;
  note: string;
  onChange: (() => void) | null;
}) {
  return (
    <>
      <div className="mt-2 flex h-11 items-center justify-between rounded-[10px] border border-dashed border-gray-300 bg-gray-50 px-3.5">
        <span className="truncate text-[15px] text-gray-950">{value}</span>
        {onChange ? (
          <button
            type="button"
            onClick={onChange}
            className="rounded text-[13px] font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
          >
            Change
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-[13px] text-gray-500">{note}</p>
    </>
  );
}
