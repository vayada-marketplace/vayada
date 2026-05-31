"use client";

import { useEffect, useRef, useState } from "react";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";

interface Suggestion {
  placeId: string;
  displayName: string;
  latitude: number;
  longitude: number;
}

interface PoiSearchInputProps {
  onSelect: (latitude: number, longitude: number, name: string) => void;
}

export function PoiSearchInput({ onSelect }: PoiSearchInputProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const search = async (q: string) => {
    setLoading(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&addressdetails=0`,
        { headers: { "Accept-Language": "en" } },
      );
      if (!res.ok) return;
      const data: { place_id: number; display_name: string; lat: string; lon: string }[] =
        await res.json();
      setSuggestions(
        data.map((d) => ({
          placeId: String(d.place_id),
          displayName: d.display_name,
          latitude: parseFloat(d.lat),
          longitude: parseFloat(d.lon),
        })),
      );
      setOpen(true);
    } catch {
      // silently ignore network errors — fall back to click-to-place
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (value: string) => {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (value.trim().length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    timerRef.current = setTimeout(() => search(value.trim()), 300);
  };

  const handleSelect = (s: Suggestion) => {
    onSelect(
      Number(s.latitude.toFixed(7)),
      Number(s.longitude.toFixed(7)),
      s.displayName.split(",")[0].trim(),
    );
    setQuery("");
    setSuggestions([]);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onClick={() => suggestions.length > 0 && setOpen(true)}
          placeholder="Search location (e.g. Kuta Beach)"
          className="w-full rounded-lg border border-gray-300 pl-8 pr-2.5 py-1.5 text-[13px] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        {loading && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
        )}
      </div>

      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
          {suggestions.map((s) => (
            <li key={s.placeId}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(s)}
                className="w-full px-3 py-2 text-left text-[12px] text-gray-800 hover:bg-primary-50 hover:text-primary-700 truncate"
              >
                {s.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && suggestions.length === 0 && !loading && query.trim().length >= 3 && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-500 shadow-lg">
          No results — try clicking the map to place manually.
        </div>
      )}
    </div>
  );
}
