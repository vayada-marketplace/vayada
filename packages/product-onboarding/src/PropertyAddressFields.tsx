"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CheckCircleIcon, ChevronRightIcon, LinkIcon } from "@heroicons/react/24/outline";
import type { PropertyProfileLocation } from "@vayada/domain-hotels";
import { COUNTRY_OPTIONS } from "@vayada/locale-constants";
import { addressFromPin } from "./addressFromPin";
import GooglePlacesAddressField from "./GooglePlacesAddressField";
import GoogleAddressMap, { type MapPosition } from "./GoogleAddressMap";
import GoogleMapsLinkField, { type GoogleMapsLinkMessages } from "./GoogleMapsLinkField";
import type { MapsLinkPin } from "./googleMapsLink";
import { findAddressOnMap } from "./googleMaps";
import GuestsWillSeeCard from "./GuestsWillSeeCard";
import { distanceKm } from "./nearbyPlaces";
import PinMapFrame, { type PinMapFrameMessages } from "./PinMapFrame";

/** The property's address and arrival pin: what the shared form edits. */
export type PropertyAddress = Pick<
  PropertyProfileLocation,
  | "streetAddress"
  | "postalCode"
  | "city"
  | "countryCode"
  | "latitude"
  | "longitude"
  | "area"
  | "arrivalDirections"
>;

export const propertyAddressEnglish = {
  "propertyAddress.search": "Search address",
  "propertyAddress.searchHint":
    "Picking a result fills in the fields below. Every field can be edited by hand.",
  "propertyAddress.street": "Street and number",
  "propertyAddress.area": "Area / village",
  "propertyAddress.optional": "optional",
  "propertyAddress.directions": "Arrival directions",
  "propertyAddress.directionsHint":
    "How guests find your entrance once they arrive. For example: “Turn at the blue gate after the temple”.",
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

/** The PMS "Property address" window (VAY-2482): the room editor's way to place a pin (VAY-2321). A pasted Google
 * Maps link comes first, with address search instead; the link's pin then fills the fields from Google. The pin
 * map has Map/Satellite and Recenter, "Guests will see" sums the address up, and the coordinates fold away.
 * Booking Admin's Location settings leave it out and keep the plain map. */
export type PropertyAddressLinkMode = {
  /** The long link a maps.app.goo.gl share link opens (the API reads it); null when it can't be read. */
  resolveShortLink: ((url: string) => Promise<string | null>) | null;
  /** The property's name on "Guests will see". */
  guestName: string;
  messages: {
    link: GoogleMapsLinkMessages;
    /** "Paste a Google Maps link", back from address search. */
    pasteLink: string;
    map: PinMapFrameMessages;
    /** Under the map. */
    mapHint: string;
    pinSet: string;
    guestsWillSee: string;
    /** On "Guests will see" while Google looks up a pasted link's address. */
    lookingUp: string;
    /** On "Guests will see" while there is no address. */
    noAddress: string;
    /** Google has no address for a pasted link's pin: the fields stay as they were. */
    noAddressForPin: string;
    /** "Coordinates (advanced)". */
    coordinates: string;
  };
  /** True while a pasted link's address is being looked up: a save then would keep the old address. */
  onLookupChange?: (lookingUp: boolean) => void;
};

const inputBaseClass =
  "block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50";
const inputClass = `mt-1 ${inputBaseClass}`;
const labelClass = "block text-sm font-medium text-gray-700";
const linkButtonClass =
  "inline-flex items-center gap-1.5 text-[12px] font-semibold text-primary-600 hover:text-primary-700 disabled:opacity-50";
const MAX_LENGTH = { streetAddress: 240, postalCode: 32, city: 120, area: 120 } as const;
// A pin placed on the pin map keeps six decimals (about 10 cm), as in the room editor.
const roundCoordinate = (value: number) => Math.round(value * 1e6) / 1e6;
// A pin this far from a road or an area the host picks can't be where guests arrive (VAY-2344).
const STALE_PIN_KM = 2;

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
  linkMode = null,
}: {
  value: PropertyAddress;
  onChange: (patch: Partial<PropertyAddress>) => void;
  apiKey: string;
  disabled?: boolean;
  translate?: Translate;
  /** For the country names. */
  locale?: string;
  markerTitle?: string;
  linkMode?: PropertyAddressLinkMode | null;
}) {
  const t = translate ?? ((key) => propertyAddressEnglish[key]);
  const id = useId();
  // A pick or a link's address still loading is dropped once the host types, picks, pastes or moves the pin.
  const revision = useRef(0);
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  // Where a road or an area picked in search lies: the map shows it, so the next click pins it.
  const [found, setFound] = useState<MapPosition | null>(null);
  // Link mode: the link first, or address search instead.
  const [input, setInput] = useState<"link" | "search">("link");
  const [lookingUp, setLookingUp] = useState(false);
  const [noAddressForPin, setNoAddressForPin] = useState(false);
  // The map and address search keep the handlers they started with: they read this to ignore picks while saving.
  const disabledRef = useRef(disabled);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);
  // A lookup that answers after the form is gone changes nothing.
  useEffect(
    () => () => {
      revision.current += 1;
    },
    [],
  );
  const onLookupChange = useRef(linkMode?.onLookupChange);
  useEffect(() => {
    onLookupChange.current = linkMode?.onLookupChange;
  });
  useEffect(() => {
    onLookupChange.current?.(lookingUp);
  }, [lookingUp]);
  const change = (patch: Partial<PropertyAddress>) => {
    revision.current += 1;
    // Whatever the host does meanwhile wins over a link's address still loading.
    setLookingUp(false);
    setNoAddressForPin(false);
    onChange(patch);
  };
  const hasPin = value.latitude !== null && value.longitude !== null;
  const showMap = Boolean(apiKey) && !mapUnavailable;
  // Without a Maps key there is no search to switch to, nor an address to look up: the plain fields then.
  const links = apiKey ? linkMode : null;
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
  // The address as one line: "Jl. Dukuh Sari, Buruan, 80581 Kabupaten Gianyar, Indonesia".
  const addressLine = (address: PropertyAddress) => {
    const country =
      countries.find((option) => option.code === address.countryCode)?.name ?? address.countryCode;
    const town = [address.postalCode.trim(), address.city.trim()].filter(Boolean).join(" ");
    return [address.streetAddress.trim(), address.area?.trim() ?? "", town, country.trim()]
      .filter(Boolean)
      .join(", ");
  };
  // Link mode, a saved address without a pin (VAY-2482): the map opens on that address, not on the world.
  // It never places the pin: only the host knows the entrance.
  const [unpinnedAddress] = useState(() =>
    links && !hasPin && (value.streetAddress.trim() || value.city.trim())
      ? addressLine(value)
      : null,
  );
  useEffect(() => {
    if (!unpinnedAddress) return;
    let current = true;
    findAddressOnMap(apiKey, unpinnedAddress)
      .then((place) => {
        // An area picked in search meanwhile keeps the map where it is.
        if (current && place) setFound((already) => already ?? place.position);
      })
      .catch(() => {
        /* Google can't look it up: the map still takes a click. */
      });
    return () => {
      current = false;
    };
  }, [apiKey, unpinnedAddress]);

  /** A pasted link's pin, then the address Google gives it (as in onboarding, VAY-2444). Without one the fields
   * stay as typed, for the host to check. */
  const placeFromLink = (pin: MapsLinkPin) => {
    if (disabledRef.current) return;
    change({ latitude: pin.latitude, longitude: pin.longitude });
    const request = revision.current;
    setLookingUp(true);
    void addressFromPin(apiKey, { lat: pin.latitude, lng: pin.longitude }).then((address) => {
      if (request !== revision.current) return;
      if (!address?.city || !address.countryCode) {
        setLookingUp(false);
        setNoAddressForPin(true);
        return;
      }
      // A new place: every part comes from Google, empty where it has none.
      change({
        streetAddress: address.streetAddress,
        area: address.area,
        postalCode: address.postalCode,
        city: address.city,
        countryCode: address.countryCode,
      });
    });
  };
  const text = (key: "streetAddress" | "postalCode" | "city" | "area", label: string) => (
    <label className={labelClass}>
      {label}
      {key === "area" && (
        <span className="ml-1.5 text-xs font-normal text-gray-400">
          {t("propertyAddress.optional")}
        </span>
      )}
      <input
        className={inputClass}
        value={value[key] ?? ""}
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
        {links && input === "link" ? (
          <div>
            <GoogleMapsLinkField
              inputId={`${id}-maps-link`}
              messages={links.messages.link}
              onPin={placeFromLink}
              onClose={() => setInput("search")}
              classNames={{
                label: `${labelClass} mb-1`,
                input: inputBaseClass,
                link: linkButtonClass,
              }}
              resolveShortLink={links.resolveShortLink}
            />
            {noAddressForPin && (
              <p role="status" className="mt-2 text-xs font-medium text-amber-800">
                {links.messages.noAddressForPin}
              </p>
            )}
          </div>
        ) : apiKey ? (
          <div>
            <GooglePlacesAddressField
              apiKey={apiKey}
              label={t("propertyAddress.search")}
              addressRevision={revision}
              onUnavailable={() => setSearchUnavailable(true)}
              onSelect={(address) => {
                if (disabledRef.current) return;
                const exact = address.latitude !== null && address.longitude !== null;
                const place = exact ? null : (address.location ?? null);
                // A road or an area never places the pin; a pin far from it (another town, or the
                // world map clicked by mistake) goes, and the map moves there (VAY-2344).
                const stalePin =
                  place !== null &&
                  value.latitude !== null &&
                  value.longitude !== null &&
                  distanceKm({ latitude: value.latitude, longitude: value.longitude }, place) >
                    STALE_PIN_KM;
                change({
                  streetAddress: address.streetAddress,
                  postalCode: address.postalCode,
                  city: address.city || address.region,
                  countryCode: address.countryCode,
                  // A new address: the old area no longer describes it.
                  area: "",
                  ...(exact
                    ? { latitude: address.latitude, longitude: address.longitude }
                    : stalePin
                      ? { latitude: null, longitude: null }
                      : {}),
                });
                if (place && (stalePin || !hasPin))
                  setFound({ lat: place.latitude, lng: place.longitude });
              }}
            />
            {!searchUnavailable && (
              <p className="mt-1 text-xs text-gray-500">{t("propertyAddress.searchHint")}</p>
            )}
            {links && (
              <button
                type="button"
                onClick={() => setInput("link")}
                className={`${linkButtonClass} mt-2`}
              >
                <LinkIcon className="h-3.5 w-3.5" />
                {links.messages.pasteLink}
              </button>
            )}
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {text("streetAddress", t("propertyAddress.street"))}
          {text("area", t("propertyAddress.area"))}
        </div>
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
        <label className={labelClass}>
          {t("propertyAddress.directions")}
          <span className="ml-1.5 text-xs font-normal text-gray-400">
            {t("propertyAddress.optional")}
          </span>
          <textarea
            className={`${inputClass} min-h-[72px]`}
            value={value.arrivalDirections ?? ""}
            maxLength={1000}
            rows={3}
            disabled={disabled}
            aria-describedby={`${id}-directions-hint`}
            onChange={(event) => change({ arrivalDirections: event.target.value })}
          />
        </label>
        <p id={`${id}-directions-hint`} className="-mt-3 text-xs text-gray-500">
          {t("propertyAddress.directionsHint")}
        </p>
      </div>
      <div className="space-y-2">
        {showMap && links ? (
          <>
            <div className="relative h-64 overflow-hidden rounded-xl border border-gray-200 sm:h-80">
              <PinMapFrame
                apiKey={apiKey}
                latitude={value.latitude}
                longitude={value.longitude}
                markerTitle={markerTitle ?? links.guestName}
                messages={links.messages.map}
                onPick={(position) =>
                  !disabledRef.current &&
                  change({
                    latitude: roundCoordinate(position.lat),
                    longitude: roundCoordinate(position.lng),
                  })
                }
                onUnavailable={() => setMapUnavailable(true)}
                focus={found}
              />
            </div>
            <div className="flex items-start justify-between gap-3">
              <p className="text-[11px] text-gray-500">{links.messages.mapHint}</p>
              {hasPin && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-[11px] font-medium text-green-700">
                  <CheckCircleIcon className="h-3.5 w-3.5" />
                  {links.messages.pinSet}
                </span>
              )}
            </div>
          </>
        ) : showMap ? (
          <div className="relative h-64 overflow-hidden rounded-xl border border-gray-200 sm:h-80">
            <GoogleAddressMap
              active
              apiKey={apiKey}
              latitude={value.latitude}
              longitude={value.longitude}
              focus={found}
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
        {/* With the pin map, the map itself says how to place the pin. */}
        {!hasPin && !(links && showMap) && (
          <p className="text-xs text-amber-800">{t("propertyAddress.noPin")}</p>
        )}
        {links && hasPin && (
          <div aria-live="polite">
            <GuestsWillSeeCard
              label={links.messages.guestsWillSee}
              name={links.guestName}
              address={
                lookingUp
                  ? links.messages.lookingUp
                  : addressLine(value) || links.messages.noAddress
              }
            />
          </div>
        )}
        {/* Open by itself when the map can't place the pin. */}
        <details open={!showMap} className="group">
          {links ? (
            <summary className="flex min-h-11 cursor-pointer select-none list-none items-center gap-1.5 text-[12px] font-semibold text-gray-700 sm:min-h-0 [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
              <span>{links.messages.coordinates}</span>
              {hasPin && (
                <span className="ml-auto font-medium text-gray-400">
                  {value.latitude}, {value.longitude}
                </span>
              )}
            </summary>
          ) : (
            <summary className="flex min-h-11 cursor-pointer select-none items-center text-sm font-medium text-gray-700 sm:min-h-0">
              <span>{t("propertyAddress.coordinates")}</span>
              {hasPin && (
                <span className="ml-2 font-normal text-gray-500">
                  {value.latitude}, {value.longitude}
                </span>
              )}
            </summary>
          )}
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
