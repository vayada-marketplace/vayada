"use client";

import { useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { mostRooms as mostRoomsFor, moveAdult, type RoomGuests } from "@/lib/roomPicker";

interface GuestSelectorProps {
  open: boolean;
  onClose: () => void;
  adults: number;
  childCount: number;
  onUpdate: (adults: number, children: number) => void;
  adultAgeThreshold?: number;
  childrenEnabled?: boolean;
  /** VAY-2320: the group's rooms. It starts at the fewest the group needs and can't go below.
   * VAY-2393: with two or more, "Who sleeps where" sets each room's adults (`split`). */
  rooms?: {
    count: number;
    fewest: number;
    onChange: (count: number) => void;
    split: RoomGuests[];
    onSplit: (adultsPerRoom: number[]) => void;
  };
}

function Stepper({
  label,
  hint,
  value,
  display,
  min,
  max,
  labels,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  /** Words in place of the number ("2 adults"). */
  display?: string;
  min: number;
  max: number;
  /** The buttons' names when "Fewer {label}" doesn't read well. */
  labels?: { fewer: string; more: string };
  onChange: (value: number) => void;
}) {
  const t = useTranslations("guestPicker");
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-sm font-semibold text-gray-900">{label}</p>
        {hint && <p className="text-xs text-gray-500">{hint}</p>}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <button
          type="button"
          aria-label={labels?.fewer ?? t("fewer", { label })}
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          className="w-9 h-9 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <span className="text-lg leading-none">-</span>
        </button>
        <span
          className={`text-center font-semibold text-gray-900 ${display ? "min-w-[4.5rem] text-sm" : "w-6"}`}
        >
          {display ?? value}
        </span>
        <button
          type="button"
          aria-label={labels?.more ?? t("more", { label })}
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          className="w-9 h-9 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <span className="text-lg leading-none">+</span>
        </button>
      </div>
    </div>
  );
}

export default function GuestSelector({
  open,
  onClose,
  adults,
  childCount,
  onUpdate,
  adultAgeThreshold = 18,
  childrenEnabled = true,
  rooms,
}: GuestSelectorProps) {
  const t = useTranslations("guestPicker");
  const ref = useRef<HTMLDivElement>(null);
  const childMaxAge = Math.max(0, adultAgeThreshold - 1);
  // Every room needs an adult, so the group never takes more rooms than adults.
  const mostRooms = mostRoomsFor(adults, rooms?.fewest ?? 1);
  const fewestRooms = Math.min(rooms?.fewest ?? 1, mostRooms);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);
  // VAY-2393: opened from a room card ("change who sleeps where") too, so focus moves in and
  // Escape closes it.
  useEffect(() => {
    if (open) ref.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby="guest-selector-title"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      data-testid="guest-selector"
      className="absolute right-0 top-full mt-3 bg-white rounded-2xl shadow-2xl border border-gray-100 p-5 z-50 w-80 max-w-[calc(100vw-2rem)] outline-none"
    >
      <h3 id="guest-selector-title" className="text-base font-bold text-gray-900 mb-4">
        {t("title")}
      </h3>

      <div className="space-y-4">
        <Stepper
          label={t("adults")}
          hint={t("adultAges", { age: adultAgeThreshold })}
          value={adults}
          min={1}
          max={10}
          onChange={(value) => onUpdate(value, childCount)}
        />
        {childrenEnabled && (
          <Stepper
            label={t("children")}
            hint={t("childAges", { age: childMaxAge })}
            value={childCount}
            min={0}
            max={6}
            onChange={(value) => onUpdate(adults, value)}
          />
        )}
        {rooms && (
          <>
            <Stepper
              label={t("rooms")}
              hint={
                fewestRooms > 1
                  ? t("roomsNeeded", { guests: adults + childCount, count: fewestRooms })
                  : t("roomsHint")
              }
              value={rooms.count}
              min={fewestRooms}
              max={mostRooms}
              onChange={rooms.onChange}
            />
            {rooms.count > 1 && rooms.split.length === rooms.count && (
              <section
                aria-labelledby="who-sleeps-where"
                data-testid="who-sleeps-where"
                className="space-y-3 rounded-xl bg-gray-50 p-3"
              >
                <h4 id="who-sleeps-where" className="text-sm font-semibold text-gray-900">
                  {t("whoSleepsWhere")}
                </h4>
                {rooms.split.map((room, index) => (
                  <Stepper
                    key={index}
                    label={t("roomNumber", { number: index + 1 })}
                    display={t("roomGuests", { adults: room.adults, children: room.children })}
                    value={room.adults}
                    min={1}
                    max={adults - (rooms.count - 1)}
                    labels={{
                      fewer: t("fewerAdultsIn", { number: index + 1 }),
                      more: t("moreAdultsIn", { number: index + 1 }),
                    }}
                    onChange={(value) =>
                      rooms.onSplit(
                        moveAdult(
                          rooms.split.map((r) => r.adults),
                          index,
                          value > room.adults ? 1 : -1,
                        ),
                      )
                    }
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>

      <button
        type="button"
        onClick={onClose}
        className="w-full mt-5 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm"
      >
        {t("done")}
      </button>
    </div>
  );
}
