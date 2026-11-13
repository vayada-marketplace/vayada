"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import type { RoomSortKey } from "@/lib/roomSorting";

/**
 * The phone's sort (VAY-2494): the hotel's sort options (VAY-2449) in a sheet from the bottom of
 * the screen over the dimmed page. A tap on an option sorts the rooms and closes it; Escape, the
 * close button or a tap on the dimmed page close it as it was. The page behind is out of reach
 * while it is open, and the focus goes back to the button that opened it.
 */
export default function RoomSortSheet({
  options,
  value,
  label,
  onPick,
  onClose,
}: {
  options: RoomSortKey[];
  value: RoomSortKey;
  label: (option: RoomSortKey) => string;
  onPick: (option: RoomSortKey) => void;
  onClose: () => void;
}) {
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const dialogRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  // A modal, as the agency's filter sheet (VAY-2463): the page stays put and out of reach, the
  // focus starts on the sheet and returns to the opener.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    const behind = Array.from(document.body.children).filter(
      (element) => element !== dialogRef.current && !element.hasAttribute("inert"),
    );
    behind.forEach((element) => element.setAttribute("inert", ""));
    sheetRef.current?.focus();
    return () => {
      root.style.overflow = overflow;
      behind.forEach((element) => element.removeAttribute("inert"));
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      ref={dialogRef}
      data-testid="room-sort-sheet"
      className="fixed inset-0 z-[90] bg-black/45"
      // On the tap's click, not as the finger goes down: the click must not reach the page below.
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-[22px] bg-white shadow-[0_-8px_28px_rgba(0,0,0,0.18)] focus:outline-none"
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <h2 id={titleId} className="text-[19px] font-bold text-gray-900">
            {t("sortBy")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={tc("close")}
            className="flex h-11 w-11 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-1">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === value}
              onClick={() => onPick(option)}
              className={`flex min-h-[48px] w-full items-center justify-between gap-3 rounded-xl px-3 text-left text-[15px] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                option === value ? "font-semibold text-gray-900" : "text-gray-700 hover:bg-gray-50"
              }`}
            >
              {label(option)}
              {option === value && (
                <svg
                  className="h-5 w-5 shrink-0 text-gray-900"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
