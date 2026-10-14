"use client";

import { useEffect, useRef, useState } from "react";

import { importGoogleMapsLibrary } from "./googleMaps";

export type MapPosition = { lat: number; lng: number };
type GoogleLatLng = { lat: () => number; lng: () => number };
type GoogleMapsEvent = { latLng?: GoogleLatLng | null };
type GoogleMap = {
  addListener: (eventName: "click", handler: (event: GoogleMapsEvent) => void) => void;
  getZoom: () => number | undefined;
  // One camera move: a pan followed by a zoom can cut the pan animation short.
  moveCamera: (camera: { center: MapPosition; zoom: number }) => void;
  setCenter: (position: MapPosition) => void;
  setZoom: (zoom: number) => void;
};
type GoogleMarker = {
  addListener: (eventName: "dragend", handler: (event: GoogleMapsEvent) => void) => void;
  setPosition: (position: MapPosition | null) => void;
};
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
};
type GoogleCoreLibrary = { ControlPosition?: { RIGHT_TOP: number } };
type GoogleMarkerLibrary = {
  Marker: new (options: {
    draggable: boolean;
    map: GoogleMap;
    position?: MapPosition;
    title: string;
  }) => GoogleMarker;
};

const WORLD_CENTER = { lat: 20, lng: 0 };
const PINNED_ZOOM = 17;
// Below this zoom one pixel spans too much ground for a hotel pin, so a click zooms in instead.
export const MIN_PIN_ZOOM = 14;
const AREA_ZOOM = 16;

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
  onPick,
  onUnavailable,
}: {
  active: boolean;
  apiKey: string;
  latitude: number | null;
  longitude: number | null;
  // Shows an area without pinning it, close enough that the next click places the pin.
  focus?: MapPosition | null;
  // Makes the map interactive: placing the first pin by click (zoomed in) or dragging it.
  onPick?: (position: MapPosition) => void;
  onUnavailable?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GoogleMap | null>(null);
  const markerRef = useRef<GoogleMarker | null>(null);
  const position = mapPosition(latitude, longitude);
  const positionRef = useRef(position);
  const onPickRef = useRef(onPick);
  const onUnavailableRef = useRef(onUnavailable);
  // The map already shows a position the hotel picked on it; don't recenter for that one.
  const pickedRef = useRef<MapPosition | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const interactive = Boolean(onPick);
  positionRef.current = position;
  onPickRef.current = onPick;
  onUnavailableRef.current = onUnavailable;

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
      .then(([{ Map }, { Marker }, { ControlPosition }]) => {
        if (disposed || !containerRef.current) return;
        const map = new Map(containerRef.current, {
          center: positionRef.current ?? WORLD_CENTER,
          zoom: positionRef.current ? PINNED_ZOOM : 2,
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
          title: "Hotel location",
        });
        markerRef.current = marker;
        if (interactive) {
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
  }, [active, apiKey, interactive]);

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
    if (
      picked &&
      nextPosition &&
      picked.lat === nextPosition.lat &&
      picked.lng === nextPosition.lng
    ) {
      return;
    }
    // A cleared pin keeps the hotel's current view so it can place the pin again from there.
    if (!nextPosition && interactive) return;
    map.setCenter(nextPosition ?? WORLD_CENTER);
    map.setZoom(nextPosition ? PINNED_ZOOM : 2);
  }, [interactive, latitude, longitude]);

  useEffect(() => {
    if (focus) mapRef.current?.moveCamera({ center: focus, zoom: AREA_ZOOM });
  }, [focus]);

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
