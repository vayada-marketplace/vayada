"use client";

import { useEffect, useRef, useState } from "react";

import { importGoogleMapsLibrary } from "./googleMaps";

export type MapPosition = { lat: number; lng: number };
type MapBounds = { north: number; south: number; east: number; west: number };
type MapPadding = { top: number; right: number; bottom: number; left: number };
// Map pixels hidden behind an overlay along its top or bottom edge.
export type MapCoveredInsets = { top: number; bottom: number };
type GoogleLatLng = { lat: () => number; lng: () => number };
type GoogleMapsEvent = { latLng?: GoogleLatLng | null };
type GoogleMap = {
  addListener: (
    eventName: "click" | "idle",
    handler: (event: GoogleMapsEvent) => void,
  ) => { remove: () => void };
  getZoom: () => number | undefined;
  setMapTypeId: (mapTypeId: MapType) => void;
  // One camera move: a pan followed by a zoom can cut the pan animation short.
  moveCamera: (camera: { center: MapPosition; zoom: number }) => void;
  // Pans by the least amount that brings the bounds inside the map minus the padding.
  panToBounds: (bounds: MapBounds, padding: MapPadding) => void;
  setCenter: (position: MapPosition) => void;
  setZoom: (zoom: number) => void;
};
type GoogleMarker = {
  addListener: (eventName: "dragend", handler: (event: GoogleMapsEvent) => void) => void;
  setPosition: (position: MapPosition | null) => void;
  setTitle: (title: string) => void;
  setVisible: (visible: boolean) => void;
};
type GoogleCircle = {
  setCenter: (center: MapPosition) => void;
  setVisible: (visible: boolean) => void;
};
export type MapType = "roadmap" | "satellite";
/** A second, fixed pin to place the first one by, such as the main property next to a villa. */
export type MapReference = { latitude: number; longitude: number; title: string };
type GoogleMapsLibrary = {
  Map: new (
    element: HTMLElement,
    options: {
      center: MapPosition;
      zoom: number;
      clickableIcons: boolean;
      disableDefaultUI: boolean;
      draggableCursor?: string;
      gestureHandling: string;
      keyboardShortcuts: boolean;
      zoomControl: boolean;
      zoomControlOptions?: { position: number };
    },
  ) => GoogleMap;
  Circle: new (options: {
    map: GoogleMap;
    radius: number;
    clickable: boolean;
    fillColor: string;
    fillOpacity: number;
    strokeColor: string;
    strokeOpacity: number;
    strokeWeight: number;
    visible: boolean;
  }) => GoogleCircle;
};
type GoogleCoreLibrary = { ControlPosition?: { RIGHT_TOP: number } };
type GoogleMarkerLibrary = {
  Marker: new (options: {
    draggable: boolean;
    map: GoogleMap;
    position?: MapPosition;
    title: string;
    clickable?: boolean;
    zIndex?: number;
    icon?: {
      path: number;
      scale: number;
      fillColor: string;
      fillOpacity: number;
      strokeColor: string;
      strokeWeight: number;
    };
  }) => GoogleMarker;
};

const WORLD_CENTER = { lat: 20, lng: 0 };
const PINNED_ZOOM = 17;
// Below this zoom one pixel spans too much ground for a hotel pin, so a click zooms in instead.
export const MIN_PIN_ZOOM = 14;
const AREA_ZOOM = 16;
// An "Approximate area" is rounded to about 1 km (2 decimals) for guests: drawn as a circle this big.
const AREA_RADIUS_METRES = 1000;
const AREA_VIEW_ZOOM = 14;
// google.maps.SymbolPath.CIRCLE, without loading the core library for it.
const SYMBOL_CIRCLE = 0;
// Google's default pin is drawn above its point; keep it, plus a margin, clear of what covers the map.
const PIN_HEIGHT = 43;
const VISIBLE_MARGIN = 12;

/** The pan padding that keeps a pin (and its point) inside the part of the map left uncovered. */
export function visibleMapPadding(insets: MapCoveredInsets): MapPadding {
  return {
    top: insets.top + PIN_HEIGHT + VISIBLE_MARGIN,
    right: VISIBLE_MARGIN,
    bottom: insets.bottom + VISIBLE_MARGIN,
    left: VISIBLE_MARGIN,
  };
}

/**
 * How much of the map a full-width card covers: from the top when the card sits in the upper half,
 * otherwise from the bottom. Rounded, so sub-pixel layout changes don't pan the map.
 */
export function coveredMapInsets(
  map: { top: number; bottom: number },
  card: { top: number; bottom: number },
): MapCoveredInsets {
  const onTop = card.top - map.top < map.bottom - card.bottom;
  return onTop
    ? { top: Math.max(0, Math.round(card.bottom - map.top)), bottom: 0 }
    : { top: 0, bottom: Math.max(0, Math.round(map.bottom - card.top)) };
}

function keepInView(map: GoogleMap, point: MapPosition, insets: MapCoveredInsets) {
  map.panToBounds(
    { north: point.lat, south: point.lat, east: point.lng, west: point.lng },
    visibleMapPadding(insets),
  );
}

export type MapClickResult =
  | { action: "zoom"; center: MapPosition; zoom: number }
  | { action: "pin"; position: MapPosition; zoom: number };

export function mapClickResult(position: MapPosition, zoom: number): MapClickResult {
  return zoom < MIN_PIN_ZOOM
    ? { action: "zoom", center: position, zoom: Math.min(zoom + 4, MIN_PIN_ZOOM) }
    : { action: "pin", position, zoom: Math.max(zoom, PINNED_ZOOM) };
}

export default function GoogleAddressMap({
  active,
  apiKey,
  latitude,
  longitude,
  focus,
  coveredInsets,
  markerTitle = "Hotel location",
  onPick,
  onUnavailable,
  reference = null,
  mapType = "roadmap",
  area = false,
  recenter = 0,
}: {
  active: boolean;
  apiKey: string;
  latitude: number | null;
  longitude: number | null;
  // Shows an area without pinning it, close enough that the next click places the pin.
  focus?: MapPosition | null;
  // Overlays hiding part of the map (narrow screens): the pin and a found area stay in the rest.
  coveredInsets?: MapCoveredInsets | null;
  // The pin's tooltip and accessible name.
  markerTitle?: string;
  // Makes the map interactive: placing the first pin by click (zoomed in) or dragging it.
  onPick?: (position: MapPosition) => void;
  onUnavailable?: () => void;
  // A fixed grey pin to place the main one by (the main property next to a villa).
  reference?: MapReference | null;
  mapType?: MapType;
  // Shows the pin as guests see an "Approximate area": a circle round the rounded spot, no pin.
  area?: boolean;
  // Raised to bring the pin (or the area) back into view.
  recenter?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GoogleMap | null>(null);
  const markerRef = useRef<GoogleMarker | null>(null);
  const referenceRef = useRef<GoogleMarker | null>(null);
  const circleRef = useRef<GoogleCircle | null>(null);
  const mapTypeSetRef = useRef(false);
  const librariesRef = useRef<{
    Marker: GoogleMarkerLibrary["Marker"];
    Circle: GoogleMapsLibrary["Circle"];
  } | null>(null);
  const position = mapPosition(latitude, longitude);
  const positionRef = useRef(position);
  const onPickRef = useRef(onPick);
  const onUnavailableRef = useRef(onUnavailable);
  const coveredInsetsRef = useRef(coveredInsets);
  // The area "Find on map" moved to, kept in view like a pin until a pin replaces it.
  const focusRef = useRef<MapPosition | null>(null);
  // An area to open on when there is no pin yet (a focus given before the map loads).
  const initialFocusRef = useRef(focus ?? null);
  initialFocusRef.current = focus ?? null;
  // The map already shows a position the hotel picked on it; don't recenter for that one.
  const pickedRef = useRef<MapPosition | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const interactive = Boolean(onPick);
  positionRef.current = position;
  onPickRef.current = onPick;
  onUnavailableRef.current = onUnavailable;
  coveredInsetsRef.current = coveredInsets;

  useEffect(() => {
    if (!active || !containerRef.current || mapRef.current) return;

    let disposed = false;
    setStatus("loading");
    void Promise.all([
      importGoogleMapsLibrary<GoogleMapsLibrary>(apiKey, "maps"),
      importGoogleMapsLibrary<GoogleMarkerLibrary>(apiKey, "marker"),
      interactive
        ? importGoogleMapsLibrary<GoogleCoreLibrary>(apiKey, "core")
        : Promise.resolve<GoogleCoreLibrary>({}),
    ])
      .then(([{ Map, Circle }, { Marker }, { ControlPosition }]) => {
        if (disposed || !containerRef.current) return;
        const map = new Map(containerRef.current, {
          center: positionRef.current ?? initialFocusRef.current ?? WORLD_CENTER,
          zoom: positionRef.current ? PINNED_ZOOM : initialFocusRef.current ? AREA_ZOOM : 2,
          clickableIcons: false,
          disableDefaultUI: true,
          ...(interactive ? { draggableCursor: "crosshair" } : {}),
          gestureHandling: "cooperative",
          keyboardShortcuts: interactive,
          zoomControl: interactive,
          // Bottom right (the default) sits under the setup action bar on narrower screens.
          ...(interactive && ControlPosition
            ? { zoomControlOptions: { position: ControlPosition.RIGHT_TOP } }
            : {}),
        });
        mapRef.current = map;
        // ponytail: Legacy Marker avoids a required cloud map ID; migrate when map IDs are configured.
        const marker = new Marker({
          draggable: interactive,
          map,
          ...(positionRef.current ? { position: positionRef.current } : {}),
          title: markerTitle,
        });
        markerRef.current = marker;
        // The reference pin and the area circle are made only for callers that ask for them (below).
        librariesRef.current = { Marker, Circle };
        if (interactive) {
          // A pan asked for before the first render can be lost: keep a saved pin in view once drawn.
          let drawn = false;
          const firstIdle = map.addListener("idle", () => {
            if (drawn) return;
            drawn = true;
            firstIdle.remove();
            const pin = positionRef.current;
            if (pin && coveredInsetsRef.current) keepInView(map, pin, coveredInsetsRef.current);
          });
          const pick = (next: MapPosition) => {
            pickedRef.current = next;
            onPickRef.current?.(next);
          };
          map.addListener("click", ({ latLng }) => {
            // An existing pin only moves by dragging, so a stray click can't shift it.
            if (!latLng || positionRef.current) return;
            const result = mapClickResult(
              { lat: latLng.lat(), lng: latLng.lng() },
              map.getZoom() ?? 2,
            );
            if (result.action === "zoom") {
              map.moveCamera({ center: result.center, zoom: result.zoom });
              return;
            }
            marker.setPosition(result.position);
            map.moveCamera({ center: result.position, zoom: result.zoom });
            pick(result.position);
          });
          marker.addListener("dragend", ({ latLng }) => {
            if (latLng) pick({ lat: latLng.lat(), lng: latLng.lng() });
          });
        }
        setStatus("ready");
      })
      .catch(() => {
        if (disposed) return;
        setStatus("unavailable");
        onUnavailableRef.current?.();
      });

    return () => {
      disposed = true;
    };
  }, [active, apiKey, interactive, markerTitle]);

  useEffect(() => {
    if (!active) return;
    // Google reports a rejected key (or billing) through this global, after the script loaded.
    const googleWindow = window as Window & { gm_authFailure?: () => void };
    const previous = googleWindow.gm_authFailure;
    googleWindow.gm_authFailure = () => {
      previous?.();
      setStatus("unavailable");
      onUnavailableRef.current?.();
    };
    return () => {
      googleWindow.gm_authFailure = previous;
    };
  }, [active]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const nextPosition = mapPosition(latitude, longitude);
    markerRef.current?.setPosition(nextPosition);
    const picked = pickedRef.current;
    pickedRef.current = null;
    // The pin the hotel just placed, perhaps rounded by the caller (about 10 cm): keep the hotel's view.
    if (
      picked &&
      nextPosition &&
      Math.abs(picked.lat - nextPosition.lat) < 1e-6 &&
      Math.abs(picked.lng - nextPosition.lng) < 1e-6
    ) {
      return;
    }
    // A cleared pin keeps the hotel's current view so it can place the pin again from there.
    if (!nextPosition && interactive) return;
    map.setCenter(nextPosition ?? WORLD_CENTER);
    map.setZoom(nextPosition ? PINNED_ZOOM : 2);
  }, [interactive, latitude, longitude]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    focusRef.current = focus;
    map.moveCamera({ center: focus, zoom: AREA_ZOOM });
  }, [focus]);

  // After the pin (or a found area) is set or moved, and whenever the covering card moves (it jumps
  // between the top and the bottom of a phone screen as it gains and loses focus), pan just enough
  // to show it.
  const coveredTop = coveredInsets?.top;
  const coveredBottom = coveredInsets?.bottom;
  useEffect(() => {
    const map = mapRef.current;
    const pin = mapPosition(latitude, longitude);
    if (pin) focusRef.current = null;
    const point = pin ?? focusRef.current;
    if (
      status !== "ready" ||
      !map ||
      !point ||
      coveredTop === undefined ||
      coveredBottom === undefined
    ) {
      return;
    }
    keepInView(map, point, { top: coveredTop, bottom: coveredBottom });
  }, [status, latitude, longitude, focus, coveredTop, coveredBottom]);

  const referenceLatitude = reference?.latitude;
  const referenceLongitude = reference?.longitude;
  const referenceTitle = reference?.title;
  useEffect(() => {
    const map = mapRef.current;
    const libraries = librariesRef.current;
    const point = mapPosition(referenceLatitude ?? null, referenceLongitude ?? null);
    if (status !== "ready" || !map || !libraries || (!point && !referenceRef.current)) return;
    referenceRef.current ??= new libraries.Marker({
      draggable: false,
      map,
      title: referenceTitle ?? "",
      clickable: false,
      zIndex: 0,
      icon: {
        path: SYMBOL_CIRCLE,
        scale: 7,
        fillColor: "#6B7280",
        fillOpacity: 1,
        strokeColor: "#FFFFFF",
        strokeWeight: 2,
      },
    });
    referenceRef.current.setPosition(point);
    referenceRef.current.setTitle(referenceTitle ?? "");
    referenceRef.current.setVisible(point !== null);
  }, [status, referenceLatitude, referenceLongitude, referenceTitle]);

  useEffect(() => {
    // The default needs no call, so plain address maps (and their test doubles) never see one.
    if (status === "ready" && (mapType !== "roadmap" || mapTypeSetRef.current)) {
      mapTypeSetRef.current = true;
      mapRef.current?.setMapTypeId(mapType);
    }
  }, [status, mapType]);

  useEffect(() => {
    const map = mapRef.current;
    const libraries = librariesRef.current;
    const point = mapPosition(latitude, longitude);
    const center = area && point ? areaCenter(point) : null;
    if (status !== "ready" || !map || !libraries || (!center && !circleRef.current)) return;
    circleRef.current ??= new libraries.Circle({
      map,
      radius: AREA_RADIUS_METRES,
      clickable: false,
      fillColor: "#1E3EDB",
      fillOpacity: 0.15,
      strokeColor: "#1E3EDB",
      strokeOpacity: 0.7,
      strokeWeight: 2,
      visible: false,
    });
    if (center) circleRef.current.setCenter(center);
    circleRef.current.setVisible(center !== null);
    markerRef.current?.setVisible(!center);
  }, [status, area, latitude, longitude]);

  useEffect(() => {
    const map = mapRef.current;
    const point = mapPosition(latitude, longitude);
    if (!recenter || status !== "ready" || !map || !point) return;
    map.moveCamera(
      area
        ? { center: areaCenter(point), zoom: AREA_VIEW_ZOOM }
        : { center: point, zoom: PINNED_ZOOM },
    );
    // Only a new request recenters (or one made while the map loaded); moving the pin keeps the hotel's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenter, status]);

  return (
    <div
      className="absolute inset-0 overflow-hidden bg-slate-100"
      // An interactive map has focusable zoom controls, which must not sit in a hidden subtree.
      aria-hidden={interactive ? undefined : "true"}
    >
      <div
        ref={containerRef}
        className="absolute inset-0"
        data-testid="google-address-map-canvas"
      />
      {(status === "idle" || status === "loading") && (
        <div className="absolute inset-0 animate-pulse bg-slate-100" />
      )}
      {status === "unavailable" && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-100 text-sm font-medium text-slate-500">
          Map unavailable
        </div>
      )}
    </div>
  );
}

function mapPosition(latitude: number | null, longitude: number | null): MapPosition | null {
  return typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
    ? { lat: latitude, lng: longitude }
    : null;
}

/** Where guests see an "Approximate area": the spot rounded to 2 decimals, as the booking page gets it. */
function areaCenter(point: MapPosition): MapPosition {
  return { lat: Number(point.lat.toFixed(2)), lng: Number(point.lng.toFixed(2)) };
}
