"use client";

import { useTranslations } from "next-intl";
import type { RoomGuests } from "@/lib/roomPicker";

export type RoomsBarSlot = {
  guests: RoomGuests;
  /** The chosen room: its type's name and "rate · price"; null while not chosen yet. */
  chosen: { roomName: string; detail: string } | null;
};

/** VAY-2320: the group's rooms while it chooses them one by one: each room's guests and choice,
 * the total so far and Continue. Sticky above the room cards on wide screens, pinned to the
 * bottom of the screen on phones. */
export default function RoomsBar({
  slots,
  active,
  total,
  summary,
  onChange,
  onContinue,
}: {
  slots: RoomsBarSlot[];
  /** The room being chosen (index), or null when every room is chosen. */
  active: number | null;
  /** The chosen rooms' total, formatted; null before the first room is chosen. */
  total: string | null;
  /** "3 Adults, 1 Child · 10–12 Nov". */
  summary: string;
  onChange: (index: number) => void;
  onContinue: () => void;
}) {
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const missing = slots.filter((slot) => !slot.chosen).length;
  const guests = (g: RoomGuests) =>
    [
      tc("adults", { count: g.adults }),
      ...(g.children ? [tc("children", { count: g.children })] : []),
    ].join(", ");
  const totalNote = missing ? t("totalSoFar") : t("totalForRooms", { count: slots.length });
  const cta = (
    <button
      type="button"
      onClick={onContinue}
      disabled={missing > 0}
      className="px-6 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary-600"
    >
      {tc("continue")}
    </button>
  );
  const check = (
    <span className="w-5 h-5 rounded-full bg-success-500 flex items-center justify-center flex-shrink-0">
      <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
      </svg>
    </span>
  );
  const slotClass = (index: number) =>
    slots[index]!.chosen
      ? "border border-gray-200 bg-white"
      : index === active
        ? "border-2 border-primary-600 bg-primary-50"
        : "border border-dashed border-gray-300 bg-gray-50";

  return (
    <>
      {/* Wide screens: above the room cards, staying in view while the guest scrolls. */}
      <section
        aria-label={t("yourRooms", { count: slots.length })}
        data-testid="rooms-bar"
        className="hidden md:flex sticky top-36 z-20 mb-6 items-center gap-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-lg"
      >
        <div className="w-40 flex-shrink-0">
          <p className="font-bold text-gray-900">{t("yourRooms", { count: slots.length })}</p>
          <p className="text-xs text-gray-500">{summary}</p>
        </div>
        <div className="flex flex-1 min-w-0 gap-3">
          {slots.map((slot, index) => (
            <div
              key={index}
              data-testid={`rooms-bar-slot-${index + 1}`}
              className={`flex flex-1 min-w-0 items-start gap-2 rounded-xl px-3 py-2.5 ${slotClass(index)}`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-500 truncate">
                  <span className="font-bold text-gray-900">
                    {t("roomNumber", { number: index + 1 })}
                  </span>{" "}
                  · {guests(slot.guests)}
                </p>
                {slot.chosen ? (
                  <>
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {slot.chosen.roomName}
                    </p>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-gray-600 truncate">{slot.chosen.detail}</p>
                      <button
                        type="button"
                        onClick={() => onChange(index)}
                        className="text-xs font-semibold text-primary-600 hover:underline flex-shrink-0"
                      >
                        {t("changeRoom")}
                      </button>
                    </div>
                  </>
                ) : (
                  <p
                    className={`text-sm font-semibold ${index === active ? "text-primary-600" : "text-gray-400"}`}
                  >
                    {index === active ? `↓ ${t("chooseBelow")}` : t("nextRoom")}
                  </p>
                )}
              </div>
              {slot.chosen && check}
            </div>
          ))}
        </div>
        <div className="flex-shrink-0 text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            {tc("total")}
          </p>
          <p className="text-xl font-bold text-gray-900">{total ?? "—"}</p>
          <p className="text-xs text-gray-500">{totalNote}</p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          {cta}
          {missing > 0 && (
            <p className="text-xs text-gray-500">{t("chooseMoreRooms", { count: missing })}</p>
          )}
        </div>
      </section>

      {/* Phones: pinned to the bottom of the screen. */}
      <section
        aria-label={t("yourRooms", { count: slots.length })}
        data-testid="rooms-bar-mobile"
        className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white px-4 pt-3 pb-5 shadow-[0_-8px_24px_rgba(17,24,39,0.10)]"
      >
        <div className="flex gap-2 overflow-x-auto">
          {slots.map((slot, index) => (
            <button
              key={index}
              type="button"
              onClick={() => slot.chosen && onChange(index)}
              className={`flex min-w-0 flex-1 basis-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left ${slotClass(index)}`}
            >
              {slot.chosen && check}
              <span className="min-w-0">
                <span className="block text-[11px] text-gray-500 truncate">
                  {t("roomNumber", { number: index + 1 })}
                </span>
                <span
                  className={`block text-sm font-semibold truncate ${slot.chosen ? "text-gray-900" : index === active ? "text-primary-600" : "text-gray-400"}`}
                >
                  {slot.chosen
                    ? slot.chosen.roomName
                    : index === active
                      ? t("chooseBelow")
                      : t("nextRoom")}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              {tc("total")} <span className="font-normal normal-case">{totalNote}</span>
            </p>
            <p className="text-lg font-bold text-gray-900">{total ?? "—"}</p>
          </div>
          {cta}
        </div>
      </section>
    </>
  );
}
