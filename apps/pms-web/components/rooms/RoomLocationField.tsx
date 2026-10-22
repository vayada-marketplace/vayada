"use client";

import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import {
  ArrowPathIcon,
  ArrowsPointingOutIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import GoogleAddressMap, { type MapPosition } from "@vayada/product-onboarding/GoogleAddressMap";
import { importGoogleMapsLibrary } from "@vayada/product-onboarding/googleMaps";
import { useTranslation } from "@/lib/i18n";
import {
  formatCoordinate,
  parseCoordinatePair,
  readCoordinates,
  roundCoordinate,
} from "@/lib/roomLocation";

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";

export type RoomLocation = {
  locationAddress: string;
  latitude: number | null;
  longitude: number | null;
};

type PlacePrediction = {
  placeId: string;
  text: { text: string };
  mainText?: { text: string } | null;
  secondaryText?: { text: string } | null;
  toPlace: () => {
    fetchFields: (options: { fields: string[] }) => Promise<unknown>;
    formattedAddress?: string | null;
    location?: { lat: () => number; lng: () => number } | null;
  };
};
type PlacesLibrary = {
  AutocompleteSessionToken: new () => object;
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions: (request: {
      input: string;
      sessionToken: object;
    }) => Promise<{ suggestions: { placePrediction?: PlacePrediction | null }[] }>;
  };
};

const inputClass =
  "w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900";

/** A room type's own address and pin (VAY-2126). Google address search fills the coordinates and the pin can be
 * dragged; without Google (no key, a blocked key, an outage) the host types the address and coordinates. */
export default function RoomLocationField({
  value,
  onChange,
  onValidityChange,
}: {
  value: RoomLocation;
  onChange: (patch: Partial<RoomLocation>) => void;
  /** False while a typed coordinate can't be saved. */
  onValidityChange: (valid: boolean) => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [latitudeText, setLatitudeText] = useState(formatCoordinate(value.latitude));
  const [longitudeText, setLongitudeText] = useState(formatCoordinate(value.longitude));
  const [touched, setTouched] = useState({ latitude: false, longitude: false });
  const [mapUnavailable, setMapUnavailable] = useState(!GOOGLE_MAPS_API_KEY);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [placesUnavailable, setPlacesUnavailable] = useState(false);
  const [suggestions, setSuggestions] = useState<PlacePrediction[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const places = useRef<PlacesLibrary | null>(null);
  const sessionToken = useRef<object | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only the newest search may show its suggestions, and only the newest selection may write its address and
  // pin: typing, removing or moving the pin meanwhile wins over a selection still loading.
  const searchSequence = useRef(0);
  const selectionSequence = useRef(0);

  const coordinates = readCoordinates(latitudeText, longitudeText);
  const hasPin = value.latitude != null && value.longitude != null;
  const addressSearch = !mapUnavailable && !placesUnavailable;

  useEffect(() => {
    onValidityChange(coordinates.ok);
  }, [coordinates.ok, onValidityChange]);
  // Leaving the tab drops the typed text; the form only ever holds checked values, so it can save again.
  useEffect(() => () => onValidityChange(true), [onValidityChange]);

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  function setPin(
    latitude: number | null,
    longitude: number | null,
    other: Partial<RoomLocation> = {},
  ) {
    setLatitudeText(formatCoordinate(latitude));
    setLongitudeText(formatCoordinate(longitude));
    onChange({ ...other, latitude, longitude });
  }

  function commitCoordinates() {
    if (!coordinates.ok) return;
    setPin(coordinates.latitude, coordinates.longitude);
  }

  function closeSuggestions() {
    searchSequence.current += 1;
    setSuggestions([]);
    setActiveSuggestion(-1);
  }

  async function loadPlaces(): Promise<PlacesLibrary | null> {
    if (places.current) return places.current;
    try {
      places.current = await importGoogleMapsLibrary<PlacesLibrary>(GOOGLE_MAPS_API_KEY, "places");
      return places.current;
    } catch {
      setPlacesUnavailable(true);
      return null;
    }
  }

  function searchAddress(text: string) {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const sequence = ++searchSequence.current;
    if (!addressSearch || text.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      const library = await loadPlaces();
      if (!library || sequence !== searchSequence.current) return;
      sessionToken.current ??= new library.AutocompleteSessionToken();
      try {
        const { suggestions: found } =
          await library.AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: text,
            sessionToken: sessionToken.current,
          });
        if (sequence !== searchSequence.current) return;
        setSuggestions(
          found.flatMap((item) => (item.placePrediction ? [item.placePrediction] : [])).slice(0, 5),
        );
        setActiveSuggestion(-1);
      } catch {
        if (sequence === searchSequence.current) setPlacesUnavailable(true);
      }
    }, 250);
  }

  async function selectSuggestion(prediction: PlacePrediction) {
    closeSuggestions();
    const sequence = ++selectionSequence.current;
    onChange({ locationAddress: prediction.text.text });
    const place = prediction.toPlace();
    try {
      await place.fetchFields({ fields: ["formattedAddress", "location"] });
    } catch {
      setPlacesUnavailable(true);
      return;
    } finally {
      // The selection ends Google's autocomplete session.
      sessionToken.current = null;
    }
    if (sequence !== selectionSequence.current) return;
    const locationAddress = place.formattedAddress || prediction.text.text;
    const location = place.location;
    if (location) {
      setTouched({ latitude: false, longitude: false });
      setPin(roundCoordinate(location.lat()), roundCoordinate(location.lng()), { locationAddress });
    } else {
      onChange({ locationAddress });
    }
  }

  function onAddressKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveSuggestion((index) =>
        index < 0
          ? step > 0
            ? 0
            : suggestions.length - 1
          : (index + step + suggestions.length) % suggestions.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      void selectSuggestion(suggestions[Math.max(activeSuggestion, 0)]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSuggestions();
    }
  }

  function onCoordinateKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter takes the typed value instead of submitting the whole room form.
    if (event.key !== "Enter") return;
    event.preventDefault();
    setTouched({ latitude: true, longitude: true });
    commitCoordinates();
  }

  function onCoordinatePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pair = parseCoordinatePair(event.clipboardData.getData("text"));
    if (!pair) return;
    event.preventDefault();
    setTouched({ latitude: true, longitude: true });
    setPin(pair.latitude, pair.longitude);
  }

  function pickOnMap(position: MapPosition) {
    selectionSequence.current += 1;
    setTouched({ latitude: false, longitude: false });
    setPin(roundCoordinate(position.lat), roundCoordinate(position.lng));
  }

  function removeLocation() {
    closeSuggestions();
    selectionSequence.current += 1;
    setTouched({ latitude: false, longitude: false });
    setPin(null, null, { locationAddress: "" });
  }

  const error = coordinates.ok
    ? null
    : coordinates.error === "coordinatesPair"
      ? touched.latitude && touched.longitude
        ? coordinates.error
        : null
      : (coordinates.error.startsWith("latitude") ? touched.latitude : touched.longitude)
        ? coordinates.error
        : null;
  const examplePair = "-8.670458, 115.212629";

  const addressField = addressSearch ? (
    <div className="relative">
      <label
        htmlFor={`${listId}-address`}
        className="block text-[12px] font-semibold text-gray-900 mb-1.5"
      >
        {t("rooms.form.searchAddress")}
      </label>
      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          id={`${listId}-address`}
          type="text"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={`${listId}-suggestions`}
          aria-autocomplete="list"
          aria-activedescendant={
            activeSuggestion >= 0 ? `${listId}-suggestion-${activeSuggestion}` : undefined
          }
          autoComplete="off"
          value={value.locationAddress}
          onFocus={() => void loadPlaces()}
          onChange={(event) => {
            selectionSequence.current += 1;
            onChange({ locationAddress: event.target.value });
            searchAddress(event.target.value);
          }}
          onKeyDown={onAddressKeyDown}
          onBlur={closeSuggestions}
          className={`${inputClass} pl-9 pr-9`}
          placeholder={t("rooms.form.addressPlaceholder")}
        />
        {value.locationAddress && (
          <button
            type="button"
            aria-label={t("rooms.form.clearAddress")}
            onClick={() => {
              closeSuggestions();
              selectionSequence.current += 1;
              onChange({ locationAddress: "" });
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-600"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      {suggestions.length > 0 && (
        <div className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <ul
            id={`${listId}-suggestions`}
            role="listbox"
            aria-label={t("rooms.form.addressSuggestions")}
          >
            {suggestions.map((prediction, index) => (
              <li
                key={prediction.placeId}
                id={`${listId}-suggestion-${index}`}
                role="option"
                aria-selected={index === activeSuggestion}
                // Keeps the focus in the field, so its blur doesn't close the list before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void selectSuggestion(prediction)}
                className={`flex cursor-pointer items-start gap-2.5 px-3 py-2.5 ${
                  index === activeSuggestion ? "bg-gray-50" : "hover:bg-gray-50"
                }`}
              >
                <MapPinIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <span className="min-w-0 sm:flex sm:items-baseline sm:gap-1.5">
                  <span className="block truncate text-[13px] font-semibold text-gray-900">
                    {prediction.mainText?.text || prediction.text.text}
                  </span>
                  {prediction.secondaryText?.text && (
                    <span className="block truncate text-[12px] text-gray-500">
                      {prediction.secondaryText.text}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-gray-100 px-3 py-1 text-right text-[10px] text-gray-400">
            powered by <span className="font-bold text-[#5F6368]">Google</span>
          </p>
        </div>
      )}
      <p className="text-[11px] text-gray-400 mt-1">{t("rooms.form.addressHint")}</p>
    </div>
  ) : (
    <div>
      <label
        htmlFor={`${listId}-address`}
        className="block text-[12px] font-semibold text-gray-900 mb-1.5"
      >
        {t("rooms.form.addressManualLabel")}
      </label>
      <input
        id={`${listId}-address`}
        type="text"
        value={value.locationAddress}
        onChange={(event) => onChange({ locationAddress: event.target.value })}
        className={inputClass}
        placeholder={t("rooms.form.addressManualPlaceholder")}
      />
      <p className="text-[11px] text-gray-400 mt-1">
        {mapUnavailable
          ? t("rooms.form.addressManualHint")
          : t("rooms.form.addressSearchUnavailable")}
      </p>
    </div>
  );

  const coordinateField = (axis: "latitude" | "longitude") => {
    const text = axis === "latitude" ? latitudeText : longitudeText;
    const invalid =
      error !== null && (error === "coordinatesPair" ? !text.trim() : error.startsWith(axis));
    return (
      <div className="min-w-0 flex-1">
        <label
          htmlFor={`${listId}-${axis}`}
          className="block text-[12px] font-semibold text-gray-900 mb-1.5"
        >
          {t(axis === "latitude" ? "rooms.form.latitude" : "rooms.form.longitude")}
        </label>
        <input
          id={`${listId}-${axis}`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={invalid || undefined}
          aria-describedby={`${listId}-coordinates-help`}
          value={text}
          onChange={(event) =>
            (axis === "latitude" ? setLatitudeText : setLongitudeText)(event.target.value)
          }
          onBlur={() => {
            setTouched((current) => ({ ...current, [axis]: true }));
            commitCoordinates();
          }}
          onKeyDown={onCoordinateKeyDown}
          onPaste={onCoordinatePaste}
          className={`${inputClass} ${invalid ? "border-red-500 ring-2 ring-red-100" : ""}`}
          placeholder={axis === "latitude" ? "-8.670458" : "115.212629"}
        />
      </div>
    );
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 md:p-5">
      <div className="mb-4">
        <div className="flex min-h-[26px] items-center justify-between gap-3">
          <h3 className="text-[12px] font-bold text-gray-900 uppercase tracking-widest">
            {t("rooms.form.location")}
          </h3>
          {hasPin ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-[11px] font-medium text-green-700">
              <CheckCircleIcon className="h-3.5 w-3.5" />
              {t("rooms.form.pinSet")}
            </span>
          ) : (
            <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700">
              {t("rooms.form.noLocation")}
            </span>
          )}
        </div>
        <p className="text-[11px] text-gray-500 mt-1">{t("rooms.form.locationDescription")}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-x-6">
        <div className="lg:col-start-1 lg:row-start-1">{addressField}</div>

        <div className="relative h-[220px] overflow-hidden rounded-xl border border-gray-200 lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:h-[300px]">
          {mapUnavailable ? (
            <div
              role="status"
              className="flex h-full flex-col items-center justify-center gap-1.5 bg-gray-100 px-7 text-center"
            >
              <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-amber-50">
                <ExclamationTriangleIcon className="h-5 w-5 text-amber-700" />
              </span>
              <p className="text-[13px] font-semibold text-gray-900">
                {t("rooms.form.mapUnavailableTitle")}
              </p>
              <p className="text-[12px] text-gray-500">{t("rooms.form.mapUnavailableBody")}</p>
              {GOOGLE_MAPS_API_KEY && (
                <button
                  type="button"
                  onClick={() => {
                    setMapUnavailable(false);
                    setPlacesUnavailable(false);
                    places.current = null;
                    setMapAttempt((attempt) => attempt + 1);
                  }}
                  className="mt-1 inline-flex items-center gap-1 text-[12px] font-semibold text-primary-600 hover:text-primary-700"
                >
                  <ArrowPathIcon className="h-3.5 w-3.5" />
                  {t("rooms.form.mapRetry")}
                </button>
              )}
            </div>
          ) : (
            <>
              <GoogleAddressMap
                key={mapAttempt}
                active
                apiKey={GOOGLE_MAPS_API_KEY}
                latitude={value.latitude}
                longitude={value.longitude}
                markerTitle={t("rooms.form.roomPin")}
                onPick={pickOnMap}
                onUnavailable={() => setMapUnavailable(true)}
              />
              {hasPin ? (
                <span className="pointer-events-none absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1.5 text-[12px] font-medium text-gray-600 shadow">
                  <ArrowsPointingOutIcon className="h-3.5 w-3.5" />
                  {t("rooms.form.dragPin")}
                </span>
              ) : (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-gray-50/70 px-6 text-center">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full border border-gray-200 bg-white">
                    <MapPinIcon className="h-5 w-5 text-gray-500" />
                  </span>
                  <p className="text-[13px] font-medium text-gray-600">
                    {t("rooms.form.mapEmpty")}
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="lg:col-start-1 lg:row-start-2">
          <div className="flex gap-3">
            {coordinateField("latitude")}
            {coordinateField("longitude")}
          </div>
          <p
            id={`${listId}-coordinates-help`}
            className={`text-[11px] mt-1.5 ${error ? "font-medium text-red-600" : "text-gray-400"}`}
          >
            {error
              ? t(`rooms.form.${error}`)
              : t("rooms.form.coordinatesHint", { example: examplePair })}
          </p>
        </div>

        {(value.locationAddress || hasPin || latitudeText || longitudeText) && (
          <div className="lg:col-start-1 lg:row-start-3">
            <button
              type="button"
              onClick={removeLocation}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-red-600 hover:text-red-700"
            >
              <TrashIcon className="h-3.5 w-3.5" />
              {t("rooms.form.removeLocation")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
