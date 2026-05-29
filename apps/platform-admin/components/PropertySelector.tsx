"use client";

import { useEffect, useMemo, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { PlatformProperty } from "@/services/platformAdmin";

const statusClasses = {
  live: "bg-reed/15 text-reed",
  demo: "bg-brass/15 text-brass",
  test: "bg-ember/15 text-ember",
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
  const selected = new Set(draftIds);

  useEffect(() => {
    if (open) {
      setDraftIds(selectedIds);
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
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30">
      <aside className="flex h-full w-full max-w-lg flex-col bg-bone shadow-panel">
        <div className="border-b border-ink/10 px-5 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
                Filter set
              </p>
              <h2 className="mt-1 text-xl font-semibold">Properties</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-ink/10 bg-white hover:bg-ink hover:text-bone"
              aria-label="Close property selector"
            >
              <XMarkIcon className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search properties"
            className="mt-4 h-10 w-full rounded-md border border-ink/10 bg-white px-3 outline-none ring-lagoon/20 focus:border-lagoon focus:ring-4"
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() =>
                setDraftIds(properties.filter((p) => p.status === "live").map((p) => p.id))
              }
              className="rounded-md border border-ink/10 bg-white px-3 py-2 text-sm font-medium hover:border-reed hover:text-reed"
            >
              Select all live
            </button>
            <button
              type="button"
              onClick={() => setDraftIds([])}
              className="rounded-md border border-ink/10 bg-white px-3 py-2 text-sm font-medium hover:border-ember hover:text-ember"
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
                className="flex cursor-pointer items-center gap-3 rounded-md border border-ink/10 bg-white p-3 hover:border-lagoon/40"
              >
                <input
                  type="checkbox"
                  checked={selected.has(property.id)}
                  onChange={(event) => {
                    if (event.target.checked) {
                      setDraftIds((prev) => [...prev, property.id]);
                    } else {
                      setDraftIds((prev) => prev.filter((id) => id !== property.id));
                    }
                  }}
                  className="h-4 w-4 accent-lagoon"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{property.name}</span>
                  <span className="block truncate text-xs text-ink/50">{property.slug}</span>
                </span>
                <span
                  className={`rounded px-2 py-1 text-xs font-semibold ${statusClasses[property.status]}`}
                >
                  {property.status}
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="border-t border-ink/10 bg-white px-5 py-4">
          <button
            type="button"
            onClick={() => onApply(draftIds)}
            className="h-10 w-full rounded-md bg-ink px-4 text-sm font-semibold text-bone hover:bg-lagoon"
          >
            Apply {draftIds.length} properties
          </button>
        </div>
      </aside>
    </div>
  );
}
