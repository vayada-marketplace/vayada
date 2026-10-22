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
  type CoordinateAxis,
} from "@/lib/roomLocation";

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";
// One failed request can be a blip; after this many in a row, address search gives way to typing.
const PLACES_FAILURES_BEFORE_MANUAL = 2;

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
/** A picked suggestion: Google's address and pin, or null when its details couldn't load. */
type PickedPlace = { locationAddress: string; latitude: number; longitude: number } | null;

const inputClass =
  "w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900";
const labelClass = "block text-[12px] font-semibold text-gray-900 mb-1.5";

/** A room type's own address and pin (VAY-2126). Google address search fills the coordinates and the pin can be
 * dragged; without Google (no key, a blocked key, an outage) the host types the address and coordinates. */
export default function RoomLocationField({
  value,
  onChange,
  onValidityChange,
}: {
  value: RoomLocation;
  onChange: (patch: Partial<RoomLocation>) => void;
  /** False while Save would lose what the host typed: an unreadable coordinate, or a pick still loading. */
  onValidityChange: (valid: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [latitudeText, setLatitudeText] = useState(formatCoordinate(value.latitude));
  const [longitudeText, setLongitudeText] = useState(formatCoordinate(value.longitude));
  const [focusedAxis, setFocusedAxis] = useState<CoordinateAxis | null>(null);
  const [map, setMap] = useState<"ready" | "retryable" | "unavailable">(
    GOOGLE_MAPS_API_KEY ? "ready" : "unavailable",
  );
  const [mapAttempt, setMapAttempt] = useState(0);
  const [placesUnavailable, setPlacesUnavailable] = useState(false);
  const [picking, setPicking] = useState(false);
  // A pick still loading is dropped when the host types, drags or removes meanwhile.
  const pickGeneration = useRef(0);

  const coordinates = readCoordinates(latitudeText, longitudeText);
  // Only coordinates the host changed are checked for Save: a room saved earlier with half a pair still saves.
  const edited =
    latitudeText !== formatCoordinate(value.latitude) ||
    longitudeText !== formatCoordinate(value.longitude);
  const valid = !picking && (coordinates.ok || !edited);
  const hasPin = value.latitude != null && value.longitude != null;
  const error = !coordinates.ok && focusedAxis === null ? coordinates.error : null;

  useEffect(() => {
    onValidityChange(valid);
  }, [valid, onValidityChange]);
  // Leaving the tab drops the typed text; the form only ever holds checked values, so it can save again.
  useEffect(() => () => onValidityChange(true), [onValidityChange]);

  function setPin(
    latitude: number | null,
    longitude: number | null,
    other: Partial<RoomLocation> = {},
  ) {
    setLatitudeText(formatCoordinate(latitude));
    setLongitudeText(formatCoordinate(longitude));
    onChange({ ...other, latitude, longitude });
  }

  function cancelPick() {
    pickGeneration.current += 1;
    setPicking(false);
  }

  function commitCoordinates() {
    if (!edited || !coordinates.ok) return;
    setPin(coordinates.latitude, coordinates.longitude);
  }

  function onCoordinateKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter takes the typed value instead of submitting the whole room form.
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitCoordinates();
  }

  function onCoordinatePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pair = parseCoordinatePair(event.clipboardData.getData("text"));
    if (!pair) return;
    event.preventDefault();
    cancelPick();
    setPin(pair.latitude, pair.longitude);
  }

  function pickOnMap(position: MapPosition) {
    cancelPick();
    setPin(roundCoordinate(position.lat), roundCoordinate(position.lng));
  }

  function removeLocation() {
    cancelPick();
    setPin(null, null, { locationAddress: "" });
  }

  const coordinateField = (axis: CoordinateAxis) => {
    const text = axis === "latitude" ? latitudeText : longitudeText;
    const invalid =
      error !== null && (error === "coordinatesPair" ? !text.trim() : error.startsWith(axis));
    return (
      <div className="min-w-0 flex-1">
        <label htmlFor={`${id}-${axis}`} className={labelClass}>
          {t(axis === "latitude" ? "rooms.form.latitude" : "rooms.form.longitude")}
        </label>
        {/* Plain text, not inputMode="decimal": the iPhone decimal pad has no minus key. */}
        <input
          id={`${id}-${axis}`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-coordinates-help`}
          value={text}
          onChange={(event) => {
            cancelPick();
            (axis === "latitude" ? setLatitudeText : setLongitudeText)(event.target.value);
          }}
          onFocus={() => setFocusedAxis(axis)}
          onBlur={() => {
            setFocusedAxis(null);
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
        <div className="lg:col-start-1 lg:row-start-1">
          <RoomAddressSearch
            inputId={`${id}-address`}
            value={value.locationAddress}
            search={map === "ready" && !placesUnavailable}
            hint={
              map !== "ready"
                ? t("rooms.form.addressManualHint")
                : placesUnavailable
                  ? t("rooms.form.addressSearchUnavailable")
                  : t("rooms.form.addressHint")
            }
            onType={(text) => {
              cancelPick();
              onChange({ locationAddress: text });
            }}
            onPickStart={(locationAddress) => {
              pickGeneration.current += 1;
              setPicking(true);
              onChange({ locationAddress });
              return pickGeneration.current;
            }}
            onPicked={(place, generation) => {
              if (generation !== pickGeneration.current) return;
              setPicking(false);
              if (place)
                setPin(place.latitude, place.longitude, { locationAddress: place.locationAddress });
            }}
            onUnavailable={() => setPlacesUnavailable(true)}
          />
        </div>

        <div className="relative h-[220px] overflow-hidden rounded-xl border border-gray-200 lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:h-[300px]">
          {map !== "ready" ? (
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
              {map === "retryable" && (
                <button
                  type="button"
                  onClick={() => {
                    setMap("ready");
                    setPlacesUnavailable(false);
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
                onUnavailable={() =>
                  // A script that loaded but whose key Google rejected doesn't recover by trying again.
                  setMap(
                    (window as Window & { google?: { maps?: unknown } }).google?.maps
                      ? "unavailable"
                      : "retryable",
                  )
                }
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
            id={`${id}-coordinates-help`}
            aria-live="polite"
            className={`text-[11px] mt-1.5 ${error ? "font-medium text-red-600" : "text-gray-400"}`}
          >
            {error
              ? t(`rooms.form.${error}`)
              : t("rooms.form.coordinatesHint", { example: "-8.670458, 115.212629" })}
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

/** The address field: Google suggestions while `search` is on, a plain text field otherwise. It stays one input,
 * so a host typing when search gives way keeps the cursor. */
function RoomAddressSearch({
  inputId,
  value,
  search,
  hint,
  onType,
  onPickStart,
  onPicked,
  onUnavailable,
}: {
  inputId: string;
  value: string;
  search: boolean;
  hint: string;
  onType: (text: string) => void;
  /** Called with the suggestion's text; returns a generation to hand back with the result. */
  onPickStart: (locationAddress: string) => number;
  onPicked: (place: PickedPlace, generation: number) => void;
  onUnavailable: () => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [suggestions, setSuggestions] = useState<PlacePrediction[]>([]);
  const [active, setActive] = useState(-1);
  const places = useRef<PlacesLibrary | null>(null);
  const sessionToken = useRef<object | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only the newest search may show its suggestions.
  const sequence = useRef(0);
  const failures = useRef(0);
  const listId = `${inputId}-suggestions`;
  const open = search && suggestions.length > 0;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function close() {
    sequence.current += 1;
    setSuggestions([]);
    setActive(-1);
  }

  function failed() {
    failures.current += 1;
    if (failures.current >= PLACES_FAILURES_BEFORE_MANUAL) onUnavailable();
  }

  async function loadPlaces(): Promise<PlacesLibrary | null> {
    if (places.current) return places.current;
    try {
      places.current = await importGoogleMapsLibrary<PlacesLibrary>(GOOGLE_MAPS_API_KEY, "places");
      return places.current;
    } catch {
      onUnavailable();
      return null;
    }
  }

  function searchFor(text: string) {
    if (timer.current) clearTimeout(timer.current);
    const current = ++sequence.current;
    setActive(-1);
    if (!search || text.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    timer.current = setTimeout(async () => {
      const library = await loadPlaces();
      if (!library || current !== sequence.current) return;
      sessionToken.current ??= new library.AutocompleteSessionToken();
      try {
        const { suggestions: found } =
          await library.AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: text,
            sessionToken: sessionToken.current,
          });
        failures.current = 0;
        if (current !== sequence.current) return;
        setSuggestions(
          found.flatMap((item) => (item.placePrediction ? [item.placePrediction] : [])).slice(0, 5),
        );
      } catch {
        if (current === sequence.current) setSuggestions([]);
        failed();
      }
    }, 250);
  }

  async function pick(prediction: PlacePrediction) {
    close();
    const generation = onPickStart(prediction.text.text);
    const place = prediction.toPlace();
    try {
      await place.fetchFields({ fields: ["formattedAddress", "location"] });
      failures.current = 0;
    } catch {
      onPicked(null, generation);
      failed();
      return;
    } finally {
      // The selection ends Google's autocomplete session.
      sessionToken.current = null;
    }
    const location = place.location;
    onPicked(
      location
        ? {
            locationAddress: place.formattedAddress || prediction.text.text,
            latitude: roundCoordinate(location.lat()),
            longitude: roundCoordinate(location.lng()),
          }
        : null,
      generation,
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) =>
        index < 0
          ? step > 0
            ? 0
            : suggestions.length - 1
          : (index + step + suggestions.length) % suggestions.length,
      );
    } else if (event.key === "Enter") {
      // Only a highlighted suggestion is taken; Enter on the typed text just closes the list.
      event.preventDefault();
      if (active >= 0) void pick(suggestions[active]);
      else close();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  return (
    <div className="relative">
      <label htmlFor={inputId} className={labelClass}>
        {search ? t("rooms.form.searchAddress") : t("rooms.form.addressManualLabel")}
      </label>
      <div className="relative">
        {search && (
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        )}
        <input
          ref={input}
          id={inputId}
          type="text"
          role={search ? "combobox" : undefined}
          aria-expanded={search ? open : undefined}
          aria-controls={search ? listId : undefined}
          aria-autocomplete={search ? "list" : undefined}
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          aria-describedby={`${inputId}-hint`}
          autoComplete="off"
          value={value}
          onFocus={() => {
            if (search) void loadPlaces();
          }}
          onChange={(event) => {
            onType(event.target.value);
            searchFor(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={close}
          className={`${inputClass} ${search ? "pl-9" : ""} ${value ? "pr-9" : ""}`}
          placeholder={
            search ? t("rooms.form.addressPlaceholder") : t("rooms.form.addressManualPlaceholder")
          }
        />
        {value && (
          <button
            type="button"
            aria-label={t("rooms.form.clearAddress")}
            onClick={() => {
              close();
              onType("");
              input.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-600"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <ul id={listId} role="listbox" aria-label={t("rooms.form.addressSuggestions")}>
            {suggestions.map((prediction, index) => (
              <li
                key={prediction.placeId}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                // Keeps the focus in the field, so its blur doesn't close the list before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void pick(prediction)}
                className={`flex cursor-pointer items-start gap-2.5 px-3 py-2.5 ${
                  index === active ? "bg-gray-50" : "hover:bg-gray-50"
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
      <p id={`${inputId}-hint`} className="text-[11px] text-gray-400 mt-1">
        {hint}
      </p>
    </div>
  );
}
