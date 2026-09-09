"use client";

import { useState } from "react";

export type RoomImportCandidate = {
  sourceLabel: string;
  name: string;
  description: string;
  maxGuests: number;
};
export type ReviewedRoomImport = Partial<
  Pick<RoomImportCandidate, "name" | "description" | "maxGuests">
>;

/** Review only: the caller owns property scope, persistence, and all other room fields. */
export function RoomImportPreview({
  candidate,
  onApply,
  onCancel,
}: {
  candidate: RoomImportCandidate;
  onApply: (draft: ReviewedRoomImport) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState({
    name: candidate.name,
    description: candidate.description,
    maxGuests: String(candidate.maxGuests),
  });
  const [selected, setSelected] = useState({ name: true, description: true, maxGuests: true });
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState("");
  const keys = ["name", "description", "maxGuests"] as const;
  const labels = { name: "Room name", description: "Description", maxGuests: "Maximum guests" };
  return (
    <section
      aria-label="Review room import"
      className="rounded-xl border border-gray-200 bg-white p-6"
    >
      <h2 className="text-xl font-semibold">Review room details</h2>
      <p className="mt-2 text-sm text-gray-600">{candidate.sourceLabel}</p>
      <p className="mt-2 text-sm text-gray-600">
        Choose what to copy. You will finish the normal room form before creating anything.
      </p>
      {keys.map((key) => (
        <div className="mt-5" key={key}>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={selected[key]}
              onChange={(e) => {
                setSelected({ ...selected, [key]: e.target.checked });
                setReviewed(false);
              }}
            />
            Copy {labels[key].toLowerCase()}
          </label>
          <label className="mt-2 block text-sm" htmlFor={`import-${key}`}>
            {labels[key]}
          </label>
          {key === "description" ? (
            <textarea
              id={`import-${key}`}
              disabled={!selected[key]}
              value={draft[key]}
              maxLength={5000}
              className="mt-1 w-full rounded border p-2"
              onChange={(e) => {
                setDraft({ ...draft, [key]: e.target.value });
                setReviewed(false);
              }}
            />
          ) : (
            <input
              id={`import-${key}`}
              disabled={!selected[key]}
              value={draft[key]}
              type={key === "maxGuests" ? "number" : "text"}
              min={key === "maxGuests" ? 1 : undefined}
              max={key === "maxGuests" ? 100 : undefined}
              step={1}
              maxLength={200}
              className="mt-1 w-full rounded border p-2"
              onChange={(e) => {
                setDraft({ ...draft, [key]: e.target.value });
                setReviewed(false);
              }}
            />
          )}
        </div>
      ))}
      <p className="mt-4 text-sm text-gray-600">
        Bed setup, bathroom type, size, amenities, room count, photos and pricing still need your
        review in the room form.
      </p>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
        I reviewed the selected values
      </label>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="mt-5 flex gap-3">
        <button
          type="button"
          disabled={!reviewed || !keys.some((key) => selected[key])}
          className="rounded bg-primary-600 px-4 py-2 text-white disabled:opacity-40"
          onClick={() => {
            const guests = Number(draft.maxGuests);
            if (
              (selected.name && !draft.name.trim()) ||
              (selected.maxGuests && (!Number.isInteger(guests) || guests < 1 || guests > 100))
            ) {
              setError(
                "Enter a room name and a whole guest count from 1 to 100 for selected fields.",
              );
              return;
            }
            onApply({
              ...(selected.name ? { name: draft.name.trim() } : {}),
              ...(selected.description ? { description: draft.description.trim() } : {}),
              ...(selected.maxGuests ? { maxGuests: guests } : {}),
            });
          }}
        >
          Use selected details
        </button>
        <button type="button" className="rounded border px-4 py-2" onClick={onCancel}>
          Cancel preview
        </button>
      </div>
    </section>
  );
}
