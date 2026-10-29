"use client";

import type { KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import type { RoomGuests } from "@/lib/roomPicker";

export type RoomsProgressRoom =
  /** Chosen, and its guests fit: the room type's name. */
  | { state: "done"; name: string }
  /** Chosen, but the split now gives it more guests than it sleeps. */
  | { state: "too_small"; name: string }
  | { state: "open" };

/** Arrows, Home and End move between the tabs; Enter or Space opens the room, since opening one
 * scrolls the page. */
const MOVES: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

function moveFocus(event: KeyboardEvent<HTMLButtonElement>) {
  const tabs = [
    ...(event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
  ];
  const move = MOVES[event.key];
  if (!move) return;
  event.preventDefault();
  tabs[move(tabs.indexOf(event.currentTarget), tabs.length)]?.focus();
}

/** VAY-2412: a tab per room while a group chooses room by room, next to the sort. A tab opens its
 * room again; its × removes the room from the booking (VAY-2393). */
export default function RoomTabs({
  rooms,
  current,
  guests,
  onOpen,
  onRemove,
}: {
  rooms: RoomsProgressRoom[];
  /** The room being chosen (index), or null while every room is chosen. */
  current: number | null;
  /** Each room's guests. */
  guests: RoomGuests[];
  onOpen: (index: number) => void;
  /** `byKeyboard`: the × was pressed from the keyboard. */
  onRemove: (index: number, byKeyboard: boolean) => void;
}) {
  const t = useTranslations("home.roomsProgress");
  return (
    <div
      role="tablist"
      aria-label={t("yourRooms")}
      data-testid="room-tabs"
      // On the row's bottom border, with the active tab's underline over it.
      className="relative -mb-px flex overflow-x-auto"
    >
      {rooms.map((room, index) => {
        const number = index + 1;
        const active = index === current;
        const status = active
          ? room.state === "open"
            ? t("choosing")
            : t("changing")
          : room.state === "done"
            ? room.name
            : room.state === "too_small"
              ? t("tooSmall", { name: room.name })
              : t("next");
        return (
          <div
            key={index}
            className={`flex shrink-0 items-center border-b-[3px] ${
              active ? "border-gray-900" : "border-transparent"
            }`}
          >
            <button
              type="button"
              role="tab"
              data-testid={`room-tab-${number}`}
              aria-selected={active}
              tabIndex={index === (current ?? 0) ? 0 : -1}
              onClick={() => onOpen(index)}
              onKeyDown={moveFocus}
              // The outline inside the button: the scrolling tab list would clip it.
              className="flex min-h-[52px] items-center gap-2.5 px-1 py-2 text-left focus-visible:outline-offset-[-2px]"
            >
              <span
                aria-hidden="true"
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  active
                    ? "bg-gray-900 text-white"
                    : room.state === "done"
                      ? "bg-success-600 text-white"
                      : room.state === "too_small"
                        ? "border border-red-700 text-red-700"
                        : "border border-dashed border-gray-400 text-gray-500"
                }`}
              >
                {!active && room.state === "done" ? "✓" : number}
              </span>
              <span className="flex min-w-0 flex-col">
                <span
                  className={`text-sm font-bold ${
                    active || room.state !== "open" ? "text-gray-900" : "text-gray-500"
                  }`}
                >
                  {t("room", { number })}
                </span>
                <span
                  className={`max-w-[14rem] truncate text-xs ${
                    !active && room.state === "too_small" ? "text-red-700" : "text-gray-500"
                  }`}
                >
                  {`${t("guests", guests[index]!)} · ${status}`}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={t("remove", { number })}
              title={t("remove", { number })}
              onClick={(event) => onRemove(index, event.detail === 0)}
              className="mr-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700"
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
          </div>
        );
      })}
    </div>
  );
}

/** Below the tabs: what to pick and how it's priced; with every room chosen (Back from the next
 * step), it says so and offers to go on. Focused after each pick, so keyboard and screen-reader
 * users follow the next room. */
export function RoomsHelp({
  count,
  current,
  guests,
  hasExtras,
  onContinue,
}: {
  count: number;
  current: number | null;
  /** The current room's guests. */
  guests: RoomGuests;
  /** The hotel's next step is Extras, not the guest's details. */
  hasExtras: boolean;
  onContinue: () => void;
}) {
  const t = useTranslations("home.roomsProgress");
  return (
    <div data-testid="rooms-help" className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
      <p id="rooms-progress-title" tabIndex={-1} className="text-sm text-gray-600 outline-none">
        {current === null ? (
          <>
            <strong className="text-gray-900">{t("allChosen", { count })}</strong>
            {` · ${t(hasExtras ? "readyForExtras" : "readyForDetails")}`}
          </>
        ) : (
          t("pickHelp", guests)
        )}
      </p>
      {current === null && (
        <button
          type="button"
          onClick={onContinue}
          className="min-h-[44px] rounded-full bg-primary-600 px-5 text-sm font-semibold text-white hover:bg-primary-700"
        >
          {t(hasExtras ? "continueToExtras" : "continueToDetails")}
        </button>
      )}
    </div>
  );
}
