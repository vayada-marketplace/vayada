"use client";

import { useState } from "react";
import {
  RoomImportPreview,
  type ReviewedRoomImport,
} from "@vayada/product-onboarding/RoomImportPreview";
import type { RoomTypeCreate } from "@/services/rooms";

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
    </section>
  );
}
