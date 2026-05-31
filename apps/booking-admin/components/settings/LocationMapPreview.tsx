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
  onMovePoi?: (id: string, latitude: number, longitude: number) => void;
}

interface DragState {
  poiId: string;
  left: number;
  top: number;
  offsetX: number;
  offsetY: number;
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
  onMovePoi,
}: LocationMapPreviewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 520, height: 260 });
  const center = useMemo(() => property || fallbackCenter(pois), [property, pois]);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const suppressNextClick = useRef(false);

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

  const handlePoiMouseDown = (poi: PointOfInterest) => (e: React.MouseEvent) => {
    if (!onMovePoi) return;
    suppressNextClick.current = true;
    const box = ref.current!.getBoundingClientRect();
    const mLeft = e.clientX - box.left;
    const mTop = e.clientY - box.top;
    const { left, top } = markerPosition(poi);
    setDragging({ poiId: poi.id, left, top, offsetX: mLeft - left, offsetY: mTop - top });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging || e.buttons !== 1) return;
    const box = ref.current!.getBoundingClientRect();
    const mLeft = e.clientX - box.left;
    const mTop = e.clientY - box.top;
    setDragging((d) => (d ? { ...d, left: mLeft - d.offsetX, top: mTop - d.offsetY } : null));
  };

  const handleMouseUp = () => {
    if (!dragging) return;
    if (onMovePoi) {
      const { left, top, poiId } = dragging;
      const worldX = left + centerPx.x - size.width / 2;
      const worldY = top + centerPx.y - size.height / 2;
      const point = unproject(worldX, worldY, ZOOM);
      onMovePoi(poiId, Number(point.latitude.toFixed(7)), Number(point.longitude.toFixed(7)));
    }
    setDragging(null);
  };

  const hintText = selectedPoiId
    ? "Click map to place · Drag pins to reposition"
    : pois.length > 0
      ? "Drag pins to reposition"
      : null;

  return (
    <div
      ref={ref}
      className={`relative h-[260px] w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-100 ${dragging ? "cursor-grabbing select-none" : ""}`}
      onClick={(event) => {
        if (suppressNextClick.current) {
          suppressNextClick.current = false;
          return;
        }
        if (!onPlacePoi) return;
        const box = event.currentTarget.getBoundingClientRect();
        const x = centerPx.x - size.width / 2 + event.clientX - box.left;
        const y = centerPx.y - size.height / 2 + event.clientY - box.top;
        const point = unproject(x, y, ZOOM);
        onPlacePoi(Number(point.latitude.toFixed(7)), Number(point.longitude.toFixed(7)));
      }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => setDragging(null)}
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
      {pois.map((poi) => {
        const isDraggingThis = dragging?.poiId === poi.id;
        const style = isDraggingThis ? { left: dragging!.left, top: dragging!.top } : markerPosition(poi);
        return (
          <Marker
            key={poi.id}
            label={poi.label || "POI"}
            color={poi.color}
            selected={poi.id === selectedPoiId}
            draggable={!!onMovePoi}
            isDragging={isDraggingThis}
            style={style}
            onMouseDown={handlePoiMouseDown(poi)}
          />
        );
      })}
      {hintText && (
        <div className="absolute bottom-2 right-2 rounded bg-white/90 px-2 py-1 text-[10px] text-gray-500 shadow-sm">
          {hintText}
        </div>
      )}
    </div>
  );
}

function Marker({
  label,
  color,
  selected = false,
  draggable = false,
  isDragging = false,
  style,
  onMouseDown,
}: {
  label: string;
  color: string;
  selected?: boolean;
  draggable?: boolean;
  isDragging?: boolean;
  style: { left: number; top: number };
  onMouseDown?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`absolute -translate-x-1/2 -translate-y-full ${isDragging ? "z-20 cursor-grabbing" : draggable ? "z-10 cursor-grab" : "z-10"}`}
      style={style}
      onMouseDown={onMouseDown}
    >
      <div
        className={`flex items-center gap-1.5 rounded-full border bg-white/95 px-2 py-1 text-[11px] font-semibold text-gray-800 shadow transition-shadow ${selected ? "border-primary-500" : "border-white"} ${isDragging ? "scale-110 shadow-md" : ""}`}
      >
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="max-w-[130px] truncate">{label}</span>
      </div>
    </div>
  );
}
