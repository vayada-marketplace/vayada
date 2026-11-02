"use client";

import { MinusIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

import {
  ROOM_BED_TYPES,
  ROOM_CATEGORIES,
  type RoomAuthoringDraft,
} from "../adaptive/rooms/roomAuthoringState";
import { SetupStepHeading, SETUP_INPUT, SETUP_LABEL } from "./SetupStepHeading";
import { withPrivateBathrooms } from "./setupRoom";

const BED_LABEL = new Map<string, string>(ROOM_BED_TYPES);

export function bedsSummary(room: RoomAuthoringDraft): string {
  return room.beds
    .filter((bed) => bed.type)
    .map((bed) => {
      const count = Number(bed.quantity) || 1;
      const label = (BED_LABEL.get(bed.type) ?? bed.type).toLowerCase();
      return `${count} ${count === 1 ? label : `${label}s`}`;
    })
    .join(", ");
}

const STEP_BUTTON =
  "flex h-10 w-10 items-center justify-center rounded-[10px] border border-gray-300 bg-white text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-not-allowed disabled:opacity-40";

function Stepper({
  label,
  value,
  min,
  noun,
  required = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  noun: string;
  required?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <p className={SETUP_LABEL}>
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-0.5 text-red-600">
            *
          </span>
        ) : null}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          aria-label={`Fewer ${noun}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
          className={STEP_BUTTON}
        >
          <MinusIcon className="h-4 w-4 stroke-2" aria-hidden="true" />
        </button>
        <span
          aria-live="polite"
          className="w-10 text-center text-[15px] font-semibold text-gray-950"
        >
          {value}
        </span>
        <button
          type="button"
          aria-label={`More ${noun}`}
          onClick={() => onChange(value + 1)}
          className={STEP_BUTTON}
        >
          <PlusIcon className="h-4 w-4 stroke-2" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

const number = (value: string, fallback = 0) => (/^\d+$/.test(value) ? Number(value) : fallback);

/**
 * VAY-2451 step 3a, "Room basics": what Rooms & Rates › Room Details asks, with the server's own bed types and
 * room categories. Name and size are required; the rest starts filled.
 */
export function SetupRoomBasics({
  room,
  onChange,
}: {
  room: RoomAuthoringDraft;
  onChange: (room: RoomAuthoringDraft) => void;
}) {
  const set = (patch: Partial<RoomAuthoringDraft>) => onChange({ ...room, ...patch });
  const total = number(room.maxGuests, 1);
  const adults = number(room.maxAdults, 1);
  const children = number(room.maxChildren);
  const privateBathrooms = room.bathroomType === "private" ? number(room.bathrooms, 1) : 0;
  return (
    <div>
      <SetupStepHeading
        title="Room basics"
        subtitle="What guests see on the room card. Fields with * are required."
      />
      <div className="mt-7 flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-x-4 gap-y-5 min-[720px]:grid-cols-[1fr_180px]">
          <div>
            <label htmlFor="setup-room-name" className={SETUP_LABEL}>
              Room type name
              <span aria-hidden="true" className="ml-0.5 text-red-600">
                *
              </span>
            </label>
            <input
              id="setup-room-name"
              value={room.name}
              maxLength={200}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="e.g. Deluxe Double Room, Pool Villa"
              className={SETUP_INPUT}
            />
          </div>
          <div>
            <label htmlFor="setup-room-size" className={SETUP_LABEL}>
              Room size
              <span aria-hidden="true" className="ml-0.5 text-red-600">
                *
              </span>
            </label>
            <div className="relative">
              <input
                id="setup-room-size"
                type="number"
                inputMode="decimal"
                min={1}
                value={room.sizeSquareMetres}
                onChange={(event) => set({ sizeSquareMetres: event.target.value })}
                placeholder="e.g. 35"
                className={`${SETUP_INPUT} pr-12`}
              />
              <span className="pointer-events-none absolute bottom-0 right-3.5 flex h-12 items-center text-[15px] text-gray-500">
                m²
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Stepper
            label="Rooms of this type"
            noun="rooms"
            required
            min={1}
            value={number(room.unitCount, 1)}
            onChange={(value) => set({ unitCount: String(value) })}
          />
          <Stepper
            label="Bedrooms"
            noun="bedrooms"
            min={0}
            value={number(room.bedrooms)}
            onChange={(value) => set({ bedrooms: String(value) })}
          />
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <p className={SETUP_LABEL}>
              Beds
              <span aria-hidden="true" className="ml-0.5 text-red-600">
                *
              </span>
            </p>
            <p className="truncate text-[13px] text-gray-500">{bedsSummary(room)}</p>
          </div>
          <div className="mt-1.5 flex flex-col gap-2">
            {room.beds.map((bed, index) => (
              <div key={bed.id} className="flex items-center gap-2">
                <select
                  aria-label="Bed type"
                  value={bed.type}
                  onChange={(event) =>
                    set({
                      beds: room.beds.map((other, at) =>
                        at === index ? { ...other, type: event.target.value } : other,
                      ),
                    })
                  }
                  className={`${SETUP_INPUT} mt-0 min-w-0 flex-1`}
                >
                  <option value="">Choose a bed</option>
                  {ROOM_BED_TYPES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label="Fewer of this bed"
                  disabled={number(bed.quantity, 1) <= 1}
                  onClick={() =>
                    set({
                      beds: room.beds.map((other, at) =>
                        at === index
                          ? {
                              ...other,
                              quantity: String(Math.max(1, number(other.quantity, 1) - 1)),
                            }
                          : other,
                      ),
                    })
                  }
                  className={STEP_BUTTON}
                >
                  <MinusIcon className="h-4 w-4 stroke-2" aria-hidden="true" />
                </button>
                <span className="w-6 text-center text-[15px] font-semibold">
                  {number(bed.quantity, 1)}
                </span>
                <button
                  type="button"
                  aria-label="More of this bed"
                  onClick={() =>
                    set({
                      beds: room.beds.map((other, at) =>
                        at === index
                          ? {
                              ...other,
                              quantity: String(Math.min(20, number(other.quantity, 1) + 1)),
                            }
                          : other,
                      ),
                    })
                  }
                  className={STEP_BUTTON}
                >
                  <PlusIcon className="h-4 w-4 stroke-2" aria-hidden="true" />
                </button>
                {room.beds.length > 1 ? (
                  <button
                    type="button"
                    aria-label="Remove bed"
                    onClick={() => set({ beds: room.beds.filter((_bed, at) => at !== index) })}
                    className="flex h-10 w-10 items-center justify-center rounded-[10px] text-gray-500 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-primary-600"
                  >
                    <XMarkIcon className="h-4 w-4 stroke-2" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() =>
              set({
                beds: [
                  ...room.beds,
                  { id: `${room.draftRoomId}:bed:${Date.now()}`, type: "single", quantity: "1" },
                ],
              })
            }
            className="mt-2 rounded text-sm font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
          >
            + Add another bed type
          </button>
        </div>

        <div>
          <div className="grid grid-cols-2 gap-4 min-[720px]:grid-cols-3">
            <Stepper
              label="Total max occupancy"
              noun="guests"
              required
              min={1}
              value={total}
              onChange={(value) =>
                set({
                  maxGuests: String(value),
                  // Adults follow the total while they were at it, so the limits keep covering it.
                  ...(adults === total || adults > value ? { maxAdults: String(value) } : {}),
                  ...(children > value ? { maxChildren: String(value) } : {}),
                })
              }
            />
            <Stepper
              label="Max adults"
              noun="adults"
              min={1}
              value={adults}
              onChange={(value) => set({ maxAdults: String(Math.min(value, total)) })}
            />
            <Stepper
              label="Max children"
              noun="children"
              min={0}
              value={children}
              onChange={(value) => set({ maxChildren: String(Math.min(value, total)) })}
            />
          </div>
          <p className="mt-1.5 text-[13px] text-gray-500">
            Total occupancy controls the room card. Adult and child limits refine availability.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 min-[720px]:grid-cols-2">
          <Stepper
            label="Private bathrooms"
            noun="bathrooms"
            min={0}
            value={privateBathrooms}
            onChange={(value) => onChange(withPrivateBathrooms(room, value))}
          />
          <div>
            <label htmlFor="setup-room-category" className={SETUP_LABEL}>
              Room category <span className="font-normal text-gray-500">· shown as a tag</span>
            </label>
            <select
              id="setup-room-category"
              value={room.category}
              onChange={(event) => set({ category: event.target.value })}
              className={SETUP_INPUT}
            >
              <option value="">Select category</option>
              {ROOM_CATEGORIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
