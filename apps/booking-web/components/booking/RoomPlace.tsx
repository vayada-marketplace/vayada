"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocale, useTranslations } from "next-intl";
import { metresBetween } from "@vayada/domain-hotels";
import { importGoogleMapsLibrary } from "@vayada/product-onboarding/googleMaps";
import { onGoogleAuthFailure } from "@/lib/googleMapsFailure";
import { chooseMaps, mapsChosen } from "@/lib/mapsChoice";
import type { CatalogLocationMap, PricingRoom } from "@/services/api/replacementOffers";

type LatLng = { lat: number; lng: number };
type GoogleMap = {
  fitBounds: (bounds: unknown, padding?: number) => void;
  getZoom?: () => number | undefined;
  setZoom?: (zoom: number) => void;
  addListener?: (event: "idle", handler: () => void) => { remove: () => void };
};
type MapsLibrary = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => GoogleMap;
  Circle: new (options: Record<string, unknown>) => unknown;
};
type MarkerLibrary = { Marker: new (options: Record<string, unknown>) => unknown };
type CoreLibrary = {
  LatLngBounds: new () => { extend: (position: LatLng) => void };
  Point: new (x: number, y: number) => unknown;
};

/** The hotel's location map as the room catalog sends it (VAY-2126), with the hotel's name and locality. */
export type GuestPlace = {
  name: string;
  locality: string;
  pin: CatalogLocationMap["property"];
};

// The pin shape (30 × 40, point at the bottom), as on the Location section's map.
const PIN_PATH = "M15 0C6.7 0 0 6.7 0 15C0 26 15 40 15 40S30 26 30 15C30 6.7 23.3 0 15 0Z";
// An "Approximate area" is rounded to about 1 km: drawn as an area this big.
const AREA_RADIUS_METRES = 1000;
const MAX_FITTED_ZOOM = 16;
// A map that hasn't drawn by then (a hanging script) counts as failed.
const LOAD_TIMEOUT_MS = 12_000;
// google.maps.SymbolPath.CIRCLE.
const SYMBOL_CIRCLE = 0;

type Place = {
  name: string;
  address: string | null;
  pin: { latitude: number; longitude: number };
  approximate: boolean;
  /** The main property, to place a room at its own address by. */
  reception: { latitude: number; longitude: number } | null;
  distance: number | null;
  /** Measured from or to a rounded spot: shown as "About …", in whole kilometres. */
  distanceApproximate: boolean;
};

/** Where the room is, as guests may see it: its own place (exact, or an area without its street), or the property's
 * public pin for a room "Same as property". Null when the room's details show no map. */
export function roomPlace(room: PricingRoom, property: GuestPlace | null): Place | null {
  if (!property || room.showMapInDetails === false) return null;
  const own = room.location;
  if (own) {
    const pin = { latitude: own.latitude, longitude: own.longitude };
    // A rounded property pin would look like an exact spot: the reference is drawn only for an exact one.
    const reception = property.pin && !property.pin.approximate ? property.pin : null;
    return {
      name: room.name,
      address: (own.approximate ? own.area : own.address) ?? null,
      pin,
      approximate: own.approximate === true,
      reception: reception && { latitude: reception.latitude, longitude: reception.longitude },
      distance: property.pin ? metresBetween(pin, property.pin) : null,
      distanceApproximate: own.approximate === true || property.pin?.approximate === true,
    };
  }
  // A catalog from before VAY-2321 doesn't say: a room without a pin of its own is at the property.
  if ((room.atProperty ?? true) && property.pin) {
    return {
      name: property.name,
      address: property.locality || null,
      pin: { latitude: property.pin.latitude, longitude: property.pin.longitude },
      approximate: property.pin.approximate,
      reception: null,
      distance: null,
      distanceApproximate: false,
    };
  }
  return null;
}

/** "Where you'll stay" in the room's details (VAY-2323). Booking pages talk to no third party on their own
 * (VAY-2216): Google Maps loads only after the guest presses "Show map" (remembered for this tab); the place's
 * name, address and Directions show without it. An "Approximate area" shows a circle and the area's name, never a
 * street or Directions. */
export default function RoomPlace({
  room,
  property,
  apiKey,
}: {
  room: PricingRoom;
  property: GuestPlace | null;
  apiKey: string;
}) {
  const t = useTranslations("roomPlace");
  const tm = useTranslations("locationMap");
  const locale = useLocale();
  const [requested, setRequested] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const expandRef = useRef<HTMLButtonElement>(null);
  const place = roomPlace(room, property);

  useEffect(() => {
    if (mapsChosen()) setRequested(true);
  }, []);

  if (!place || !apiKey) return null;
  const distance =
    place.distance === null
      ? null
      : t(place.distanceApproximate ? "distanceAbout" : "distance", {
          distance: formatDistance(place.distance, locale, place.distanceApproximate),
        });
  const directions = place.approximate
    ? null
    : `https://www.google.com/maps/dir/?api=1&destination=${place.pin.latitude},${place.pin.longitude}`;

  return (
    <section
      aria-labelledby={`room-place-${room.roomTypeId}`}
      className="mb-5 border-t border-gray-200 pt-5"
    >
      <div className="mb-3 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
        <h3 id={`room-place-${room.roomTypeId}`} className="text-lg font-bold text-gray-900">
          {t("title")}
        </h3>
        {distance && <p className="text-sm text-gray-500">{distance}</p>}
      </div>
      <div className="relative h-[210px] overflow-hidden rounded-xl border border-gray-200 bg-gray-100">
        {requested ? (
          <PlaceMap
            place={place}
            apiKey={apiKey}
            label={t("mapLabel")}
            onFailed={() => setMapFailed(true)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <button
              type="button"
              onClick={() => {
                chooseMaps();
                setRequested(true);
              }}
              className="rounded-full bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
            >
              {tm("showMap")}
            </button>
            <p className="max-w-xs text-sm text-gray-500">{tm("mapNote")}</p>
          </div>
        )}
        {requested && !mapFailed && (
          <button
            ref={expandRef}
            type="button"
            onClick={() => setExpanded(true)}
            className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-700 shadow"
          >
            <ExpandIcon />
            {t("expandMap")}
          </button>
        )}
      </div>
      <div className="mt-3 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900">
            {place.approximate ? place.address || place.name : place.name}
          </p>
          <p className="text-sm text-gray-500">
            {place.approximate ? t("areaNote") : place.address}
          </p>
        </div>
        {directions && <DirectionsLink href={directions} label={t("directions")} />}
      </div>
      {expanded && (
        <FullScreenMap
          place={place}
          apiKey={apiKey}
          title={t("title")}
          subtitle={
            place.approximate
              ? place.address || place.name
              : [place.name, place.address].filter(Boolean).join(" · ")
          }
          closeLabel={t("closeMap")}
          mapLabel={t("mapLabel")}
          directions={directions && <DirectionsLink href={directions} label={t("directions")} />}
          onClose={() => setExpanded(false)}
        />
      )}
    </section>
  );
}

function DirectionsLink({ href, label }: { href: string; label: string }) {
  // Google Maps' cross-platform directions link: the app on iOS and Android, the website elsewhere.
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 sm:self-auto"
    >
      <svg
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.8}
          d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
        />
      </svg>
      {label}
    </a>
  );
}

function ExpandIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
        d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
      />
    </svg>
  );
}

function FullScreenMap({
  place,
  apiKey,
  title,
  subtitle,
  closeLabel,
  mapLabel,
  directions,
  onClose,
}: {
  place: Place;
  apiKey: string;
  title: string;
  subtitle: string;
  closeLabel: string;
  mapLabel: string;
  directions: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  // Once per opening (not on every render of the page behind): focus the close button, and give the focus back
  // to "Expand map" when the map closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    // Escape closes the map only, not the room's details underneath.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus();
    };
  }, []);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[110] flex flex-col bg-white"
    >
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-lg font-bold text-gray-900">
            {title}
          </h2>
          <p className="truncate text-sm text-gray-500">{subtitle}</p>
        </div>
        <div className="hidden sm:block">{directions}</div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="rounded-full border border-gray-200 p-1.5 text-gray-500 hover:bg-gray-50"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
      <div className="relative flex-1">
        <PlaceMap place={place} apiKey={apiKey} label={mapLabel} large />
      </div>
      {directions && (
        <div className="flex justify-center border-t border-gray-200 px-4 py-2.5 sm:hidden">
          {directions}
        </div>
      )}
    </div>,
    document.body,
  );
}

function PlaceMap({
  place,
  apiKey,
  label,
  large = false,
  onFailed,
}: {
  place: Place;
  apiKey: string;
  label: string;
  large?: boolean;
  onFailed?: () => void;
}) {
  const tm = useTranslations("locationMap");
  const t = useTranslations("roomPlace");
  const mapRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const placeKey = JSON.stringify(place);
  const reception = t("reception");
  const onFailedRef = useRef(onFailed);
  useEffect(() => {
    onFailedRef.current = onFailed;
  });
  useEffect(() => {
    if (failed) onFailedRef.current?.();
  }, [failed]);

  useEffect(() => {
    if (!mapRef.current) return;
    const stopListening = onGoogleAuthFailure(() => setFailed(true));
    let disposed = false;
    const timeout = setTimeout(() => {
      if (!disposed) setFailed(true);
    }, LOAD_TIMEOUT_MS);
    void Promise.all([
      importGoogleMapsLibrary<MapsLibrary>(apiKey, "maps"),
      importGoogleMapsLibrary<MarkerLibrary>(apiKey, "marker"),
      importGoogleMapsLibrary<CoreLibrary>(apiKey, "core"),
    ])
      .then(([{ Map, Circle }, { Marker }, { LatLngBounds, Point }]) => {
        if (disposed || !mapRef.current) return;
        clearTimeout(timeout);
        const center = { lat: place.pin.latitude, lng: place.pin.longitude };
        const color = brandRef.current ? getComputedStyle(brandRef.current).color : "#1E3EDB";
        const map = new Map(mapRef.current, {
          center,
          zoom: place.approximate ? 14 : 15,
          clickableIcons: false,
          disableDefaultUI: true,
          zoomControl: large,
          gestureHandling: large ? "greedy" : "cooperative",
        });
        if (place.approximate) {
          // Only the area: no pin on a spot that isn't the room's.
          new Circle({
            map,
            center,
            radius: AREA_RADIUS_METRES,
            fillColor: color,
            fillOpacity: 0.15,
            strokeColor: color,
            strokeOpacity: 0.6,
            strokeWeight: 2,
            clickable: false,
          });
        } else {
          new Marker({
            map,
            position: center,
            title: place.name,
            icon: {
              path: PIN_PATH,
              fillColor: color,
              fillOpacity: 1,
              strokeColor: "#FFFFFF",
              strokeWeight: 2,
              anchor: new Point(15, 40),
            },
          });
        }
        if (place.reception) {
          const position = { lat: place.reception.latitude, lng: place.reception.longitude };
          new Marker({
            map,
            position,
            title: reception,
            clickable: false,
            label: { text: reception, color: "#374151", fontSize: "12px", fontWeight: "600" },
            icon: {
              path: SYMBOL_CIRCLE,
              scale: 6,
              fillColor: "#6B7280",
              fillOpacity: 1,
              strokeColor: "#FFFFFF",
              strokeWeight: 2,
              labelOrigin: new Point(0, -3),
            },
          });
          const bounds = new LatLngBounds();
          bounds.extend(center);
          bounds.extend(position);
          map.fitBounds(bounds, 48);
          const fitted = map.addListener?.("idle", () => {
            fitted?.remove();
            if ((map.getZoom?.() ?? 0) > MAX_FITTED_ZOOM) map.setZoom?.(MAX_FITTED_ZOOM);
          });
        }
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      stopListening();
    };
    // placeKey stands for place; the map is drawn once per place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, placeKey, large, reception]);

  return (
    <>
      <span ref={brandRef} className="hidden text-primary-600" aria-hidden="true" />
      <div
        ref={mapRef}
        role="region"
        aria-label={label}
        data-testid={large ? "room-place-map-full" : "room-place-map"}
        className={`absolute inset-0 ${ready && !failed ? "" : "invisible"}`}
      />
      {(!ready || failed) && (
        <p
          role="status"
          className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-gray-500"
        >
          {failed ? tm("mapFailed") : tm("loadingMap")}
        </p>
      )}
    </>
  );
}

/** "350 m" or "2.2 km" in the guest's language; measured from or to a rounded spot, whole kilometres ("2 km"). */
export function formatDistance(metres: number, locale: string, approximate = false): string {
  if (approximate) {
    return `${new Intl.NumberFormat(locale).format(Math.max(1, Math.round(metres / 1000)))} km`;
  }
  if (metres < 1000) {
    return `${new Intl.NumberFormat(locale).format(Math.max(10, Math.round(metres / 10) * 10))} m`;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(metres / 1000)} km`;
}
