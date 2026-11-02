"use client";

import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useState } from "react";

import type { RoomAuthoringDraft } from "../adaptive/rooms/roomAuthoringState";
import { SetupStepHeading } from "./SetupStepHeading";

/**
 * The server's room amenities (pmsRoomAmenityVocabulary.ts, PMS_ROOM_AMENITY_KEYS_V1), in the mockup's eight
 * groups. Only these can be saved, so there is no custom amenity (Flamur, 2026-11-02).
 */
export const SETUP_AMENITY_GROUPS: ReadonlyArray<{
  name: string;
  items: ReadonlyArray<readonly [string, string]>;
}> = [
  {
    name: "Internet & Tech",
    items: [
      ["wifi", "Free WiFi"],
      ["flat_screen_tv", "Flat-screen TV"],
      ["smart_tv", "Smart TV"],
      ["tv", "TV"],
      ["streaming_services", "Netflix / Streaming"],
      ["work_desk", "Work desk"],
      ["laptop_friendly_workspace", "Laptop-friendly workspace"],
    ],
  },
  {
    name: "Kitchen",
    items: [
      ["kitchen", "Kitchen"],
      ["kitchenware", "Kitchenware"],
      ["refrigerator", "Refrigerator"],
      ["microwave", "Microwave"],
      ["electric_kettle", "Electric kettle"],
      ["stovetop", "Stovetop"],
      ["minibar", "Minibar"],
      ["dining_table", "Dining table"],
    ],
  },
  {
    name: "Bathroom",
    items: [
      ["shower", "Shower"],
      ["bathtub", "Bathtub"],
      ["hot_tub", "Hot tub"],
      ["hairdryer", "Hairdryer"],
      ["free_toiletries", "Free toiletries"],
      ["towels", "Towels"],
      ["toilet", "Toilet"],
      ["toilet_paper", "Toilet paper"],
      ["bathrobe", "Bathrobe"],
      ["slippers", "Slippers"],
    ],
  },
  {
    name: "Climate & Comfort",
    items: [
      ["air_conditioning", "Air conditioning"],
      ["fan", "Fan"],
      ["heating", "Heating"],
      ["fireplace", "Fireplace"],
    ],
  },
  {
    name: "Bedroom",
    items: [
      ["bed_linen", "Bed linen"],
      ["wardrobe", "Wardrobe"],
      ["extra_pillows", "Extra pillows"],
      ["blackout_curtains", "Blackout curtains"],
      ["balcony", "Balcony"],
    ],
  },
  {
    name: "Laundry",
    items: [
      ["washing_machine", "Washing machine"],
      ["dryer", "Dryer"],
      ["iron_and_ironing_board", "Iron and ironing board"],
      ["clothes_rack", "Clothes rack"],
    ],
  },
  {
    name: "Safety & Access",
    items: [
      ["in_room_safe", "In-room safe"],
      ["smoke_detector", "Smoke detector"],
      ["first_aid_kit", "First aid kit"],
      ["fire_extinguisher", "Fire extinguisher"],
    ],
  },
  { name: "Services", items: [["non_smoking", "Non-smoking"]] },
];

/** VAY-2451 step 3c, "Amenities": the groups collapsed (so the screen fits), each with its count. */
export function SetupRoomAmenities({
  room,
  onChange,
}: {
  room: RoomAuthoringDraft;
  onChange: (room: RoomAuthoringDraft) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const selected = new Set(room.amenityKeys);
  const set = (keys: Iterable<string>) =>
    onChange({
      ...room,
      amenityKeys: Array.from(new Set(keys)).sort(),
      reviewedEmptyAmenities: true,
    });
  return (
    <div>
      <SetupStepHeading
        title="Amenities"
        subtitle="What's included in this room. Guests see the full list under View details."
      />
      <p className="mt-6 text-sm font-semibold text-primary-700">{`${selected.size} selected`}</p>
      <div className="mt-2 divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white">
        {SETUP_AMENITY_GROUPS.map((group) => {
          const count = group.items.filter(([key]) => selected.has(key)).length;
          const expanded = open === group.name;
          const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
          return (
            <div key={group.name}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : group.name)}
                className="flex h-12 w-full items-center gap-3 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600"
              >
                <Chevron className="h-4 w-4 shrink-0 stroke-2 text-gray-500" aria-hidden="true" />
                <span className="flex-1 text-[15px] font-semibold text-gray-950">{group.name}</span>
                <span
                  className={`text-[13px] ${count ? "font-semibold text-primary-700" : "text-gray-500"}`}
                >
                  {`${count} selected`}
                </span>
              </button>
              {expanded ? (
                <div className="px-4 pb-4">
                  <button
                    type="button"
                    onClick={() =>
                      set(Array.from(selected).concat(group.items.map(([key]) => key)))
                    }
                    className="rounded text-[13px] font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
                  >
                    Select all
                  </button>
                  <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 min-[720px]:grid-cols-2">
                    {group.items.map(([key, label]) => {
                      const on = selected.has(key);
                      return (
                        <button
                          key={key}
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          onClick={() =>
                            set(
                              on
                                ? Array.from(selected).filter((other) => other !== key)
                                : Array.from(selected).concat(key),
                            )
                          }
                          className="flex h-9 items-center gap-2.5 rounded text-left text-sm text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
                        >
                          <span
                            aria-hidden="true"
                            className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded ${
                              on ? "bg-primary-600" : "border-[1.5px] border-gray-400 bg-white"
                            }`}
                          >
                            {on ? <CheckIcon className="h-3 w-3 stroke-[3] text-white" /> : null}
                          </span>
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
