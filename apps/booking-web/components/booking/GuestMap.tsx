"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { metresBetween } from "@vayada/domain-hotels";
import { NearbyCategoryBadge } from "@vayada/product-onboarding/NearbyCategoryBadge";
import { NEARBY_CATEGORY_HEX } from "@vayada/product-onboarding/nearbyPlaces";
import { importGoogleMapsLibrary } from "@vayada/product-onboarding/googleMaps";
import { onGoogleAuthFailure } from "@/lib/googleMapsFailure";
import type { GuestNearbyPlace } from "@/lib/nearbyPlaces";
import { useNearbyCategoryName } from "./NearbyMapLayer";

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
type Padding = { top: number; right: number; bottom: number; left: number };
type GoogleMap = {
  fitBounds: (bounds: unknown, padding?: number | Padding) => void;
  getBounds?: () => { contains: (position: LatLng) => boolean } | undefined;
  getZoom?: () => number | undefined;
  setZoom?: (zoom: number) => void;
  panTo: (position: LatLng) => void;
  addListener?: (event: "idle" | "dragstart", handler: () => void) => { remove: () => void };
};
type Projection = { fromLatLngToDivPixel: (position: LatLng) => { x: number; y: number } | null };
type OverlayViewBase = {
  setMap: (map: GoogleMap | null) => void;
  getPanes: () => { floatPane: HTMLElement } | null;
  getProjection: () => Projection | null;
};
type MapsLibrary = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => GoogleMap;
  Circle: new (options: Record<string, unknown>) => { setMap: (map: GoogleMap | null) => void };
  OverlayView: (new () => OverlayViewBase) & {
    preventMapHitsAndGesturesFrom?: (element: HTMLElement) => void;
  };
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
  "absolute inline-flex max-w-[220px] items-center gap-1 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-bold shadow-[0_2px_6px_rgb(0_0_0_/_22%)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 " +
  // A touch target of at least 44 px around the pill (VAY-2325).
  "before:absolute before:-inset-2 before:content-['']";
const PILL_IDLE = "border border-gray-200 bg-white text-gray-900";
const PILL_SELECTED = "border-2 border-white bg-primary-600 text-white";
// Nearby places further from every pill than this stay out of the first view (an airport, a day trip).
const NEARBY_FIT_METRES = 5_000;

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
  fitPadding = 72,
  gestureHandling = "cooperative",
}: {
  places: GuestMapPlace[];
  /** The selected place's index in places. */
  selected: number | null;
  onSelect: (index: number) => void;
  apiKey: string;
  /** The map's accessible name. */
  label: string;
  className?: string;
  /** Room kept around the places when the map fits them in, such as for cards drawn over the map. */
  fitPadding?: number | Padding;
  /** "greedy" where nothing else scrolls, such as a full-screen map: one finger moves the map. */
  gestureHandling?: "cooperative" | "greedy";
  /** The host's nearby places (VAY-2327): round markers under the pills, in the host's order. */
  nearby?: { places: GuestNearbyPlace[]; selected: string | null; onSelect: (id: string) => void };
}) {
  const t = useTranslations("locationMap");
  const mapRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLSpanElement>(null);
  // Raised each time the places are drawn, so the selection is applied to the new pills.
  const [draws, setDraws] = useState(0);
  const [failed, setFailed] = useState(false);
  const drawn = useRef<{
    map: GoogleMap;
    positions: LatLng[];
    pills: HTMLButtonElement[];
    /** Puts page content on the map, centred on a spot; setMap(null) takes it off. */
    overlay: (
      latitude: number,
      longitude: number,
      element: HTMLElement,
    ) => { setMap: (map: GoogleMap | null) => void };
    fit: (positions: LatLng[]) => void;
    /** The guest moved or zoomed the map: later places don't move it again. */
    touched: boolean;
  } | null>(null);
  const [nearbySlots, setNearbySlots] = useState<{ id: string; element: HTMLDivElement }[]>([]);
  const onNearbyRef = useRef(nearby?.onSelect);
  const onSelectRef = useRef(onSelect);
  // Read when the map is drawn: cards drawn over the map are measured after it mounts.
  const fitPaddingRef = useRef(fitPadding);
  useEffect(() => {
    onSelectRef.current = onSelect;
    fitPaddingRef.current = fitPadding;
    onNearbyRef.current = nearby?.onSelect;
  });
  const placesKey = JSON.stringify(places);
  const ready = draws > 0;

  useEffect(() => {
    if (!mapRef.current || places.length === 0) return;
    const stopListening = onGoogleAuthFailure(() => setFailed(true));
    // What this drawing put on the map, taken off again when the places change or the map goes.
    const shapes: { setMap: (map: GoogleMap | null) => void }[] = [];
    let fitted: { remove: () => void } | undefined;
    let moved: { remove: () => void } | undefined;
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
        // Google answered after all: a slow load isn't a failed one.
        setFailed(false);
        const positions = places.map((place) => new LatLng(place.latitude, place.longitude));
        const narrow = window.matchMedia("(max-width: 639px)").matches;
        const map = new Map(mapRef.current, {
          center: positions[0],
          zoom: places.length === 1 && places[0].approximate ? 14 : 15,
          clickableIcons: false,
          disableDefaultUI: true,
          zoomControl: !narrow,
          gestureHandling,
        });
        if (places.length > 1) {
          const bounds = new LatLngBounds();
          positions.forEach((position) => bounds.extend(position));
          map.fitBounds(bounds, fitPaddingRef.current);
          fitted = map.addListener?.("idle", () => {
            fitted?.remove();
            if ((map.getZoom?.() ?? 0) > MAX_FITTED_ZOOM) map.setZoom?.(MAX_FITTED_ZOOM);
          });
        }
        const color = brandRef.current ? getComputedStyle(brandRef.current).color : "#1E3EDB";

        // A labelled pill drawn by the page at a spot on the map: above the spot for an exact place, on it for an area.
        class Pill extends OverlayView {
          position: LatLng;
          button: HTMLElement;
          centred: boolean;
          constructor(position: LatLng, button: HTMLElement, centred: boolean) {
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
            const area = new Circle({
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
            shapes.push(area);
          }
          const button = document.createElement("button");
          button.type = "button";
          button.className = `${PILL} ${PILL_IDLE}`;
          const text = document.createElement("span");
          text.className = "truncate";
          text.textContent = place.label;
          // A pin icon for an exact place; an area's name sits on its circle.
          button.replaceChildren(...(place.approximate ? [] : [pinIcon()]), text);
          button.title = place.label;
          button.addEventListener("click", () => onSelectRef.current(index));
          // Dragging or double-clicking a pill doesn't move or zoom the map under it.
          OverlayView.preventMapHitsAndGesturesFrom?.(button);
          const pill = new Pill(positions[index], button, place.approximate);
          pill.setMap(map);
          shapes.push(pill);
          return button;
        });
        const fit = (points: LatLng[]) => {
          const bounds = new LatLngBounds();
          points.forEach((position) => bounds.extend(position));
          map.fitBounds(bounds, fitPaddingRef.current);
          const idle = map.addListener?.("idle", () => {
            idle?.remove();
            if ((map.getZoom?.() ?? 0) > MAX_FITTED_ZOOM) map.setZoom?.(MAX_FITTED_ZOOM);
          });
        };
        const current = {
          map,
          positions,
          pills,
          fit,
          touched: false,
          overlay: (latitude: number, longitude: number, element: HTMLElement) => {
            OverlayView.preventMapHitsAndGesturesFrom?.(element);
            const marker = new Pill(new LatLng(latitude, longitude), element, true);
            marker.setMap(map);
            shapes.push(marker);
            return marker;
          },
        };
        moved = map.addListener?.("dragstart", () => {
          current.touched = true;
        });
        drawn.current = current;
        setDraws((count) => count + 1);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      stopListening();
      fitted?.remove();
      moved?.remove();
      shapes.forEach((shape) => shape.setMap(null));
      drawn.current = null;
    };
    // placesKey stands for places; the map is drawn once per set of places.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, placesKey]);

  // The selected place's pill stands out, and comes into view.
  useEffect(() => {
    const current = drawn.current;
    if (draws === 0 || !current) return;
    current.pills.forEach((pill, index) => {
      pill.className = `${PILL} ${index === selected ? PILL_SELECTED : PILL_IDLE}`;
      if (index === selected) pill.setAttribute("aria-current", "true");
      else pill.removeAttribute("aria-current");
      // Above the nearby places' markers where they overlap (VAY-2327).
      pill.style.zIndex = index === selected ? "3" : "2";
    });
    if (selected === null) return;
    const position = current.positions[selected];
    if (position && !current.map.getBounds?.()?.contains(position)) current.map.panTo(position);
  }, [draws, selected]);

  // The host's nearby places (VAY-2327): one round marker each, under the pills, in the host's order (the order
  // they take the focus in). The first time they come, the view widens to the ones near the pills.
  const nearbyKey = JSON.stringify(
    (nearby?.places ?? []).map(({ id, latitude, longitude }) => [id, latitude, longitude]),
  );
  useEffect(() => {
    const current = drawn.current;
    const places = nearby?.places ?? [];
    if (draws === 0 || !current || places.length === 0) {
      setNearbySlots([]);
      return;
    }
    const markers = places.map((place) => {
      const element = document.createElement("div");
      element.style.zIndex = "0";
      return {
        id: place.id,
        element,
        overlay: current.overlay(place.latitude, place.longitude, element),
      };
    });
    setNearbySlots(markers.map(({ id, element }) => ({ id, element })));
    const near = places.filter((place) =>
      current.positions.some(
        (position) =>
          metresBetween(place, { latitude: position.lat(), longitude: position.lng() }) <=
          NEARBY_FIT_METRES,
      ),
    );
    if (!current.touched && near.length > 0)
      current.fit([
        ...current.positions,
        ...near.map((place) => ({ lat: () => place.latitude, lng: () => place.longitude })),
      ]);
    return () => markers.forEach(({ overlay }) => overlay.setMap(null));
    // nearbyKey stands for the places' spots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draws, nearbyKey]);

  // The selected place's marker comes forward, and into view.
  const selectedNearby = nearby?.selected ?? null;
  useEffect(() => {
    nearbySlots.forEach(({ id, element }) => {
      element.style.zIndex = id === selectedNearby ? "1" : "0";
    });
    const current = drawn.current;
    const place = nearby?.places.find(({ id }) => id === selectedNearby);
    if (!current || !place) return;
    const position = { lat: () => place.latitude, lng: () => place.longitude };
    if (!current.map.getBounds?.()?.contains(position)) current.map.panTo(position);
    // nearby is read for the selected place's spot only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nearbySlots, selectedNearby]);

  return (
    // Its own stacking layer: Google's panes and the pills stay under cards drawn over the map.
    <div className={`relative isolate overflow-hidden bg-gray-100 ${className}`}>
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
      {nearbySlots.map(({ id, element }) => {
        const place = nearby?.places.find((candidate) => candidate.id === id);
        return place
          ? createPortal(
              <NearbyMarker
                place={place}
                selected={id === selectedNearby}
                onSelect={() => onNearbyRef.current?.(id)}
              />,
              element,
              id,
            )
          : null;
      })}
    </div>
  );
}

/** A nearby place on the map (VAY-2327): a round marker in its category's colour, unlike the rooms' labelled
 * pills; bigger, with a ring, while selected. A button in the page, so it takes the focus in the host's order. */
function NearbyMarker({
  place,
  selected,
  onSelect,
}: {
  place: GuestNearbyPlace;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations("nearbyMap");
  const name = useNearbyCategoryName();
  const color = NEARBY_CATEGORY_HEX[place.category.color];
  return (
    <button
      type="button"
      data-nearby-id={place.id}
      aria-label={t("markerLabel", { name: place.name, category: name(place.category) })}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      // A touch target of at least 44 px around the marker (VAY-2325).
      className="relative block rounded-full before:absolute before:-inset-1.5 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      style={
        selected
          ? { padding: 4, backgroundColor: `${color}40`, boxShadow: `0 0 0 2px ${color}` }
          : undefined
      }
    >
      <span className="block rounded-full shadow-[0_2px_6px_rgb(0_0_0_/_28%)] ring-2 ring-white">
        <NearbyCategoryBadge category={place.category} size={selected ? 36 : 32} />
      </span>
    </button>
  );
}

const SVG = "http://www.w3.org/2000/svg";

function pinIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "h-3.5 w-3.5 shrink-0",
  }))
    icon.setAttribute(name, value);
  const path = document.createElementNS(SVG, "path");
  path.setAttribute(
    "d",
    "M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0zM15 11a3 3 0 11-6 0 3 3 0 016 0z",
  );
  icon.append(path);
  return icon;
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
