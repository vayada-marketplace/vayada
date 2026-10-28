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
 * room is being chosen and for whom, and a pill per room. A pill opens its room again; its ×
 * removes the room from the booking. With every room chosen (Back from the next step), it says
 * so and offers to go on. */
export default function RoomsProgress({
  rooms,
  current,
  guests,
  hasExtras,
  onOpen,
  onContinue,
  onRemove,
}: {
  rooms: RoomsProgressRoom[];
  /** The room being chosen (index), or null while every room is chosen. */
  current: number | null;
  /** The current room's guests. */
  guests: RoomGuests;
  /** The hotel's next step is Extras, not the guest's details. */
  hasExtras: boolean;
  onOpen: (index: number) => void;
  onContinue: () => void;
  /** `byKeyboard`: the × was pressed from the keyboard. */
  onRemove: (index: number, byKeyboard: boolean) => void;
}) {
  const t = useTranslations("home.roomsProgress");
  return (
    <div
      data-testid="rooms-progress"
      className="mb-4 flex flex-col gap-3 border-b border-gray-200 pb-4 md:flex-row md:items-end md:justify-between"
    >
      <div className="flex min-w-0 flex-col items-start gap-1">
        <p className="text-xs font-bold uppercase tracking-wider text-gray-600">
          {current === null
            ? t("allChosen", { count: rooms.length })
            : t("roomOf", { number: current + 1, count: rooms.length })}
        </p>
        {/* Focused after each pick, so keyboard and screen-reader users follow the next room. */}
        <h3
          id="rooms-progress-title"
          tabIndex={-1}
          className="text-xl font-bold text-gray-900 outline-none md:text-2xl"
        >
          {current === null
            ? t(hasExtras ? "readyForExtras" : "readyForDetails")
            : t("pickFor", guests)}
        </h3>
        {current === null && (
          <button
            type="button"
            onClick={onContinue}
            className="mt-1.5 min-h-[44px] rounded-full bg-primary-600 px-5 text-sm font-semibold text-white hover:bg-primary-700"
          >
            {t(hasExtras ? "continueToExtras" : "continueToDetails")}
          </button>
        )}
      </div>
      <ul className="flex flex-wrap gap-2 md:justify-end" aria-label={t("yourRooms")}>
        {rooms.map((room, index) => {
          const number = index + 1;
          const status =
            index === current
              ? room.state === "open"
                ? t("choosingNow")
                : t("changing")
              : room.state === "done"
                ? `✓ ${room.name}`
                : room.state === "too_small"
                  ? t("tooSmall", { name: room.name })
                  : t("next");
          return (
            <li
              key={index}
              className={`flex min-h-[44px] min-w-0 max-w-full items-center rounded-full border text-sm transition-colors ${
                index === current
                  ? "border-primary-600 bg-primary-600 text-white"
                  : room.state === "done"
                    ? "border-success-200 bg-success-50 text-success-800 hover:border-success-500"
                    : room.state === "too_small"
                      ? "border-red-700 bg-white text-red-700 hover:bg-red-50"
                      : "border-dashed border-gray-400 bg-white text-gray-700 hover:border-gray-600"
              }`}
            >
              <button
                type="button"
                data-testid={`room-pill-${number}`}
                aria-current={index === current ? "step" : undefined}
                onClick={() => onOpen(index)}
                className="flex min-h-[44px] min-w-0 items-center gap-2 rounded-l-full pl-4 pr-1"
              >
                <span className="shrink-0 font-bold">{t("room", { number })}</span>
                <span className="min-w-0 truncate">{status}</span>
              </button>
              <button
                type="button"
                aria-label={t("remove", { number })}
                title={t("remove", { number })}
                onClick={(event) => onRemove(index, event.detail === 0)}
                className="flex h-11 w-10 shrink-0 items-center justify-center rounded-r-full opacity-80 hover:opacity-100"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeWidth={2.4} d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
