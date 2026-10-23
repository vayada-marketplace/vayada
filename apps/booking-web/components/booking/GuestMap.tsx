"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { importGoogleMapsLibrary } from "@vayada/product-onboarding/googleMaps";

/** A place on the guest map (VAY-2324): a labelled pill at an exact spot, or a circle with its label for an
 * "Approximate area". */
export type GuestMapPlace = {
  key: string;
  label: string;
  latitude: number;
  longitude: number;
  approximate: boolean;
};

type LatLng = { lat: () => number; lng: () => number };
type GoogleMap = {
  fitBounds: (bounds: unknown, padding?: number) => void;
  getBounds?: () => { contains: (position: LatLng) => boolean } | undefined;
  getZoom?: () => number | undefined;
  setZoom?: (zoom: number) => void;
  panTo: (position: LatLng) => void;
  addListener?: (event: "idle", handler: () => void) => { remove: () => void };
};
type Projection = { fromLatLngToDivPixel: (position: LatLng) => { x: number; y: number } | null };
type OverlayViewBase = {
  setMap: (map: GoogleMap | null) => void;
  getPanes: () => { floatPane: HTMLElement } | null;
  getProjection: () => Projection | null;
};
type MapsLibrary = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => GoogleMap;
  Circle: new (options: Record<string, unknown>) => unknown;
  OverlayView: new () => OverlayViewBase;
};
type CoreLibrary = {
  LatLng: new (lat: number, lng: number) => LatLng;
  LatLngBounds: new () => { extend: (position: LatLng) => void };
};

// An "Approximate area" is rounded to about 1 km: drawn as an area this big.
const AREA_RADIUS_METRES = 1000;
// Places a few metres apart: closer than this the map shows streets, not just one building.
const MAX_FITTED_ZOOM = 16;
// A map that hasn't drawn by then (a hanging script) counts as failed.
const LOAD_TIMEOUT_MS = 12_000;
const PILL =
  "absolute whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-bold shadow-[0_2px_6px_rgb(0_0_0_/_22%)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2";
const PILL_IDLE = "border border-gray-200 bg-white text-gray-900";
const PILL_SELECTED = "border-2 border-white bg-primary-600 text-white";

/** The guest map (VAY-2324), shared by the booking page's location map and its accommodation views. It loads
 * Google Maps when mounted, so only mount it after the guest's "Show map" (VAY-2216, see MapGate). Pills are
 * buttons in the page: clicking one selects its place. */
export default function GuestMap({
  places,
  selected,
  onSelect,
  apiKey,
  label,
  className = "",
  onFailed,
}: {
  places: GuestMapPlace[];
  selected: number | null;
  onSelect: (index: number) => void;
  apiKey: string;
  /** The map's accessible name. */
  label: string;
  className?: string;
  onFailed?: () => void;
}) {
  const t = useTranslations("locationMap");
  const mapRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const drawn = useRef<{ map: GoogleMap; positions: LatLng[]; pills: HTMLButtonElement[] } | null>(
    null,
  );
  const onSelectRef = useRef(onSelect);
  const onFailedRef = useRef(onFailed);
  useEffect(() => {
    onSelectRef.current = onSelect;
    onFailedRef.current = onFailed;
  });
  const placesKey = JSON.stringify(places);

  useEffect(() => {
    if (!mapRef.current || places.length === 0) return;
    const googleWindow = window as Window & { gm_authFailure?: () => void };
    const previous = googleWindow.gm_authFailure;
    googleWindow.gm_authFailure = () => {
      previous?.();
      setFailed(true);
    };
    let disposed = false;
    const timeout = setTimeout(() => {
      if (!disposed) setFailed(true);
    }, LOAD_TIMEOUT_MS);
    void Promise.all([
      importGoogleMapsLibrary<MapsLibrary>(apiKey, "maps"),
      importGoogleMapsLibrary<CoreLibrary>(apiKey, "core"),
    ])
      .then(([{ Map, Circle, OverlayView }, { LatLng, LatLngBounds }]) => {
        if (disposed || !mapRef.current) return;
        clearTimeout(timeout);
        const positions = places.map((place) => new LatLng(place.latitude, place.longitude));
        const narrow = window.matchMedia("(max-width: 639px)").matches;
        const map = new Map(mapRef.current, {
          center: positions[0],
          zoom: places.length === 1 && places[0].approximate ? 14 : 15,
          clickableIcons: false,
          disableDefaultUI: true,
          zoomControl: !narrow,
          gestureHandling: "cooperative",
        });
        if (places.length > 1) {
          const bounds = new LatLngBounds();
          positions.forEach((position) => bounds.extend(position));
          map.fitBounds(bounds, 72);
          const fitted = map.addListener?.("idle", () => {
            fitted?.remove();
            if ((map.getZoom?.() ?? 0) > MAX_FITTED_ZOOM) map.setZoom?.(MAX_FITTED_ZOOM);
          });
        }
        const color = brandRef.current ? getComputedStyle(brandRef.current).color : "#1E3EDB";

        // A labelled pill drawn by the page at a spot on the map: above the spot for an exact place, on it for an area.
        class Pill extends OverlayView {
          position: LatLng;
          button: HTMLButtonElement;
          centred: boolean;
          constructor(position: LatLng, button: HTMLButtonElement, centred: boolean) {
            super();
            this.position = position;
            this.button = button;
            this.centred = centred;
          }
          onAdd() {
            this.getPanes()?.floatPane.appendChild(this.button);
          }
          draw() {
            const point = this.getProjection()?.fromLatLngToDivPixel(this.position);
            if (!point) return;
            this.button.style.left = `${point.x}px`;
            this.button.style.top = `${point.y}px`;
            this.button.style.transform = this.centred
              ? "translate(-50%, -50%)"
              : "translate(-50%, calc(-100% - 6px))";
          }
          onRemove() {
            this.button.remove();
          }
        }

        const pills = places.map((place, index) => {
          if (place.approximate) {
            // Only the area: no pin on a spot that isn't the room's.
            new Circle({
              map,
              center: positions[index],
              radius: AREA_RADIUS_METRES,
              fillColor: color,
              fillOpacity: 0.15,
              strokeColor: color,
              strokeOpacity: 0.7,
              strokeWeight: 2,
              clickable: false,
            });
          }
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = place.label;
          button.addEventListener("click", () => onSelectRef.current(index));
          new Pill(positions[index], button, place.approximate).setMap(map);
          return button;
        });
        drawn.current = { map, positions, pills };
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      googleWindow.gm_authFailure = previous;
      drawn.current = null;
    };
    // placesKey stands for places; the map is drawn once per set of places.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, placesKey]);

  // The selected place's pill stands out, and comes into view.
  useEffect(() => {
    const current = drawn.current;
    if (!ready || !current) return;
    current.pills.forEach((pill, index) => {
      pill.className = `${PILL} ${index === selected ? PILL_SELECTED : PILL_IDLE}`;
      pill.setAttribute("aria-pressed", String(index === selected));
      pill.style.zIndex = index === selected ? "2" : "1";
    });
    if (selected === null) return;
    const position = current.positions[selected];
    if (position && !current.map.getBounds?.()?.contains(position)) current.map.panTo(position);
  }, [ready, selected]);

  useEffect(() => {
    if (failed) onFailedRef.current?.();
  }, [failed]);

  return (
    <div className={`relative overflow-hidden bg-gray-100 ${className}`}>
      <span ref={brandRef} className="hidden text-primary-600" aria-hidden="true" />
      <div
        ref={mapRef}
        role="region"
        aria-label={label}
        className={`absolute inset-0 ${ready && !failed ? "" : "invisible"}`}
      />
      {(!ready || failed) && (
        <p
          role="status"
          className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-gray-500"
        >
          {failed ? t("mapFailed") : t("loadingMap")}
        </p>
      )}
    </div>
  );
}

/** Before the guest asks for the map: no Google request until "Show map" (VAY-2216). */
export function MapGate({
  onRequest,
  className = "",
}: {
  onRequest: () => void;
  className?: string;
}) {
  const t = useTranslations("locationMap");
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 bg-gray-100 px-6 text-center ${className}`}
    >
      <button
        type="button"
        onClick={onRequest}
        className="rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-700"
      >
        {t("showMap")}
      </button>
      <p className="max-w-xs text-sm text-gray-500">{t("mapNote")}</p>
    </div>
  );
}
