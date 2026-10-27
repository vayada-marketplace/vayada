"use client";

import { useState } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import type { RoomOption } from "@/lib/checkin/rooms";
import { stayRangeLabel } from "@/lib/checkin/labels";
import { useTranslation } from "@/lib/i18n";
import { checkinPrimaryButton, checkinSecondaryButton } from "./CheckinStepCard";

/** Change room: free rooms of any type for this room's dates; the booked rate stays (VAY-2373 D7).
 * Laptop: under the room; phone: its own screen. */
export function RoomPicker({
  title,
  rateNote,
  groups,
  loading,
  error,
  moving,
  onMove,
  onCancel,
}: {
  title: string;
  rateNote: string;
  groups: Array<{ roomTypeId: string; roomTypeName: string; options: RoomOption[] }> | null;
  loading: boolean;
  error: string | null;
  moving: boolean;
  onMove: (option: RoomOption) => void;
  onCancel: () => void;
}) {
  const { locale, t } = useTranslation();
  const [picked, setPicked] = useState<RoomOption | null>(null);
  const stateLabel = (option: RoomOption) =>
    option.state === "occupied" || option.state === "blocked"
      ? t(`checkIn.flow.picker.${option.state}`, {
          dates: stayRangeLabel(locale, option.from!, option.to!),
        })
      : t(`checkIn.flow.picker.${option.state}`);

  return (
    <div
      role="group"
      aria-label={title}
      className="fixed inset-0 z-40 flex flex-col overflow-y-auto bg-white md:static md:z-auto md:overflow-visible md:rounded-2xl md:border md:border-gray-200 md:bg-gray-50"
    >
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 md:hidden">
        <button
          type="button"
          onClick={onCancel}
          aria-label={t("common.cancel")}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-900"
        >
          <ArrowLeftIcon className="h-5 w-5" aria-hidden="true" />
        </button>
        <p className="text-lg font-bold text-gray-900">{t("checkIn.flow.rooms.change")}</p>
      </div>

      <div className="flex flex-col gap-4 px-4 py-5 md:px-5">
        <div>
          <p className="text-lg font-bold text-gray-900">{title}</p>
          <p className="mt-1 text-[15px] text-gray-600">{rateNote}</p>
        </div>
        {loading && <p className="text-sm text-gray-600">{t("common.loading")}</p>}
        {error && (
          <p role="alert" className="text-sm font-medium text-red-700">
            {error}
          </p>
        )}
        {groups?.map((group) => (
          <fieldset key={group.roomTypeId} className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold text-gray-700">
              {group.roomTypeName}
            </legend>
            {group.options.map((option) => {
              const free = option.state === "free";
              const on = picked?.roomId === option.roomId;
              return (
                <label
                  key={option.roomId}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 ${
                    on
                      ? "bg-primary-50 shadow-[inset_0_0_0_2px] shadow-primary-600"
                      : "border border-gray-200 bg-white"
                  } ${free ? "cursor-pointer" : "opacity-50"}`}
                >
                  <input
                    type="radio"
                    name="checkin-room-move"
                    checked={on}
                    disabled={!free}
                    onChange={() => setPicked(option)}
                    className="h-5 w-5 border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span className="flex-1 text-[15px] font-bold text-gray-900">
                    {t("dashboard.popup.roomNumber", { number: option.roomNumber })}
                  </span>
                  <span
                    className={`text-sm ${
                      option.state === "free"
                        ? "font-semibold text-green-700"
                        : option.state === "current"
                          ? "font-semibold text-primary-800"
                          : "text-gray-600"
                    }`}
                  >
                    {stateLabel(option)}
                  </span>
                </label>
              );
            })}
          </fieldset>
        ))}
      </div>

      <div className="sticky bottom-0 mt-auto border-t border-gray-200 bg-white px-4 py-4 md:static md:border-0 md:bg-transparent md:px-5 md:pb-5 md:pt-0">
        <p className="mb-3 text-center text-sm text-gray-600 md:hidden">
          {t("checkIn.flow.picker.rateKept")}
        </p>
        <div className="grid grid-cols-2 gap-3 md:flex">
          <button type="button" onClick={onCancel} className={checkinSecondaryButton}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!picked || moving}
            onClick={() => picked && onMove(picked)}
            className={checkinPrimaryButton}
          >
            {moving
              ? t("common.saving")
              : picked
                ? t("checkIn.flow.picker.moveTo", { room: picked.roomNumber })
                : t("checkIn.flow.picker.pick")}
          </button>
        </div>
      </div>
    </div>
  );
}
