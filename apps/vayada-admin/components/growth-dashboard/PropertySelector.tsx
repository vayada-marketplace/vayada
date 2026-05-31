"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { PlatformProperty } from "@/services/api/growthDashboard";

const statusClasses = {
  live: "bg-emerald-100 text-emerald-700",
  demo: "bg-amber-100 text-amber-700",
  test: "bg-red-100 text-red-700",
};

export function PropertySelector({
  open,
  properties,
  selectedIds,
  onApply,
  onClose,
}: {
  open: boolean;
  properties: PlatformProperty[];
  selectedIds: string[];
  onApply: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [draftIds, setDraftIds] = useState(selectedIds);
  const dialogRef = useRef<HTMLElement | null>(null);
  const selected = new Set(draftIds);

  useEffect(() => {
    if (open) {
      setDraftIds(selectedIds);
      requestAnimationFrame(() => dialogRef.current?.focus());
    }
  }, [open, selectedIds]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return properties;
    return properties.filter((property) =>
      `${property.name} ${property.slug} ${property.status}`.toLowerCase().includes(q),
    );
  }, [properties, query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-gray-900/35">
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="property-selector-title"
        tabIndex={-1}
        className="flex h-full w-full max-w-lg flex-col bg-gray-50 shadow-xl outline-none"
      >
        <div className="border-b border-gray-200 bg-white px-5 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 id="property-selector-title" className="text-xl font-semibold text-gray-900">
                Properties
              </h2>
              <p className="mt-1 text-[13px] text-gray-500">
                Choose which properties feed the dashboard
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900"
              aria-label="Close property selector"
            >
              <XMarkIcon className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search properties"
            className="mt-4 h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-[13px] outline-none placeholder:text-gray-400 focus:ring-2 focus:ring-gray-200"
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() =>
                setDraftIds(properties.filter((p) => p.status === "live").map((p) => p.id))
              }
              className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-medium text-gray-600 transition-colors hover:bg-gray-50"
            >
              Select all live
            </button>
            <button
              type="button"
              onClick={() => setDraftIds([])}
              className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-medium text-gray-600 transition-colors hover:bg-gray-50"
            >
              Clear all
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-2">
            {filtered.map((property) => (
              <label
                key={property.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 transition-colors hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={selected.has(property.id)}
                  onChange={(event) => {
                    if (event.target.checked) {
                      setDraftIds([...draftIds, property.id]);
                    } else {
                      setDraftIds(draftIds.filter((id) => id !== property.id));
                    }
                  }}
                  className="h-4 w-4 accent-gray-900"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-gray-900">
                    {property.name}
                  </span>
                  <span className="block truncate text-[12px] text-gray-500">{property.slug}</span>
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${statusClasses[property.status]}`}
                >
                  {property.status}
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="border-t border-gray-200 bg-white px-5 py-4">
          <button
            type="button"
            onClick={() => onApply(draftIds)}
            className="h-10 w-full rounded-lg bg-gray-900 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-gray-700"
          >
            Apply {draftIds.length} properties
          </button>
        </div>
      </aside>
    </div>
  );
}
