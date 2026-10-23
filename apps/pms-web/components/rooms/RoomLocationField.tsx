"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowsPointingOutIcon,
  BuildingOffice2Icon,
  CheckCircleIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  TrashIcon,
  ViewfinderCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import GoogleAddressMap, {
  type MapPosition,
  type MapType,
} from "@vayada/product-onboarding/GoogleAddressMap";
import { importGoogleMapsLibrary } from "@vayada/product-onboarding/googleMaps";
import { useTranslation } from "@/lib/i18n";
import {
  areaFromAddressComponents,
  formatCoordinate,
  formatDistance,
  metresBetween,
  parseCoordinatePair,
  parseGoogleMapsLink,
  readCoordinates,
  roomLocationSource,
  roundCoordinate,
  type CoordinateAxis,
} from "@/lib/roomLocation";
import { resolveSharedHotelSetupHandoff } from "@/lib/utils/setupHandoff";
import { getPmsPropertyPlace, type PmsPropertyPlace } from "@/services/api/pmsPropertyClient";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";
import type { RoomLocationPrecision, RoomLocationSource } from "@/services/rooms";

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";
// One failed request can be a blip; after this many in a row, address search gives way to typing.
const PLACES_FAILURES_BEFORE_MANUAL = 2;

export type RoomLocation = {
  locationAddress: string;
  latitude: number | null;
  longitude: number | null;
  /** VAY-2321; undefined until the host chooses, then saved. */
  locationSource?: RoomLocationSource;
  locationPrecision?: RoomLocationPrecision;
  locationArea?: string;
  showMapInDetails?: boolean;
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
    addressComponents?: { longText?: string | null; types?: string[] | null }[] | null;
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
/** A picked suggestion: Google's address, pin and area, or null when its details couldn't load. */
type PickedPlace = {
  locationAddress: string;
  latitude: number;
  longitude: number;
  area: string;
} | null;

const inputClass =
  "w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900";
const labelClass = "block text-[12px] font-semibold text-gray-900 mb-1.5";
const linkClass =
  "inline-flex items-center gap-1.5 text-[12px] font-semibold text-primary-600 hover:text-primary-700 disabled:opacity-50";
const mapButtonClass = "rounded-lg bg-white shadow-[0_1px_4px_rgb(0_0_0_/_20%)]";

/** A room type's place (VAY-2126, VAY-2321): "Same as property" (the default) uses the property's address and pin;
 * a "Separate location" has its own, from Google address search, a pasted Google Maps link, the map or typed
 * coordinates, shown to guests exactly or as an area. Without Google the host types the address and coordinates. */
export default function RoomLocationField({
  roomName,
  value,
  onChange,
  onValidityChange,
}: {
  roomName: string;
  value: RoomLocation;
  onChange: (patch: Partial<RoomLocation>) => void;
  /** False while Save would lose what the host typed: an unreadable coordinate, or a pick still loading. */
  onValidityChange: (valid: boolean) => void;
}) {
  const { t, locale } = useTranslation();
  const id = useId();
  const [latitudeText, setLatitudeText] = useState(formatCoordinate(value.latitude));
  const [longitudeText, setLongitudeText] = useState(formatCoordinate(value.longitude));
  const [focusedAxis, setFocusedAxis] = useState<CoordinateAxis | null>(null);
  const [map, setMap] = useState<"ready" | "retryable" | "unavailable">(
    GOOGLE_MAPS_API_KEY ? "ready" : "unavailable",
  );
  const [mapAttempt, setMapAttempt] = useState(0);
  const [mapType, setMapType] = useState<MapType>("roadmap");
  const [recenter, setRecenter] = useState(0);
  const [placesUnavailable, setPlacesUnavailable] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // The property's own place: what "Same as property" uses and what a separate room is placed by.
  const [property, setProperty] = useState<PmsPropertyPlace | "loading" | "failed">("loading");
  const [propertyLinkFailed, setPropertyLinkFailed] = useState(false);
  // A pick still loading is dropped when the host types, drags or removes meanwhile.
  const pickGeneration = useRef(0);

  const coordinates = readCoordinates(latitudeText, longitudeText);
  // Only coordinates the host changed are checked for Save: a room saved earlier with half a pair still saves.
  const edited =
    latitudeText !== formatCoordinate(value.latitude) ||
    longitudeText !== formatCoordinate(value.longitude);
  const hasPin = value.latitude != null && value.longitude != null;
  const error = !coordinates.ok && focusedAxis === null ? coordinates.error : null;
  const place = typeof property === "object" ? property : null;
  const separate = roomLocationSource(value, place?.pin ?? null) === "custom";
  // The coordinate fields only exist for a separate location; "Same as property" never holds Save.
  const valid = !separate || (!picking && (coordinates.ok || !edited));
  // As saved: going back to the choice a room had without one restores "no choice", so nothing is written.
  const savedSource = useRef(value.locationSource);
  // With no pin of its own yet, the map opens on the property's area, close enough to place the pin by click.
  const focusLatitude = place?.pin?.latitude;
  const focusLongitude = place?.pin?.longitude;
  const focus = useMemo(
    () =>
      focusLatitude !== undefined && focusLongitude !== undefined
        ? { lat: focusLatitude, lng: focusLongitude }
        : null,
    [focusLatitude, focusLongitude],
  );
  const approximate = separate && value.locationPrecision === "approximate";
  // Typing needs the fields; a half pair saved earlier shows what is wrong with it.
  const advancedShown = advancedOpen || map !== "ready" || !coordinates.ok;

  useEffect(() => {
    onValidityChange(valid);
  }, [valid, onValidityChange]);
  // Leaving the tab drops the typed text; the form only ever holds checked values, so it can save again.
  useEffect(() => () => onValidityChange(true), [onValidityChange]);

  useEffect(() => {
    let disposed = false;
    const load = () =>
      getPmsPropertyPlace()
        .then((found) => !disposed && setProperty(found))
        // A failed re-read keeps the place already shown.
        .catch(
          () => !disposed && setProperty((current) => (current === "loading" ? "failed" : current)),
        );
    void load();
    // Back from editing the address in Booking Admin's tab: show the address saved there.
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  /** An edit of the room's own place also saves "Separate location", so a room that was one only by having a
   * pin (saved before VAY-2321) stays one when its pin is cleared. */
  function edit(patch: Partial<RoomLocation>) {
    onChange(value.locationSource ? patch : { locationSource: "custom", ...patch });
  }

  function chooseSource(source: RoomLocationSource) {
    // A pick still loading or coordinates half typed belong to the place being left.
    cancelPick();
    setLatitudeText(formatCoordinate(value.latitude));
    setLongitudeText(formatCoordinate(value.longitude));
    const derived = roomLocationSource({ ...value, locationSource: undefined }, place?.pin ?? null);
    onChange({
      locationSource: savedSource.current === undefined && source === derived ? undefined : source,
    });
  }

  function setPin(
    latitude: number | null,
    longitude: number | null,
    other: Partial<RoomLocation> = {},
  ) {
    setLatitudeText(formatCoordinate(latitude));
    setLongitudeText(formatCoordinate(longitude));
    edit({ ...other, latitude, longitude });
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

  function onMapUnavailable() {
    // A script that loaded but whose key Google rejected doesn't recover by trying again.
    setMap(
      (window as Window & { google?: { maps?: unknown } }).google?.maps
        ? "unavailable"
        : "retryable",
    );
  }

  /** Booking Admin's Location page, in a new tab so the room's unsaved edits stay (until VAY-2322's modal). */
  async function openPropertyAddress() {
    setPropertyLinkFailed(false);
    // Opened before the handoff resolves: a tab opened after an await is a blocked popup. Without a tab the
    // room page stays, so its unsaved edits do too.
    const tab = window.open("", "_blank");
    if (!tab) {
      setPropertyLinkFailed(true);
      return;
    }
    try {
      const handoff = await resolveSharedHotelSetupHandoff({
        targetPath: "/settings/location",
        csrfToken: getAuthCsrfToken(),
        ...(place ? { propertyId: place.propertyId } : {}),
      });
      if (handoff.kind === "retryable")
        throw new Error("The Booking Admin handoff is unavailable.");
      tab.opener = null;
      tab.location.href = handoff.destination;
    } catch {
      tab.close();
      setPropertyLinkFailed(true);
    }
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

  const status = (() => {
    if (!separate && property === "loading") return null;
    if (!separate && property === "failed") {
      return (
        <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700">
          {t("rooms.form.propertyUnavailableChip")}
        </span>
      );
    }
    if (separate ? hasPin : place?.pin) {
      return (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-[11px] font-medium text-green-700">
          <CheckCircleIcon className="h-3.5 w-3.5" />
          {t("rooms.form.pinSet")}
        </span>
      );
    }
    return (
      <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700">
        {t(separate ? "rooms.form.pickAddress" : "rooms.form.propertyNoPin")}
      </span>
    );
  })();

  const mapUnavailable = (
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
  );

  const detailsSwitch = (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p id={`${id}-details-map`} className="text-[12px] font-semibold text-gray-900">
          {t("rooms.form.showMapInDetails")}
        </p>
        <p className="text-[11px] text-gray-500">{t("rooms.form.showMapInDetailsHint")}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value.showMapInDetails ?? true}
        aria-labelledby={`${id}-details-map`}
        onClick={() => onChange({ showMapInDetails: !(value.showMapInDetails ?? true) })}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${
          (value.showMapInDetails ?? true) ? "bg-primary-600" : "bg-gray-200"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
            (value.showMapInDetails ?? true) ? "translate-x-4" : ""
          }`}
        />
      </button>
    </div>
  );

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 md:p-5">
      <div className="mb-4">
        <div className="flex min-h-[26px] items-center justify-between gap-3">
          <h3 className="text-[12px] font-bold text-gray-900 uppercase tracking-widest">
            {t("rooms.form.location")}
          </h3>
          {status}
        </div>
        <p className="text-[11px] text-gray-500 mt-1">{t("rooms.form.locationDescription")}</p>
      </div>

      {property === "loading" ? (
        <div className="h-24 animate-pulse rounded-xl bg-gray-100" aria-busy="true" />
      ) : (
        <div className="space-y-4">
          <div
            role="radiogroup"
            aria-label={t("rooms.form.locationSource")}
            onKeyDown={(event) => {
              // Arrow keys move between the two choices, as in a native radio group.
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault();
              const group = event.currentTarget;
              chooseSource(separate ? "property" : "custom");
              requestAnimationFrame(() =>
                group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus(),
              );
            }}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3"
          >
            <SourceCard
              selected={!separate}
              icon={<BuildingOffice2Icon className="h-4 w-4" />}
              title={t("rooms.form.sameAsProperty")}
              hint={t("rooms.form.sameAsPropertyHint")}
              onSelect={() => separate && chooseSource("property")}
            />
            <SourceCard
              selected={separate}
              icon={<MapPinIcon className="h-4 w-4" />}
              title={t("rooms.form.separateLocation")}
              hint={t("rooms.form.separateLocationHint")}
              onSelect={() => !separate && chooseSource("custom")}
            />
          </div>

          {!separate ? (
            <>
              <div className="flex flex-col gap-3 rounded-xl border border-gray-200 p-3 sm:flex-row sm:items-center sm:gap-5">
                <div className="relative h-[160px] w-full shrink-0 overflow-hidden rounded-lg border border-gray-200 sm:h-[170px] sm:w-[360px]">
                  {place?.pin && map === "ready" ? (
                    <GoogleAddressMap
                      key={mapAttempt}
                      active
                      apiKey={GOOGLE_MAPS_API_KEY}
                      latitude={place.pin.latitude}
                      longitude={place.pin.longitude}
                      markerTitle={place.name}
                      onUnavailable={onMapUnavailable}
                    />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 bg-gray-50 px-6 text-center">
                      <MapPinIcon className="h-5 w-5 text-gray-400" />
                      <p className="text-[12px] text-gray-500">
                        {place && !place.pin
                          ? t("rooms.form.propertyNoPinBody")
                          : place
                            ? t("rooms.form.mapUnavailableTitle")
                            : t("rooms.form.propertyUnavailable")}
                      </p>
                    </div>
                  )}
                </div>
                <div className="min-w-0 space-y-1">
                  {place && (
                    <>
                      <p className="text-[13px] font-semibold text-gray-900">{place.name}</p>
                      {place.address && (
                        <p className="text-[12px] text-gray-600">{place.address}</p>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => void openPropertyAddress()}
                    className={linkClass}
                    title={t("rooms.form.editPropertyAddressHint")}
                  >
                    <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                    {t("rooms.form.editPropertyAddress")}
                  </button>
                  {propertyLinkFailed && (
                    <p role="alert" className="text-[11px] font-medium text-red-600">
                      {t("rooms.form.editPropertyAddressFailed")}
                    </p>
                  )}
                </div>
              </div>
              {detailsSwitch}
            </>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[400px_minmax(0,1fr)] lg:gap-x-6">
              <div className="space-y-2 lg:col-start-1 lg:row-start-1">
                {pasting ? (
                  <GoogleMapsLink
                    inputId={`${id}-maps-link`}
                    onPin={(pin) => {
                      cancelPick();
                      // A new place: the previous address and area no longer describe it.
                      setPin(pin.latitude, pin.longitude, {
                        locationAddress: "",
                        locationArea: "",
                      });
                    }}
                    onClose={() => setPasting(false)}
                  />
                ) : (
                  <>
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
                        edit({ locationAddress: text });
                      }}
                      onPickStart={(locationAddress) => {
                        pickGeneration.current += 1;
                        setPicking(true);
                        edit({ locationAddress });
                        return pickGeneration.current;
                      }}
                      onPicked={(picked, generation) => {
                        if (generation !== pickGeneration.current) return;
                        setPicking(false);
                        if (picked)
                          setPin(picked.latitude, picked.longitude, {
                            locationAddress: picked.locationAddress,
                            ...(picked.area ? { locationArea: picked.area } : {}),
                          });
                      }}
                      onUnavailable={() => setPlacesUnavailable(true)}
                    />
                    <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                      {map === "ready" && (
                        <button
                          type="button"
                          onClick={() => setPasting(true)}
                          className={linkClass}
                        >
                          <LinkIcon className="h-3.5 w-3.5" />
                          {t("rooms.form.pasteMapsLink")}
                        </button>
                      )}
                      {place && (place.pin || place.address) && (
                        <button
                          type="button"
                          onClick={() => {
                            cancelPick();
                            if (place.pin)
                              setPin(place.pin.latitude, place.pin.longitude, {
                                locationAddress: place.address,
                                locationArea: "",
                              });
                            else edit({ locationAddress: place.address, locationArea: "" });
                          }}
                          className={linkClass}
                        >
                          <BuildingOffice2Icon className="h-3.5 w-3.5" />
                          {t("rooms.form.usePropertyAddress")}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
                <div className="relative h-[240px] overflow-hidden rounded-xl border border-gray-200 lg:h-[460px]">
                  {map !== "ready" ? (
                    mapUnavailable
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
                        onUnavailable={onMapUnavailable}
                        reference={place?.pin ? { ...place.pin, title: place.name } : null}
                        mapType={mapType}
                        area={approximate}
                        recenter={recenter}
                        focus={hasPin ? null : focus}
                      />
                      {!hasPin && (
                        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-gray-50/70 px-6 text-center">
                          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-gray-200 bg-white">
                            <MapPinIcon className="h-5 w-5 text-gray-500" />
                          </span>
                          <p className="text-[13px] font-medium text-gray-600">
                            {t("rooms.form.mapEmpty")}
                          </p>
                        </div>
                      )}
                      <div
                        role="group"
                        aria-label={t("rooms.form.mapType")}
                        className={`absolute left-2.5 top-2.5 flex gap-0.5 p-[3px] ${mapButtonClass}`}
                      >
                        {(["roadmap", "satellite"] as const).map((type) => (
                          <button
                            key={type}
                            type="button"
                            aria-pressed={mapType === type}
                            onClick={() => setMapType(type)}
                            className={`rounded-md px-2.5 py-1 text-[12px] font-semibold ${
                              mapType === type ? "bg-gray-900 text-white" : "text-gray-600"
                            }`}
                          >
                            {t(
                              type === "roadmap"
                                ? "rooms.form.mapView"
                                : "rooms.form.satelliteView",
                            )}
                          </button>
                        ))}
                      </div>
                      {hasPin && !approximate && (
                        <span className="pointer-events-none absolute left-2.5 top-[52px] inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1.5 text-[12px] font-medium text-gray-600 shadow">
                          <ArrowsPointingOutIcon className="h-3.5 w-3.5" />
                          {t("rooms.form.dragPin")}
                        </span>
                      )}
                      {hasPin && (
                        <button
                          type="button"
                          onClick={() => setRecenter((count) => count + 1)}
                          className={`absolute bottom-7 right-2.5 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold text-gray-700 ${mapButtonClass}`}
                        >
                          <ViewfinderCircleIcon className="h-3.5 w-3.5" />
                          {t("rooms.form.recenter")}
                        </button>
                      )}
                    </>
                  )}
                </div>
                {map === "ready" && (
                  <p className="mt-1.5 text-[11px] text-gray-400">{t("rooms.form.mapClickHint")}</p>
                )}
              </div>

              <div className="space-y-4 lg:col-start-1 lg:row-start-2">
                {hasPin && (
                  <div className="space-y-1 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                      {t("rooms.form.guestsWillSee")}
                    </p>
                    <p className="text-[13px] font-semibold text-gray-900">
                      {roomName.trim() || t("rooms.form.thisRoom")}
                    </p>
                    <p className="text-[12px] text-gray-600">
                      {approximate
                        ? value.locationArea?.trim()
                          ? t("rooms.form.areaSummary", { area: value.locationArea.trim() })
                          : t("rooms.form.areaSummaryUnnamed")
                        : value.locationAddress}
                    </p>
                    {place?.pin && (
                      <p className="inline-flex items-center gap-1 text-[12px] text-gray-500">
                        <MapPinIcon className="h-3.5 w-3.5" />
                        {t(approximate ? "rooms.form.distanceAbout" : "rooms.form.distanceFrom", {
                          distance: formatDistance(
                            metresBetween(place.pin, {
                              latitude: value.latitude!,
                              longitude: value.longitude!,
                            }),
                            locale,
                          ),
                          property: place.name,
                        })}
                      </p>
                    )}
                  </div>
                )}

                {hasPin && (
                  <fieldset className="space-y-1.5">
                    <legend className={labelClass}>{t("rooms.form.showToGuestsAs")}</legend>
                    {(["exact", "approximate"] as const).map((precision) => (
                      <label
                        key={precision}
                        className="flex cursor-pointer items-start gap-2.5 py-1"
                      >
                        <input
                          type="radio"
                          name={`${id}-precision`}
                          checked={(precision === "approximate") === approximate}
                          onChange={() => edit({ locationPrecision: precision })}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-primary-600"
                        />
                        <span className="min-w-0">
                          <span className="block text-[12px] font-semibold text-gray-900">
                            {t(
                              precision === "exact"
                                ? "rooms.form.precisionExact"
                                : "rooms.form.precisionApproximate",
                            )}
                          </span>
                          <span className="block text-[11px] text-gray-500">
                            {t(
                              precision === "exact"
                                ? "rooms.form.precisionExactHint"
                                : "rooms.form.precisionApproximateHint",
                            )}
                          </span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}

                {approximate && (
                  <div>
                    <label htmlFor={`${id}-area`} className={labelClass}>
                      {t("rooms.form.areaName")}
                    </label>
                    <input
                      id={`${id}-area`}
                      type="text"
                      maxLength={120}
                      value={value.locationArea ?? ""}
                      onChange={(event) => edit({ locationArea: event.target.value })}
                      aria-describedby={`${id}-area-hint`}
                      className={inputClass}
                    />
                    <p id={`${id}-area-hint`} className="mt-1 text-[11px] text-gray-400">
                      {t("rooms.form.areaNameHint")}
                    </p>
                  </div>
                )}

                {detailsSwitch}

                <div>
                  <button
                    type="button"
                    aria-expanded={advancedShown}
                    aria-controls={`${id}-coordinates`}
                    onClick={() => setAdvancedOpen((open) => !open)}
                    className="flex w-full items-center gap-1.5 text-left text-[12px] font-semibold text-gray-700"
                  >
                    <ChevronRightIcon
                      className={`h-3.5 w-3.5 transition-transform ${advancedShown ? "rotate-90" : ""}`}
                    />
                    {t("rooms.form.coordinatesAdvanced")}
                    {hasPin && !advancedShown && (
                      <span className="ml-auto font-medium text-gray-400">
                        {formatCoordinate(value.latitude)}, {formatCoordinate(value.longitude)}
                      </span>
                    )}
                  </button>
                  {advancedShown && (
                    <div id={`${id}-coordinates`} className="mt-3 space-y-3">
                      <div>
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
                            : t("rooms.form.coordinatesHint", {
                                example: "-8.670458, 115.212629",
                              })}
                        </p>
                      </div>
                      {(value.locationAddress || hasPin || latitudeText || longitudeText) && (
                        <button
                          type="button"
                          onClick={removeLocation}
                          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-red-600 hover:text-red-700"
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                          {t("rooms.form.removeLocation")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SourceCard({
  selected,
  icon,
  title,
  hint,
  onSelect,
}: {
  selected: boolean;
  icon: ReactNode;
  title: string;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
        selected ? "border-primary-200 bg-primary-50" : "border-gray-200 bg-white hover:bg-gray-50"
      }`}
    >
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px] bg-white ${
          selected ? "border-primary-600" : "border-gray-300"
        }`}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-primary-600" />}
      </span>
      <span className="min-w-0">
        <span
          className={`flex items-center gap-1.5 text-[13px] font-semibold text-gray-900 ${
            selected ? "[&>svg]:text-primary-600" : "[&>svg]:text-gray-500"
          }`}
        >
          {icon}
          {title}
        </span>
        <span className="mt-0.5 block text-[12px] text-gray-500">{hint}</span>
      </span>
    </button>
  );
}

/** "Paste a Google Maps link": the pin from a long link; a short share link has no coordinates to read. */
function GoogleMapsLink({
  inputId,
  onPin,
  onClose,
}: {
  inputId: string;
  onPin: (pin: { latitude: number; longitude: number }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [result, setResult] = useState<ReturnType<typeof parseGoogleMapsLink> | undefined>();

  function read(link: string) {
    setText(link);
    const found = link.trim() ? parseGoogleMapsLink(link) : undefined;
    setResult(found);
    if (found && typeof found === "object") onPin(found);
  }

  return (
    <div>
      <label htmlFor={inputId} className={labelClass}>
        {t("rooms.form.mapsLinkLabel")}
      </label>
      <div className="relative">
        <LinkIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(event) => read(event.target.value)}
          onKeyDown={(event) => {
            // Enter reads the link instead of submitting the whole room form.
            if (event.key === "Enter") event.preventDefault();
          }}
          aria-describedby={`${inputId}-result`}
          className={`${inputClass} pl-9`}
          placeholder="https://www.google.com/maps/place/…"
        />
      </div>
      <p
        id={`${inputId}-result`}
        aria-live="polite"
        className={`mt-1 text-[11px] ${
          result && typeof result === "object"
            ? "font-medium text-green-700"
            : result
              ? "font-medium text-amber-700"
              : result === null
                ? "font-medium text-amber-700"
                : "text-gray-400"
        }`}
      >
        {result && typeof result === "object"
          ? t("rooms.form.mapsLinkPlaced", {
              coordinates: `${formatCoordinate(result.latitude)}, ${formatCoordinate(result.longitude)}`,
            })
          : result === "short_link"
            ? t("rooms.form.mapsLinkShort")
            : result === null
              ? t("rooms.form.mapsLinkNone")
              : t("rooms.form.mapsLinkHint")}
      </p>
      <button type="button" onClick={onClose} className={`${linkClass} mt-2`}>
        <MagnifyingGlassIcon className="h-3.5 w-3.5" />
        {t("rooms.form.searchInstead")}
      </button>
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
  // The last search found nothing: the hint to drop the pin instead still shows.
  const [noResults, setNoResults] = useState(false);
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
    setNoResults(false);
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
        const predictions = found
          .flatMap((item) => (item.placePrediction ? [item.placePrediction] : []))
          .slice(0, 5);
        setSuggestions(predictions);
        setNoResults(predictions.length === 0);
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
      await place.fetchFields({ fields: ["formattedAddress", "location", "addressComponents"] });
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
            area: areaFromAddressComponents(place.addressComponents),
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
          <p className="flex items-center gap-1.5 border-t border-gray-100 bg-gray-50 px-3 py-2 text-[12px] font-medium text-gray-600">
            <MapPinIcon className="h-3.5 w-3.5 shrink-0 text-gray-500" />
            {t("rooms.form.cantFindAddress")}
          </p>
          <p className="border-t border-gray-100 px-3 py-1 text-right text-[10px] text-gray-400">
            powered by <span className="font-bold text-[#5F6368]">Google</span>
          </p>
        </div>
      )}
      {search && noResults && !open && (
        <p className="mt-1 flex items-center gap-1.5 text-[12px] font-medium text-gray-600">
          <MapPinIcon className="h-3.5 w-3.5 shrink-0 text-gray-500" />
          {t("rooms.form.cantFindAddress")}
        </p>
      )}
      <p id={`${inputId}-hint`} className="text-[11px] text-gray-400 mt-1">
        {hint}
      </p>
    </div>
  );
}
