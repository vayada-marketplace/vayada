"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { PointOfInterest } from "@/lib/types";

const TILE_SIZE = 256;
const MIN_ZOOM = 4;
const MAX_ZOOM = 17;

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface LocationMapProps {
  propertyName: string;
  property: Coordinate;
  pois: PointOfInterest[];
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function project({ latitude, longitude }: Coordinate, zoom: number) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin((latitude * Math.PI) / 180);
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function unproject(x: number, y: number, zoom: number): Coordinate {
  const scale = TILE_SIZE * 2 ** zoom;
  const longitude = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const latitude = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { latitude, longitude };
}

function fitView(points: Coordinate[]) {
  if (points.length === 1) {
    return { center: points[0], zoom: 14 };
  }
  const zoom = 12;
  const projected = points.map((point) => project(point, zoom));
  const minX = Math.min(...projected.map((p) => p.x));
  const maxX = Math.max(...projected.map((p) => p.x));
  const minY = Math.min(...projected.map((p) => p.y));
  const maxY = Math.max(...projected.map((p) => p.y));
  const center = unproject((minX + maxX) / 2, (minY + maxY) / 2, zoom);
  const span = Math.max(maxX - minX, maxY - minY);
  const fittedZoom = clamp(Math.floor(zoom + Math.log2(300 / Math.max(span, 1))), 11, 15);
  return { center, zoom: fittedZoom };
}

export default function LocationMap({ propertyName, property, pois }: LocationMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [size, setSize] = useState({ width: 520, height: 260 });
  const initialView = useMemo(
    () =>
      fitView([
        property,
        ...pois.map((poi) => ({ latitude: poi.latitude, longitude: poi.longitude })),
      ]),
    [property, pois],
  );
  const [center, setCenter] = useState(initialView.center);
  const [zoom, setZoom] = useState(initialView.zoom);
  const dragRef = useRef<{ x: number; y: number; center: Coordinate } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const lastWheelRef = useRef(0);

  useEffect(() => {
    setCenter(initialView.center);
    setZoom(initialView.zoom);
  }, [initialView]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setReady(true);
    });
    observer.observe(node);
    const resize = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    resize.observe(node);
    return () => {
      observer.disconnect();
      resize.disconnect();
    };
  }, []);

  const centerPx = project(center, zoom);
  const startX = Math.floor((centerPx.x - size.width / 2) / TILE_SIZE) - 1;
  const endX = Math.floor((centerPx.x + size.width / 2) / TILE_SIZE) + 1;
  const startY = Math.floor((centerPx.y - size.height / 2) / TILE_SIZE) - 1;
  const endY = Math.floor((centerPx.y + size.height / 2) / TILE_SIZE) + 1;
  const tileCount = 2 ** zoom;
  const tiles = [];
  for (let x = startX; x <= endX; x += 1) {
    for (let y = startY; y <= endY; y += 1) {
      if (y < 0 || y >= tileCount) continue;
      const wrappedX = ((x % tileCount) + tileCount) % tileCount;
      tiles.push({
        key: `${zoom}-${x}-${y}`,
        url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`,
        left: x * TILE_SIZE - centerPx.x + size.width / 2,
        top: y * TILE_SIZE - centerPx.y + size.height / 2,
      });
    }
  }

  const markerPosition = (point: Coordinate) => {
    const px = project(point, zoom);
    return {
      left: px.x - centerPx.x + size.width / 2,
      top: px.y - centerPx.y + size.height / 2,
    };
  };
  const changeZoom = (delta: number) => {
    setZoom((value) => clamp(value + delta, MIN_ZOOM, MAX_ZOOM));
  };
  const getPinchDistance = () => {
    const pointers = Array.from(pointersRef.current.values());
    if (pointers.length < 2) return 0;
    return Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (event.pointerType === "touch" && pointersRef.current.size < 2) {
      dragRef.current = null;
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointersRef.current.size >= 2) {
      pinchRef.current = { distance: getPinchDistance(), zoom };
      dragRef.current = null;
      return;
    }
    dragRef.current = { x: event.clientX, y: event.clientY, center };
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (event.pointerType === "touch" && pointersRef.current.size < 2) return;
    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const distance = getPinchDistance();
      if (distance > 0 && pinchRef.current.distance > 0) {
        setZoom(
          clamp(
            Math.round(pinchRef.current.zoom + Math.log2(distance / pinchRef.current.distance)),
            MIN_ZOOM,
            MAX_ZOOM,
          ),
        );
      }
      return;
    }
    if (!dragRef.current) return;
    const start = dragRef.current;
    const startPx = project(start.center, zoom);
    setCenter(
      unproject(startPx.x - (event.clientX - start.x), startPx.y - (event.clientY - start.y), zoom),
    );
  };
  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
    const remainingPointer = Array.from(pointersRef.current.values())[0];
    dragRef.current = remainingPointer
      ? { x: remainingPointer.x, y: remainingPointer.y, center }
      : null;
  };
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const now = Date.now();
    if (now - lastWheelRef.current < 80) return;
    lastWheelRef.current = now;
    changeZoom(event.deltaY < 0 ? 1 : -1);
  };

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className="relative h-[260px] w-full touch-pan-y overflow-hidden rounded-xl border border-gray-200 bg-gray-100"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onWheel={handleWheel}
      >
        {ready &&
          tiles.map((tile) => (
            <div
              key={tile.key}
              className="absolute h-64 w-64 bg-cover bg-center"
              style={{ left: tile.left, top: tile.top, backgroundImage: `url(${tile.url})` }}
            />
          ))}
        {!ready && <div className="absolute inset-0 animate-pulse bg-gray-100" />}

        {ready && (
          <>
            <MapMarker
              label={propertyName}
              color="#6d28d9"
              primary
              style={markerPosition(property)}
            />
            {pois
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((poi) => (
                <MapMarker
                  key={poi.id}
                  label={`${poi.label} - ${poi.travelTime}`}
                  color={poi.color}
                  style={markerPosition(poi)}
                />
              ))}
          </>
        )}

        <div
          className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => changeZoom(1)}
            className="h-9 w-9 border-b border-gray-200 text-lg font-semibold text-gray-700 hover:bg-gray-50"
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => changeZoom(-1)}
            className="h-9 w-9 text-lg font-semibold text-gray-700 hover:bg-gray-50"
          >
            -
          </button>
        </div>
      </div>
      <p className="text-[11px] text-gray-400">Map data (c) OpenStreetMap contributors</p>
    </div>
  );
}

function MapMarker({
  label,
  color,
  primary = false,
  style,
}: {
  label: string;
  color: string;
  primary?: boolean;
  style: { left: number; top: number };
}) {
  return (
    <div
      className="absolute z-10 flex min-h-[44px] -translate-x-1/2 -translate-y-full items-end"
      style={style}
    >
      <div className="flex items-center gap-1.5 rounded-full border border-white/80 bg-white/95 px-2.5 py-1.5 text-[11px] font-semibold text-gray-800 shadow-md">
        <span
          className={`h-3 w-3 rounded-full border-2 border-white ${primary ? "ring-2 ring-violet-200" : ""}`}
          style={{ backgroundColor: color }}
        />
        <span className="max-w-[160px] truncate">{label}</span>
      </div>
    </div>
  );
}
