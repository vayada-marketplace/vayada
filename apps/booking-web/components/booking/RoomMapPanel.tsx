"use client";

import Image from "next/image";
import { RoomType } from "@/lib/types";
import { useCurrency } from "@/contexts/CurrencyContext";

interface RoomMapPanelProps {
  rooms: RoomType[];
  activeRoomId: string | null;
  hoveredRoomId: string | null;
  onHoverRoom: (roomId: string | null) => void;
  onSelectRoom: (roomId: string) => void;
  className?: string;
}

function hasCoordinates(
  room: RoomType,
): room is RoomType & { latitude: number; longitude: number } {
  return typeof room.latitude === "number" && typeof room.longitude === "number";
}

function compactCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(amount);
}

export default function RoomMapPanel({
  rooms,
  activeRoomId,
  hoveredRoomId,
  onHoverRoom,
  onSelectRoom,
  className = "",
}: RoomMapPanelProps) {
  const { convertAndRound, selectedCurrency } = useCurrency();
  const mappedRooms = rooms.filter(hasCoordinates);

  if (mappedRooms.length === 0) {
    return (
      <div
        className={`min-h-[360px] rounded-2xl border border-dashed border-gray-300 bg-gray-50 flex items-center justify-center p-8 text-center ${className}`}
      >
        <div>
          <p className="text-sm font-semibold text-gray-900">No locations available</p>
          <p className="mt-1 text-sm text-gray-500">
            Room types without saved coordinates still appear in the list.
          </p>
        </div>
      </div>
    );
  }

  const latitudes = mappedRooms.map((room) => room.latitude);
  const longitudes = mappedRooms.map((room) => room.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const latSpan = Math.max(maxLat - minLat, 0.01);
  const lngSpan = Math.max(maxLng - minLng, 0.01);

  const positionFor = (room: (typeof mappedRooms)[number]) => ({
    left: `${12 + ((room.longitude - minLng) / lngSpan) * 76}%`,
    top: `${12 + ((maxLat - room.latitude) / latSpan) * 76}%`,
  });

  return (
    <div
      className={`relative min-h-[520px] overflow-hidden rounded-2xl border border-gray-200 bg-slate-100 shadow-sm ${className}`}
    >
      {/* Provider choice: this map surface is intentionally isolated so Mapbox GL can
          replace the lightweight preview when a platform API key is configured. Mapbox
          is the preferred provider for custom HTML price pins, built-in clustering,
          mobile gestures, and lower guest-page bundle impact via lazy loading. */}
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(148,163,184,0.3)_1px,transparent_1px),linear-gradient(0deg,rgba(148,163,184,0.3)_1px,transparent_1px)] bg-[size:56px_56px]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(14,165,233,0.18),transparent_28%),radial-gradient(circle_at_80%_30%,rgba(16,185,129,0.2),transparent_22%),linear-gradient(135deg,#f8fafc,#e0f2fe_42%,#ecfdf5)]" />
      <div className="absolute left-8 top-12 h-24 w-[70%] -rotate-6 rounded-full border-y border-sky-300/50" />
      <div className="absolute -right-16 bottom-20 h-40 w-[65%] rotate-12 rounded-full border-y border-emerald-300/60" />

      <div className="absolute left-4 top-4 rounded-xl bg-white/90 px-3 py-2 text-xs font-semibold text-gray-700 shadow-sm border border-white">
        {mappedRooms.length} location{mappedRooms.length === 1 ? "" : "s"}
      </div>

      <div className="absolute right-4 top-4 flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white/90 shadow-sm">
        <button className="h-9 w-9 text-lg font-semibold text-gray-700 hover:bg-gray-50">+</button>
        <div className="h-px bg-gray-200" />
        <button className="h-9 w-9 text-lg font-semibold text-gray-700 hover:bg-gray-50">-</button>
      </div>

      {mappedRooms.map((room) => {
        const active = activeRoomId === room.id;
        const hovered = hoveredRoomId === room.id;
        const displayPrice = compactCurrency(
          convertAndRound(room.baseRate, room.currency),
          selectedCurrency,
        );
        const position = positionFor(room);
        return (
          <div
            key={room.id}
            className="absolute -translate-x-1/2 -translate-y-full"
            style={position}
            onMouseEnter={() => onHoverRoom(room.id)}
            onMouseLeave={() => onHoverRoom(null)}
          >
            <button
              type="button"
              onClick={() => onSelectRoom(room.id)}
              className={`relative rounded-full px-3 py-1.5 text-xs font-bold shadow-lg transition-all ${
                active || hovered
                  ? "scale-110 bg-primary-600 text-white ring-4 ring-primary-500/20"
                  : "bg-white text-gray-900 hover:scale-105"
              }`}
            >
              {displayPrice}
            </button>
            {(active || hovered) && (
              <div className="absolute left-1/2 top-full z-10 mt-3 w-64 -translate-x-1/2 rounded-xl border border-gray-200 bg-white p-3 shadow-xl">
                <div className="flex gap-3">
                  <div className="relative h-14 w-16 shrink-0 overflow-hidden rounded-lg bg-gray-100">
                    {room.images?.[0] && (
                      <Image src={room.images[0]} alt="" fill className="object-cover" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-gray-900">{room.name}</p>
                    <p className="text-xs text-gray-500">{displayPrice} / night</p>
                    <button
                      type="button"
                      onClick={() => onSelectRoom(room.id)}
                      className="mt-2 text-xs font-semibold text-primary-700 hover:text-primary-800"
                    >
                      View -&gt;
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
