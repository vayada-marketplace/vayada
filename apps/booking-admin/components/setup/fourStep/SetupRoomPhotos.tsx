"use client";

import { PhotoIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

import {
  ROOM_DESCRIPTION_MAX_LENGTH,
  type RoomAuthoringDraft,
} from "../adaptive/rooms/roomAuthoringState";
import { SetupRadioCard } from "./SetupRoomChoice";
import { SetupStepHeading, SETUP_INPUT, SETUP_LABEL } from "./SetupStepHeading";
import type { SetupRoomLocation } from "./setupRoom";

export const SETUP_PHOTO_TYPES = "image/jpeg,image/png,image/webp";

/**
 * VAY-2451 step 3b, "Photos, description & location": at least one photo (the first is the room card's
 * cover), the description guests read under View details, and whether the room sits at the property's
 * address or its own (VAY-2321's choice in Rooms & Rates).
 */
export function SetupRoomPhotos({
  room,
  onChange,
  maxPhotos,
  onAddFiles,
  location,
  onLocationChange,
  photoError,
}: {
  room: RoomAuthoringDraft;
  onChange: (room: RoomAuthoringDraft) => void;
  maxPhotos: number;
  onAddFiles: (files: File[]) => void;
  location: SetupRoomLocation;
  onLocationChange: (location: SetupRoomLocation) => void;
  photoError?: string | null;
}) {
  const ready = room.photos.filter((photo) => photo.uploadState === "ready").length;
  return (
    <div>
      <SetupStepHeading
        title="Photos, description & location"
        subtitle="At least one photo. The first one is the cover on the room card."
      />
      <div className="mt-7 flex flex-col gap-6">
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <p className={SETUP_LABEL}>
              Room photos
              <span aria-hidden="true" className="ml-0.5 text-red-600">
                *
              </span>
            </p>
            <p className="text-[13px] text-gray-500">
              {`${ready} of ${maxPhotos} · JPG, PNG or WebP, up to 10 MB`}
            </p>
          </div>
          <ul className="mt-2 grid grid-cols-3 gap-2 min-[720px]:grid-cols-5">
            {room.photos.map((photo, index) => (
              <li
                key={photo.mediaObjectId}
                className="relative aspect-[4/3] overflow-hidden rounded-[10px] border border-gray-200 bg-gray-100"
              >
                {photo.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- an uploaded photo or a local preview
                  <img src={photo.previewUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <PhotoIcon className="m-auto mt-4 h-6 w-6 text-gray-400" aria-hidden="true" />
                )}
                {index === 0 && photo.uploadState === "ready" ? (
                  <span className="absolute left-1.5 top-1.5 rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-gray-950 shadow">
                    Cover
                  </span>
                ) : null}
                {photo.uploadState !== "ready" ? (
                  <span
                    className={`absolute inset-x-0 bottom-0 px-1.5 py-1 text-[11px] font-semibold ${
                      photo.uploadState === "failed"
                        ? "bg-red-600 text-white"
                        : "bg-white/90 text-gray-700"
                    }`}
                  >
                    {photo.uploadState === "failed" ? "Didn't upload" : "Uploading…"}
                  </span>
                ) : null}
                {photo.uploadState !== "uploading" ? (
                  <button
                    type="button"
                    aria-label={`Remove photo ${index + 1}`}
                    onClick={() =>
                      onChange({
                        ...room,
                        photos: room.photos.filter(
                          (other) => other.mediaObjectId !== photo.mediaObjectId,
                        ),
                      })
                    }
                    className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-white text-gray-700 shadow outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600"
                  >
                    <XMarkIcon className="h-4 w-4 stroke-2" aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            ))}
            {room.photos.length < maxPhotos ? (
              <li>
                <label className="flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed border-primary-300 bg-primary-50 text-[13px] font-semibold text-primary-700 focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2">
                  <PlusIcon className="h-5 w-5 stroke-2" aria-hidden="true" />
                  Add photos
                  <input
                    type="file"
                    multiple
                    accept={SETUP_PHOTO_TYPES}
                    aria-label="Add room photos"
                    className="sr-only"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = "";
                      if (files.length) onAddFiles(files);
                    }}
                  />
                </label>
              </li>
            ) : null}
          </ul>
          {photoError ? (
            <p role="alert" className="mt-1.5 text-[13px] text-red-700">
              {photoError}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="setup-room-description" className={SETUP_LABEL}>
            Room description
          </label>
          <textarea
            id="setup-room-description"
            value={room.description}
            maxLength={ROOM_DESCRIPTION_MAX_LENGTH}
            rows={3}
            onChange={(event) => onChange({ ...room, description: event.target.value })}
            placeholder="What makes this room special: the view, the bed, the bathroom, the space."
            className={`${SETUP_INPUT} h-auto min-h-[84px] py-3`}
          />
          <p className="mt-1.5 text-[13px] text-gray-500">
            Shown when a guest clicks View details.
          </p>
        </div>

        <div>
          <p className={SETUP_LABEL}>Location</p>
          <div
            role="radiogroup"
            aria-label="Room location"
            className="mt-2 grid grid-cols-1 gap-2 min-[720px]:grid-cols-2"
          >
            <SetupRadioCard
              title="Same as property"
              description="Uses your property address and pin"
              selected={location.source === "property"}
              onSelect={() => onLocationChange({ ...location, source: "property" })}
            />
            <SetupRadioCard
              title="Separate location"
              description="For a villa or unit at another address"
              selected={location.source === "custom"}
              onSelect={() => onLocationChange({ ...location, source: "custom" })}
            />
          </div>
          {location.source === "custom" ? (
            <div className="mt-3 flex flex-col gap-3">
              <input
                aria-label="Address of this room"
                value={location.address}
                onChange={(event) => onLocationChange({ ...location, address: event.target.value })}
                placeholder="The address of this villa or unit"
                className={SETUP_INPUT}
              />
              <div className="flex items-center justify-between gap-3">
                <span>
                  <span className="block text-sm font-semibold text-gray-950">
                    Show map in room details
                  </span>
                  <span className="block text-[13px] text-gray-500">
                    Guests see where this room is on your booking page.
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={location.showMap}
                  aria-label="Show map in room details"
                  onClick={() => onLocationChange({ ...location, showMap: !location.showMap })}
                  className={`relative h-6 w-11 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 ${
                    location.showMap ? "bg-primary-600" : "bg-gray-300"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] ${
                      location.showMap ? "left-[22px]" : "left-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
