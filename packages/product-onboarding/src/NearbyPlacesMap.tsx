"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { EyeSlashIcon, HomeModernIcon, MapPinIcon } from "@heroicons/react/24/outline";
import type { NearbyCategoryView } from "@vayada/domain-hotels";
import { importGoogleMapsLibrary } from "./googleMaps";
import { NearbyCategoryBadge } from "./NearbyCategoryBadge";
import { NEARBY_CATEGORY_HEX } from "./nearbyPlaces";
import type { Translate } from "./nearbyPlacesMessages";

export type NearbyMapPoint = { latitude: number; longitude: number };
export type NearbyMapPlace = NearbyMapPoint & {
  id: string;
  name: string;
  category: Pick<NearbyCategoryView, "color" | "icon">;
};

type LatLng = { lat: () => number; lng: () => number };
type Pixel = { x: number; y: number };
type Projection = {
  fromLatLngToDivPixel: (position: LatLng) => Pixel | null;
  fromDivPixelToLatLng: (pixel: Pixel) => LatLng | null;
};
type GoogleMap = {
  addListener: (
    event: "click" | "idle",
    handler: (event?: { latLng?: LatLng | null }) => void,
  ) => { remove: () => void };
  fitBounds: (bounds: unknown, padding?: number) => void;
  moveCamera: (camera: { center: { lat: number; lng: number }; zoom: number }) => void;
  getZoom: () => number | undefined;
  setZoom: (zoom: number) => void;
};
type OverlayBase = {
  setMap: (map: GoogleMap | null) => void;
  getPanes: () => { floatPane: HTMLElement } | null;
  getProjection: () => Projection | null;
};
type MapsLibrary = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => GoogleMap;
  OverlayView: (new () => OverlayBase) & {
    preventMapHitsAndGesturesFrom?: (element: HTMLElement) => void;
  };
};
type CoreLibrary = {
  LatLng: new (lat: number, lng: number) => LatLng;
  LatLngBounds: new () => { extend: (position: LatLng) => void };
};
type Pin = {
  element: HTMLDivElement;
  place: (position: NearbyMapPoint, zIndex: number) => void;
  projection: () => Projection | null;
  remove: () => void;
};
type Marker = { key: string; position: NearbyMapPoint; zIndex: number };

// Places a few metres apart: closer than this the map shows streets, not one building.
const MAX_FITTED_ZOOM = 16;
const AREA_ZOOM = 15;
const LOAD_TIMEOUT_MS = 12_000;
// One arrow key press moves a marker this many pixels.
const NUDGE_PIXELS = 8;

/** "What guests see" (VAY-2326): the property, rooms with their own location, and each nearby place in its
 * category's colour. While adding, a click drops the draft's pin; while editing, the ringed marker can be dragged
 * or moved with the arrow keys. The map draws each marker as page content inside a Google overlay. */
export default function NearbyPlacesMap({
  apiKey,
  t,
  property,
  rooms,
  places,
  shown,
  draft,
  editingId,
  focus,
  onDrop,
  onMove,
}: {
  apiKey: string;
  t: Translate;
  property: (NearbyMapPoint & { name: string }) | null;
  /** Rooms with their own location, such as a villa elsewhere. */
  rooms: (NearbyMapPoint & { name: string })[];
  places: NearbyMapPlace[];
  /** "Show nearby places": off, guests see no place markers, and neither does this preview. */
  shown: boolean;
  /** The place being added: its pin once dropped, with its category so far. */
  draft: {
    position: NearbyMapPoint | null;
    name: string;
    category: NearbyMapPlace["category"];
  } | null;
  /** The place being edited: its marker is ringed and movable. */
  editingId: string | null;
  /** Where "Find the area" moved the map; a new object each search. */
  focus: NearbyMapPoint | null;
  /** A click on the map while adding: the draft's pin. */
  onDrop?: (position: NearbyMapPoint) => void;
  /** The edited place's marker moved. */
  onMove?: (id: string, position: NearbyMapPoint) => void;
}) {
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<{ map: GoogleMap; core: CoreLibrary; createPin: () => Pin } | null>(null);
  const pins = useRef(new Map<string, Pin>());
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [containers, setContainers] = useState<Record<string, HTMLDivElement>>({});
  const callbacks = useRef({ onDrop, onMove });
  useEffect(() => {
    callbacks.current = { onDrop, onMove };
  });
  // Where the map first looks: the property, else the places.
  const start = property ?? places[0] ?? null;
  const startKey = start ? `${start.latitude},${start.longitude}` : "";

  useEffect(() => {
    if (!mapElement.current) return;
    let disposed = false;
    const timeout = setTimeout(() => {
      if (!disposed) setFailed(true);
    }, LOAD_TIMEOUT_MS);
    let click: { remove: () => void } | undefined;
    const drawn = pins.current;
    void Promise.all([
      importGoogleMapsLibrary<MapsLibrary>(apiKey, "maps"),
      importGoogleMapsLibrary<CoreLibrary>(apiKey, "core"),
    ])
      .then(([{ Map, OverlayView }, core]) => {
        if (disposed || !mapElement.current) return;
        clearTimeout(timeout);
        setFailed(false);
        const google = new Map(mapElement.current, {
          center: start ? { lat: start.latitude, lng: start.longitude } : { lat: 20, lng: 0 },
          zoom: start ? AREA_ZOOM : 2,
          clickableIcons: false,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: "cooperative",
          draggableCursor: "crosshair",
        });
        click = google.addListener("click", (event) => {
          const position = event?.latLng;
          if (position)
            callbacks.current.onDrop?.({ latitude: position.lat(), longitude: position.lng() });
        });
        // A marker: page content positioned on the map, with its point at the centre.
        class Overlay extends OverlayView {
          element = document.createElement("div");
          position: LatLng | null = null;
          constructor() {
            super();
            this.element.style.position = "absolute";
            this.element.style.transform = "translate(-50%, -50%)";
            // Pressing or dragging a marker doesn't move the map under it.
            OverlayView.preventMapHitsAndGesturesFrom?.(this.element);
          }
          onAdd() {
            this.getPanes()?.floatPane.appendChild(this.element);
          }
          draw() {
            const point =
              this.position && this.getProjection()?.fromLatLngToDivPixel(this.position);
            if (!point) return;
            this.element.style.left = `${point.x}px`;
            this.element.style.top = `${point.y}px`;
          }
          onRemove() {
            this.element.remove();
          }
        }
        map.current = {
          map: google,
          core,
          createPin: () => {
            const overlay = new Overlay();
            overlay.setMap(google);
            return {
              element: overlay.element,
              place: (position, zIndex) => {
                overlay.position = new core.LatLng(position.latitude, position.longitude);
                overlay.element.style.zIndex = String(zIndex);
                overlay.draw();
              },
              projection: () => overlay.getProjection(),
              remove: () => overlay.setMap(null),
            };
          },
        };
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      click?.remove();
      drawn.forEach((pin) => pin.remove());
      drawn.clear();
      map.current = null;
      setReady(false);
      setContainers({});
    };
    // The map is made once per key and starting point; markers follow the props below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, startKey]);

  const markers: Marker[] = [
    ...(property ? [{ key: "property", position: property, zIndex: 3 }] : []),
    ...rooms.map((room, index) => ({ key: `room:${index}`, position: room, zIndex: 2 })),
    // While "Show nearby places" is off guests see none; the place being edited still shows here.
    ...places
      .filter((place) => shown || place.id === editingId)
      .map((place) => ({
        key: `place:${place.id}`,
        position: place,
        zIndex: place.id === editingId ? 5 : 1,
      })),
    ...(draft?.position ? [{ key: "draft", position: draft.position, zIndex: 6 }] : []),
  ];
  const markersKey = JSON.stringify(markers);

  // Keep one Google overlay per marker, placed where its marker is.
  useEffect(() => {
    const current = map.current;
    if (!ready || !current) return;
    const keys = new Set(markers.map(({ key }) => key));
    pins.current.forEach((pin, key) => {
      if (keys.has(key)) return;
      pin.remove();
      pins.current.delete(key);
    });
    for (const marker of markers) {
      let pin = pins.current.get(marker.key);
      if (!pin) {
        pin = current.createPin();
        pins.current.set(marker.key, pin);
      }
      pin.place(marker.position, marker.zIndex);
    }
    setContainers(Object.fromEntries(Array.from(pins.current, ([key, pin]) => [key, pin.element])));
    // markersKey stands for markers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, markersKey]);

  // Fit the property, rooms and places in once, when the map is ready.
  const fitted = useRef(false);
  useEffect(() => {
    const current = map.current;
    if (!ready || !current || fitted.current) return;
    fitted.current = true;
    const points = [...(property ? [property] : []), ...rooms, ...places];
    if (points.length < 2) return;
    const bounds = new current.core.LatLngBounds();
    points.forEach((point) =>
      bounds.extend(new current.core.LatLng(point.latitude, point.longitude)),
    );
    current.map.fitBounds(bounds, 56);
    const idle = current.map.addListener("idle", () => {
      idle.remove();
      if ((current.map.getZoom() ?? 0) > MAX_FITTED_ZOOM) current.map.setZoom(MAX_FITTED_ZOOM);
    });
    // Only the first fit: later edits keep the host's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // "Find the area" moves the map there.
  useEffect(() => {
    if (ready && focus)
      map.current?.map.moveCamera({
        center: { lat: focus.latitude, lng: focus.longitude },
        zoom: AREA_ZOOM,
      });
  }, [ready, focus]);

  const movable = (id: string, position: NearbyMapPoint) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      const pin = pins.current.get(`place:${id}`);
      const projection = pin?.projection();
      const start = projection && toPixel(projection, position, map.current?.core);
      if (!pin || !projection || !start) return;
      event.preventDefault();
      const button = event.currentTarget;
      button.setPointerCapture(event.pointerId);
      const from = { x: event.clientX, y: event.clientY };
      const at = (moved: globalThis.PointerEvent) =>
        toPoint(
          projection.fromDivPixelToLatLng({
            x: start.x + moved.clientX - from.x,
            y: start.y + moved.clientY - from.y,
          }),
        );
      const follow = (moved: globalThis.PointerEvent) => {
        const point = at(moved);
        if (point) pin.place(point, 5);
      };
      const drop = (moved: globalThis.PointerEvent) => {
        button.removeEventListener("pointermove", follow);
        button.removeEventListener("pointerup", drop);
        button.removeEventListener("pointercancel", drop);
        const point = at(moved);
        if (point) callbacks.current.onMove?.(id, point);
      };
      button.addEventListener("pointermove", follow);
      button.addEventListener("pointerup", drop);
      button.addEventListener("pointercancel", drop);
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      const step = {
        ArrowUp: { x: 0, y: -NUDGE_PIXELS },
        ArrowDown: { x: 0, y: NUDGE_PIXELS },
        ArrowLeft: { x: -NUDGE_PIXELS, y: 0 },
        ArrowRight: { x: NUDGE_PIXELS, y: 0 },
      }[event.key];
      const projection = pins.current.get(`place:${id}`)?.projection();
      const start = projection && step && toPixel(projection, position, map.current?.core);
      if (!projection || !start || !step) return;
      event.preventDefault();
      const point = toPoint(
        projection.fromDivPixelToLatLng({ x: start.x + step.x, y: start.y + step.y }),
      );
      if (point) callbacks.current.onMove?.(id, point);
    },
  });

  return (
    <div
      role="region"
      aria-label={t("nearbyPlaces.map.label")}
      className="relative isolate h-full min-h-[260px] overflow-hidden rounded-xl border border-gray-200 bg-gray-100"
    >
      <div ref={mapElement} className={`absolute inset-0 ${ready && !failed ? "" : "invisible"}`} />
      {(!ready || failed) && (
        <p
          role="status"
          className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-gray-500"
        >
          {failed ? t("nearbyPlaces.map.failed") : t("nearbyPlaces.map.loading")}
        </p>
      )}
      <p className="pointer-events-none absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1.5 text-xs font-semibold text-gray-900 shadow">
        {!shown && <EyeSlashIcon aria-hidden="true" className="h-3.5 w-3.5 text-gray-600" />}
        {shown ? t("nearbyPlaces.map.badge") : t("nearbyPlaces.map.off")}
      </p>
      {property &&
        containers.property &&
        createPortal(
          <span className="flex items-center gap-1.5" title={property.name}>
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-gray-900 text-white shadow">
              <HomeModernIcon aria-hidden="true" className="h-[18px] w-[18px]" />
            </span>
            <MapLabel>{property.name}</MapLabel>
          </span>,
          containers.property,
        )}
      {rooms.map(
        (room, index) =>
          containers[`room:${index}`] &&
          createPortal(
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-bold text-gray-900 shadow">
              <MapPinIcon aria-hidden="true" className="h-3.5 w-3.5 text-blue-700" />
              {room.name}
            </span>,
            containers[`room:${index}`],
            `room:${index}`,
          ),
      )}
      {places.map((place) => {
        const container = containers[`place:${place.id}`];
        if (!container) return null;
        if (place.id !== editingId)
          return createPortal(
            <span
              title={place.name}
              className="block rounded-full shadow-[0_2px_6px_rgb(0_0_0_/_28%)] ring-2 ring-white"
            >
              <NearbyCategoryBadge category={place.category} size={28} />
            </span>,
            container,
            place.id,
          );
        return createPortal(
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label={t("nearbyPlaces.map.moveMarker", { name: place.name })}
              className="cursor-grab touch-none rounded-full p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 active:cursor-grabbing"
              style={{
                backgroundColor: `${NEARBY_CATEGORY_HEX[place.category.color]}40`,
                boxShadow: `0 0 0 2px ${NEARBY_CATEGORY_HEX[place.category.color]}`,
              }}
              {...movable(place.id, place)}
            >
              <span className="block rounded-full ring-2 ring-white">
                <NearbyCategoryBadge category={place.category} size={34} />
              </span>
            </button>
            <MapLabel>{place.name}</MapLabel>
          </span>,
          container,
          place.id,
        );
      })}
      {draft?.position &&
        containers.draft &&
        createPortal(
          <span className="flex items-center gap-1.5">
            <span
              className="rounded-full border-2 border-dashed p-1"
              style={{ borderColor: NEARBY_CATEGORY_HEX[draft.category.color] }}
            >
              <span className="block rounded-full ring-2 ring-white">
                <NearbyCategoryBadge category={draft.category} size={28} />
              </span>
            </span>
            {draft.name.trim() && <MapLabel>{draft.name.trim()}</MapLabel>}
          </span>,
          containers.draft,
        )}
    </div>
  );
}

/** A marker's name next to it, like the boards' white labels. */
function MapLabel({ children }: { children: string }) {
  return (
    <span className="max-w-[180px] truncate whitespace-nowrap rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[11px] font-bold text-gray-900 shadow-sm">
      {children}
    </span>
  );
}

function toPixel(
  projection: Projection,
  position: NearbyMapPoint,
  core: CoreLibrary | undefined,
): Pixel | null {
  return core
    ? projection.fromLatLngToDivPixel(new core.LatLng(position.latitude, position.longitude))
    : null;
}
function toPoint(position: LatLng | null): NearbyMapPoint | null {
  return position ? { latitude: position.lat(), longitude: position.lng() } : null;
}
