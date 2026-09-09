"use client";

import { useState } from "react";
import {
  RoomImportPreview,
  type ReviewedRoomImport,
  type RoomImportCandidate,
} from "@vayada/product-onboarding/RoomImportPreview";
import type { RoomTypeCreate } from "@/services/rooms";

export function parseChannexSnapshot(text: string): RoomImportCandidate {
  if (text.length > 16_384) throw new Error("Snapshot is too large.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid snapshot.");
  const data = value as Record<string, unknown>;
  if (
    typeof data.name !== "string" ||
    !data.name.trim() ||
    data.name.length > 200 ||
    typeof data.description !== "string" ||
    data.description.length > 5000 ||
    typeof data.maxGuests !== "number" ||
    !Number.isInteger(data.maxGuests) ||
    data.maxGuests < 1 ||
    data.maxGuests > 100 ||
    typeof data.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(data.checkedAt))
  )
    throw new Error("Snapshot needs a name, description, guest capacity and valid read date.");
  return {
    name: data.name.trim(),
    description: data.description,
    maxGuests: data.maxGuests,
    sourceLabel: `Uploaded Channex snapshot · reported read ${new Date(data.checkedAt).toISOString()} · verify the source and destination hotel before saving`,
  };
}

export function roomImportPatch(draft: ReviewedRoomImport): Partial<RoomTypeCreate> {
  return {
    ...(draft.name !== undefined ? { name: draft.name } : {}),
    ...(draft.description !== undefined ? { description: draft.description } : {}),
    ...(draft.maxGuests !== undefined ? { maxOccupancy: draft.maxGuests } : {}),
  };
}

export function RoomImportStart({
  onContinue,
}: {
  onContinue: (patch: Partial<RoomTypeCreate>) => void;
}) {
  const [preview, setPreview] = useState(false);
  const [snapshot, setSnapshot] = useState<RoomImportCandidate | null>(null);
  const [snapshotError, setSnapshotError] = useState("");
  if (snapshot)
    return (
      <RoomImportPreview
        candidate={snapshot}
        onCancel={() => setSnapshot(null)}
        onApply={(draft) => onContinue(roomImportPatch(draft))}
      />
    );
  if (preview)
    return (
      <RoomImportPreview
        candidate={{
          sourceLabel: "Fictional example · no Airbnb or Booking.com connection",
          name: "Example Garden Suite",
          description:
            "A fictional suite used to test room prefill. Replace these details before saving.",
          maxGuests: 3,
        }}
        onCancel={() => setPreview(false)}
        onApply={(draft) => onContinue(roomImportPatch(draft))}
      />
    );
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6">
      <h2 className="text-xl font-semibold">Room import experiment</h2>
      <p className="mt-2 text-sm text-gray-600">
        Try the review flow with fictional data, or start with an empty room form. No provider data
        is fetched.
      </p>
      <div className="mt-5 flex gap-3">
        <button
          type="button"
          className="rounded bg-primary-600 px-4 py-2 text-white"
          onClick={() => setPreview(true)}
        >
          Review example
        </button>
        <button type="button" className="rounded border px-4 py-2" onClick={() => onContinue({})}>
          Start manually
        </button>
      </div>
      <label className="mt-5 block text-sm font-medium">
        Review a saved Channex read
        <input
          type="file"
          accept="application/json,.json"
          className="mt-2 block text-sm"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setSnapshotError("");
            try {
              if (file.size > 16_384) throw new Error("Snapshot is too large.");
              setSnapshot(parseChannexSnapshot(await file.text()));
            } catch {
              setSnapshotError(
                "Could not read this snapshot. Choose a valid Channex preview JSON file (up to 16 KB).",
              );
            }
          }}
        />
      </label>
      <p className="mt-2 text-sm text-gray-600">
        Local experiment: the file stays in this browser. Loading it does not connect an account or
        create a room.
      </p>
      {snapshotError && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {snapshotError}
        </p>
      )}
    </section>
  );
}
