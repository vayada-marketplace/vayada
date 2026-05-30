"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointOfInterest } from "@/services/settings";

const TILE_SIZE = 256;
const ZOOM = 13;

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface LocationMapPreviewProps {
  propertyName: string;
  property?: Coordinate | null;
  pois: PointOfInterest[];
  selectedPoiId?: string | null;
  onPlacePoi?: (latitude: number, longitude: number) => void;
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

function fallbackCenter(pois: PointOfInterest[]): Coordinate {
  if (pois.length > 0) {
    return {
      latitude: pois.reduce((sum, poi) => sum + poi.latitude, 0) / pois.length,
      longitude: pois.reduce((sum, poi) => sum + poi.longitude, 0) / pois.length,
    };
  }
  return { latitude: -8.65, longitude: 115.22 };
}

export function LocationMapPreview({
  propertyName,
  property,
  pois,
  selectedPoiId,
  onPlacePoi,
}: LocationMapPreviewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 520, height: 260 });
  const center = useMemo(() => property || fallbackCenter(pois), [property, pois]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const resize = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    resize.observe(node);
    return () => resize.disconnect();
  }, []);

  const centerPx = project(center, ZOOM);
  const startX = Math.floor((centerPx.x - size.width / 2) / TILE_SIZE) - 1;
  const endX = Math.floor((centerPx.x + size.width / 2) / TILE_SIZE) + 1;
  const startY = Math.floor((centerPx.y - size.height / 2) / TILE_SIZE) - 1;
  const endY = Math.floor((centerPx.y + size.height / 2) / TILE_SIZE) + 1;
  const tileCount = 2 ** ZOOM;
  const tiles = [];
  for (let x = startX; x <= endX; x += 1) {
    for (let y = startY; y <= endY; y += 1) {
      if (y < 0 || y >= tileCount) continue;
      const wrappedX = ((x % tileCount) + tileCount) % tileCount;
      tiles.push({
        key: `${x}-${y}`,
        url: `https://tile.openstreetmap.org/${ZOOM}/${wrappedX}/${y}.png`,
        left: x * TILE_SIZE - centerPx.x + size.width / 2,
        top: y * TILE_SIZE - centerPx.y + size.height / 2,
      });
    }
  }

  const markerPosition = (point: Coordinate) => {
    const px = project(point, ZOOM);
    return {
      left: px.x - centerPx.x + size.width / 2,
      top: px.y - centerPx.y + size.height / 2,
    };
  };

  return (
    <div
      ref={ref}
      className="relative h-[260px] w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
      onClick={(event) => {
        if (!onPlacePoi) return;
        const box = event.currentTarget.getBoundingClientRect();
        const x = centerPx.x - size.width / 2 + event.clientX - box.left;
        const y = centerPx.y - size.height / 2 + event.clientY - box.top;
        const point = unproject(x, y, ZOOM);
        onPlacePoi(Number(point.latitude.toFixed(7)), Number(point.longitude.toFixed(7)));
      }}
    >
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className="absolute h-64 w-64 bg-cover bg-center"
          style={{ left: tile.left, top: tile.top, backgroundImage: `url(${tile.url})` }}
        />
      ))}
      {property && (
        <Marker
          label={propertyName || "Property"}
          color="#6d28d9"
          style={markerPosition(property)}
        />
      )}
      {pois.map((poi) => (
        <Marker
          key={poi.id}
          label={poi.label || "POI"}
          color={poi.color}
          selected={poi.id === selectedPoiId}
          style={markerPosition(poi)}
        />
      ))}
      <div className="absolute bottom-2 right-2 rounded bg-white/90 px-2 py-1 text-[10px] text-gray-500 shadow-sm">
        Click map to place selected POI
      </div>
    </div>
  );
}

function Marker({
  label,
  color,
  selected = false,
  style,
}: {
  label: string;
  color: string;
  selected?: boolean;
  style: { left: number; top: number };
}) {
  return (
    <div className="absolute z-10 -translate-x-1/2 -translate-y-full" style={style}>
      <div
        className={`flex items-center gap-1.5 rounded-full border bg-white/95 px-2 py-1 text-[11px] font-semibold text-gray-800 shadow ${selected ? "border-primary-500" : "border-white"}`}
      >
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="max-w-[130px] truncate">{label}</span>
      </div>
    </div>
  );
}
