"use client";

import {
  CheckCircleIcon,
  LinkIcon,
  MapPinIcon,
  PencilSquareIcon,
} from "@heroicons/react/24/outline";
import { addressFromPin } from "@vayada/product-onboarding/addressFromPin";
import GoogleMapsLinkField from "@vayada/product-onboarding/GoogleMapsLinkField";
import type { MapsLinkPin } from "@vayada/product-onboarding/googleMapsLink";
import GooglePlacesAddressField, {
  type GooglePlacesAddress,
} from "@vayada/product-onboarding/GooglePlacesAddressField";
import { findAddressOnMap } from "@vayada/product-onboarding/googleMaps";
import GuestsWillSeeCard from "@vayada/product-onboarding/GuestsWillSeeCard";
import PinMapFrame from "@vayada/product-onboarding/PinMapFrame";
import TimezoneField from "@vayada/product-onboarding/TimezoneField";
import {
  availableTimezones,
  countryForCoordinates,
  defaultTimezoneForCountry,
  timezoneForCoordinates,
} from "@vayada/product-onboarding/timezones";
import { COUNTRY_OPTIONS } from "@vayada/locale-constants";
import { useEffect, useMemo, useRef, useState } from "react";

import { QuickCurrencyPicker } from "./QuickHotelDetails";
import { QUICK_SETUP_INPUT, QuickSetupField, QuickSetupFieldError } from "./QuickSetupField";
import type { QuickHotelDraft } from "./quickHotelDraft";

type AddressDraft = Pick<
  QuickHotelDraft,
  | "streetAddress"
  | "postalCode"
  | "city"
  | "countryCode"
  | "latitude"
  | "longitude"
  | "timezone"
  | "pinFromLink"
>;

export type QuickHotelAddressProps = {
  draft: AddressDraft;
  onChange: (patch: Partial<AddressDraft>) => void;
  /** A pin looked up for a complete address without one, not placed by the owner; `onChange` by default. */
  onPinLookedUp?: ((patch: Partial<AddressDraft>) => void) | null;
  error?: string;
  /** Google Maps key; without it the address is typed in and the map is left out. */
  apiKey?: string | null;
  /** The hotel's currency once the country is known, e.g. { code: "EUR", label: "EUR (€)", note: "From Germany" }. */
  currency?: { code: string; label: string; note: string } | null;
  /** The owner picked another currency after "Change". */
  onCurrencyChange?: ((code: string) => void) | null;
  /** The hotel's name, for "Guests will see". */
  hotelName?: string;
  /** The long link a maps.app.goo.gl share link opens (the API reads it); null without. */
  resolveShortLink?: ((url: string) => Promise<string | null>) | null;
};

// The room editor's map and link copy (VAY-2444: the same tool as Rooms & Rates → room → Location).
const MAP_MESSAGES = {
  mapType: "Map type",
  mapView: "Map",
  satelliteView: "Satellite",
  dragPin: "Drag the pin to the exact spot",
  recenter: "Recenter",
  empty: "Click the map where your entrance is.",
};
const LINK_MESSAGES = {
  label: "Google Maps link",
  hint: "Copy the link of a place or a dropped pin from Google Maps.",
  placed: (coordinates: string) => `Pin placed at ${coordinates}`,
  resolving: "Reading the short link…",
  shortLink:
    "This short link couldn't be read. Open it, copy the long link from the address bar, and paste that.",
  noPin: "This link has no coordinates. Copy the link of a place or a dropped pin.",
  searchInstead: "Search an address instead",
};
const LINK_CLASS =
  "inline-flex items-center gap-1.5 rounded text-[13px] font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600";

export function formattedAddress(draft: AddressDraft): string {
  const country = COUNTRY_OPTIONS.find((option) => option.code === draft.countryCode)?.name;
  const town = [draft.postalCode.trim(), draft.city.trim()].filter(Boolean).join(" ");
  return [draft.streetAddress.trim(), town, country].filter(Boolean).join(", ");
}

const hasPin = (draft: AddressDraft) =>
  typeof draft.latitude === "number" && typeof draft.longitude === "number";

/**
 * VAY-2247 "Where it is" (Paper rev 4): search for the address (Google Places), paste a Google Maps link
 * (VAY-2444, as in the room editor) or enter it by hand, the pin on the room editor's map, then the time zone
 * and currency it implies, each with Change.
 */
export function QuickHotelAddress({
  draft,
  onChange,
  onPinLookedUp,
  error,
  apiKey,
  currency,
  onCurrencyChange,
  hotelName = "",
  resolveShortLink = null,
}: QuickHotelAddressProps) {
  const key = apiKey?.trim() || null;
  const addressRevision = useRef(0);
  const complete = Boolean(draft.streetAddress.trim() && draft.city.trim() && draft.countryCode);
  const [mode, setMode] = useState<"search" | "link" | "manual" | "summary">(() =>
    complete ? "summary" : key ? "search" : "manual",
  );
  const [adjusting, setAdjusting] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [changingTimezone, setChangingTimezone] = useState(false);
  const [changingCurrency, setChangingCurrency] = useState(false);
  const timezones = useMemo(() => availableTimezones(), []);
  const timezoneFollowsAddress = useRef(!draft.timezone);
  // The address lookup for a pasted link's pin (VAY-2444): only the latest counts, and any other choice drops it.
  const linkLookup = useRef(0);
  const [lookingUp, setLookingUp] = useState(false);
  // Where focus goes once a link's lookup ends, as the link field it came from goes away.
  const [focusAfterLink, setFocusAfterLink] = useState(false);
  const cancelLinkLookup = () => {
    linkLookup.current += 1;
    setLookingUp(false);
  };
  useEffect(
    () => () => {
      linkLookup.current += 1;
    },
    [],
  );

  // A complete address without a pin is looked up to place the first pin: a typed one, and a picked one
  // that Google only knows as an area (a street without a number, a postcode or a town), which the
  // suggestion leaves unpinned. Without this the map showed the whole world (VAY-2247, Flamur's test).
  const lookupFor =
    complete && !hasPin(draft) && mode !== "search" && key ? formattedAddress(draft) : null;
  useEffect(() => {
    if (!lookupFor || !key) return;
    let current = true;
    const timer = setTimeout(() => {
      void findAddressOnMap(key, lookupFor)
        .then((found) => {
          if (!current || !found) return;
          // An area isn't the entrance: the map opens to drag the pin there.
          if (!found.precise) setAdjusting(true);
          (onPinLookedUp ?? onChange)({
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
  }, [key, lookupFor, onChange, onPinLookedUp]);

  const select = (address: GooglePlacesAddress) => {
    const timezone =
      typeof address.latitude === "number" && typeof address.longitude === "number"
        ? timezoneForCoordinates(address.latitude, address.longitude)
        : defaultTimezoneForCountry(address.countryCode);
    timezoneFollowsAddress.current = true;
    cancelLinkLookup();
    onChange({
      streetAddress: address.streetAddress,
      postalCode: address.postalCode,
      city: address.city,
      countryCode: address.countryCode,
      latitude: address.latitude,
      longitude: address.longitude,
      timezone,
      pinFromLink: false,
    });
    setMode(address.streetAddress && address.city ? "summary" : "manual");
  };

  const editTyped = (patch: Partial<AddressDraft>) => {
    addressRevision.current += 1;
    cancelLinkLookup();
    if (draft.pinFromLink) return onChange(patch);
    onChange({
      ...patch,
      latitude: null,
      longitude: null,
      ...(timezoneFollowsAddress.current && patch.countryCode
        ? { timezone: defaultTimezoneForCountry(patch.countryCode) }
        : {}),
    });
  };

  /** A pasted link's pin, then the address Google gives it; without one, the owner types it next to the pin. The
   * previous address no longer describes the place, as in the room editor. */
  const placeFromLink = (pin: MapsLinkPin) => {
    if (!key) return;
    const request = (linkLookup.current += 1);
    timezoneFollowsAddress.current = true;
    onChange({
      latitude: pin.latitude,
      longitude: pin.longitude,
      timezone: timezoneForCoordinates(pin.latitude, pin.longitude),
      streetAddress: "",
      postalCode: "",
      city: "",
      pinFromLink: true,
    });
    setLookingUp(true);
    void addressFromPin(key, { lat: pin.latitude, lng: pin.longitude }).then((address) => {
      if (request !== linkLookup.current) return;
      setLookingUp(false);
      setFocusAfterLink(true);
      if (address?.city && address.countryCode) {
        onChange({
          streetAddress: address.streetAddress,
          postalCode: address.postalCode,
          city: address.city,
          countryCode: address.countryCode,
        });
        setMode(address.streetAddress ? "summary" : "manual");
        return;
      }
      // The country the pin's time zone belongs to, or none for the owner to choose.
      onChange({ countryCode: countryForCoordinates(pin.latitude, pin.longitude) });
      setMode("manual");
    });
  };

  const pick = ({ lat, lng }: { lat: number; lng: number }) => {
    addressRevision.current += 1;
    setAdjusting(false);
    onChange({
      latitude: lat,
      longitude: lng,
      ...(timezoneFollowsAddress.current ? { timezone: timezoneForCoordinates(lat, lng) } : {}),
    });
  };

  const switchLink = (label: string, next: "search" | "link" | "manual", autoFocus = false) => (
    <button
      type="button"
      autoFocus={autoFocus}
      onClick={() => {
        cancelLinkLookup();
        setFocusAfterLink(false);
        setMode(next);
      }}
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
            <LinkIcon className="h-4 w-4 text-primary-600" aria-hidden="true" />
            {switchLink("Paste a Google Maps link", "link")}
          </p>
          <p className="mt-2 flex items-center gap-1.5">
            <PencilSquareIcon className="h-4 w-4 text-primary-600" aria-hidden="true" />
            {switchLink("Can't find it? Enter the address manually", "manual")}
          </p>
        </div>
      ) : null}

      {mode === "link" && key ? (
        <div>
          <GoogleMapsLinkField
            inputId="quick-hotel-maps-link"
            messages={LINK_MESSAGES}
            classNames={{
              label: "mb-2 block text-sm font-semibold text-gray-950",
              input: `${QUICK_SETUP_INPUT} ${error ? "border-red-600" : "border-gray-300"}`,
              link: LINK_CLASS,
            }}
            onPin={placeFromLink}
            onClose={() => {
              cancelLinkLookup();
              setMode("search");
            }}
            resolveShortLink={resolveShortLink}
          />
          {error ? <QuickSetupFieldError message={error} /> : null}
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
            {switchLink("Change", key ? "search" : "manual", focusAfterLink)}
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
            inputProps={{
              autoComplete: "address-line1",
              maxLength: 200,
              autoFocus: focusAfterLink,
            }}
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
          {key ? (
            <p className="flex items-center gap-1.5">
              <LinkIcon className="h-4 w-4 text-primary-600" aria-hidden="true" />
              {switchLink("Paste a Google Maps link", "link")}
            </p>
          ) : null}
        </div>
      ) : null}

      {key && (complete || hasPin(draft)) ? (
        <div className="flex flex-col gap-3">
          <div>
            {/* Without a pin, the map itself says to click where the entrance is. */}
            {hasPin(draft) ? (
              <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-green-700">
                <CheckCircleIcon className="h-4 w-4" aria-hidden="true" />
                Pin placed on the map
              </p>
            ) : null}
            <div className="relative h-[240px] overflow-hidden rounded-xl border border-gray-200 bg-gray-100 lg:h-[300px]">
              {mapFailed ? (
                <div className="flex h-full items-center justify-center text-sm font-medium text-slate-500">
                  Map unavailable
                </div>
              ) : (
                <PinMapFrame
                  apiKey={key}
                  latitude={draft.latitude}
                  longitude={draft.longitude}
                  markerTitle={hotelName.trim() || "Your hotel"}
                  messages={MAP_MESSAGES}
                  onPick={pick}
                  onUnavailable={() => setMapFailed(true)}
                />
              )}
            </div>
            {adjusting ? (
              <p className="mt-2 text-[13px] text-gray-500">
                Drag the pin to your entrance. Needed for the map on your page.
              </p>
            ) : null}
          </div>
          {hasPin(draft) ? (
            <div aria-live="polite">
              <GuestsWillSeeCard
                label="Guests will see"
                name={hotelName.trim() || "Your hotel"}
                address={
                  formattedAddress(draft) ||
                  (lookingUp ? "Looking up the address…" : "Add the address above.")
                }
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2.5">
        {changingTimezone ? (
          <div>
            <p className="text-sm font-semibold text-gray-950">Time zone</p>
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
          </div>
        ) : (
          <AutoLine
            name="Time zone"
            value={draft.timezone || "Set from your address"}
            note={draft.timezone ? "Detected from your address" : null}
            onChange={draft.timezone ? () => setChangingTimezone(true) : null}
          />
        )}
        {currency && changingCurrency && onCurrencyChange ? (
          <div>
            <p className="text-sm font-semibold text-gray-950">Currency</p>
            <QuickCurrencyPicker
              value={currency.code}
              onChange={(code) => {
                onCurrencyChange(code);
                setChangingCurrency(false);
              }}
            />
          </div>
        ) : (
          <AutoLine
            name="Currency"
            value={currency ? currency.label : "Set from your country"}
            note={currency ? `${currency.note} · used for every price` : null}
            onChange={currency && onCurrencyChange ? () => setChangingCurrency(true) : null}
          />
        )}
      </div>
    </div>
  );
}

/** Time zone or currency on one line (Paper "7 steps · approved"): name and value, why, then Change. */
function AutoLine({
  name,
  value,
  note,
  onChange,
}: {
  name: string;
  value: string;
  note: string | null;
  onChange: (() => void) | null;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-gray-50 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-gray-500">{name}</p>
        <p className={`truncate text-base ${note ? "font-medium text-gray-950" : "text-gray-400"}`}>
          {value}
        </p>
      </div>
      {note ? <p className="hidden shrink-0 text-xs text-gray-500 lg:block">{note}</p> : null}
      {onChange ? (
        <button
          type="button"
          onClick={onChange}
          aria-label={`Change ${name.toLowerCase()}`}
          className="shrink-0 rounded text-sm font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
        >
          Change
        </button>
      ) : null}
    </div>
  );
}
