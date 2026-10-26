"use client";

import { useRef, useEffect } from "react";
import { useTranslations } from "next-intl";

interface GuestSelectorProps {
  open: boolean;
  onClose: () => void;
  adults: number;
  childCount: number;
  onUpdate: (adults: number, children: number) => void;
  adultAgeThreshold?: number;
  childrenEnabled?: boolean;
  /** VAY-2320: the group's rooms. It starts at the fewest the group needs and can't go below. */
  rooms?: { count: number; fewest: number; onChange: (count: number) => void };
}

function Stepper({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const t = useTranslations("guestPicker");
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-sm font-semibold text-gray-900">{label}</p>
        <p className="text-xs text-gray-500">{hint}</p>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <button
          type="button"
          aria-label={t("fewer", { label })}
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          className="w-9 h-9 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <span className="text-lg leading-none">-</span>
        </button>
        <span className="w-6 text-center font-semibold text-gray-900">{value}</span>
        <button
          type="button"
          aria-label={t("more", { label })}
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
  const mostRooms = Math.min(9, adults);
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

  if (!open) return null;

  return (
    <div
      ref={ref}
      data-testid="guest-selector"
      className="absolute right-0 top-full mt-3 bg-white rounded-2xl shadow-2xl border border-gray-100 p-5 z-50 w-80 max-w-[calc(100vw-2rem)]"
    >
      <h3 className="text-base font-bold text-gray-900 mb-4">{t("title")}</h3>

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
            {rooms.count > 1 && (
              <p className="rounded-xl bg-primary-50 px-3 py-2.5 text-xs text-gray-700">
                {t("splitNote")}
              </p>
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
