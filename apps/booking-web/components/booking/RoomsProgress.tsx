"use client";

import { useTranslations } from "next-intl";
import type { RoomGuests } from "@/lib/roomPicker";

export type RoomsProgressRoom =
  /** Chosen, and its guests fit: the room type's name. */
  | { state: "done"; name: string }
  /** Chosen, but the split now gives it more guests than it sleeps. */
  | { state: "too_small"; name: string }
  | { state: "open" };

/** VAY-2393: one compact line above the room cards while a group chooses room by room: which
 * room is being chosen and for whom, and a pill per room. A pill opens its room again. */
export default function RoomsProgress({
  rooms,
  current,
  guests,
  onOpen,
}: {
  rooms: RoomsProgressRoom[];
  /** The room being chosen (index). */
  current: number;
  /** The current room's guests. */
  guests: RoomGuests;
  onOpen: (index: number) => void;
}) {
  const t = useTranslations("home.roomsProgress");
  return (
    <div
      data-testid="rooms-progress"
      className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between"
    >
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-wider text-gray-600">
          {t("roomOf", { number: current + 1, count: rooms.length })}
        </p>
        <h3 className="mt-1 text-xl font-bold text-gray-900 md:text-2xl">{t("pickFor", guests)}</h3>
      </div>
      <ul className="flex flex-wrap gap-2 md:justify-end" aria-label={t("yourRooms")}>
        {rooms.map((room, index) => {
          const number = index + 1;
          const status =
            index === current
              ? t("choosingNow")
              : room.state === "done"
                ? `✓ ${room.name}`
                : room.state === "too_small"
                  ? t("tooSmall", { name: room.name })
                  : t("next");
          return (
            <li key={index} className="min-w-0 max-w-full">
              <button
                type="button"
                data-testid={`room-pill-${number}`}
                aria-current={index === current ? "step" : undefined}
                onClick={() => onOpen(index)}
                className={`flex min-h-[44px] max-w-full items-center gap-2 rounded-full border px-4 text-sm transition-colors ${
                  index === current
                    ? "border-primary-600 bg-primary-600 text-white"
                    : room.state === "done"
                      ? "border-success-200 bg-success-50 text-success-800 hover:border-success-500"
                      : room.state === "too_small"
                        ? "border-red-200 bg-red-50 text-red-700 hover:border-red-400"
                        : "border-dashed border-gray-400 bg-white text-gray-700 hover:border-gray-600"
                }`}
              >
                <span className="shrink-0 font-bold">{t("room", { number })}</span>
                <span className="min-w-0 truncate">{status}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
