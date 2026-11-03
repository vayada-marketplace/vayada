"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { trapFocus } from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";

/** Where the clicked night, stay or bar is on screen (viewport pixels). */
export type PopoverAnchor = { left: number; right: number; top: number; bottom: number };

const WIDTH = 320;
const GAP = 8;
const EDGE = 8;

/** The calendar's popover card (VAY-2411): under what was clicked when it fits, above it otherwise, and never over it,
 * so the next night can still be clicked; with room on neither side it scrolls on the roomier one. Without an anchor
 * (the phone calendar, VAY-2470) the same content opens as a sheet from the bottom of the screen. Escape, the close
 * button and a click anywhere else close it. */
export default function CalendarPopover({
  anchor,
  label,
  eyebrow,
  title,
  badge,
  onClose,
  children,
}: {
  /** What was clicked; none opens a bottom sheet. */
  anchor?: PopoverAnchor;
  /** The dialog's accessible name. */
  label: string;
  eyebrow: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(
    null,
  );

  // Measured after every render, since the card's height follows its content.
  useLayoutEffect(() => {
    if (!anchor) return;
    const height = ref.current?.scrollHeight ?? 0;
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - WIDTH - EDGE));
    const below = anchor.bottom + GAP;
    const roomBelow = window.innerHeight - EDGE - below;
    const roomAbove = anchor.top - GAP - EDGE;
    const next =
      height <= roomBelow || roomBelow >= roomAbove
        ? { left, top: below, maxHeight: roomBelow }
        : { left, top: Math.max(EDGE, anchor.top - GAP - height), maxHeight: roomAbove };
    setPosition((current) =>
      current?.left === next.left &&
      current.top === next.top &&
      current.maxHeight === next.maxHeight
        ? current
        : next,
    );
  });

  const anchored = anchor !== undefined;
  // Focus moves into the card, so a keyboard or screen reader user lands on what opened; a sheet hands it back.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (!anchored) previous?.focus({ preventScroll: true });
    };
  }, [anchored]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    // A sheet closes from its backdrop's click instead: closing on the press would let the tap's click land on the
    // room below and open another sheet.
    if (anchored) document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose, anchored]);

  const content = (
    <>
      <div
        className={`px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-start gap-2 ${anchor ? "" : "sticky top-0 z-10"}`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide truncate">
            {eyebrow}
          </div>
          <div className="text-sm font-semibold text-gray-900 mt-0.5">{title}</div>
        </div>
        {badge}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("calendar.popover.close")}
          className="-mr-1 p-1 rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-700"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
      {children}
    </>
  );

  if (!anchor)
    return (
      <div className="fixed inset-0 z-50">
        {/* Its own click: iOS Safari sends no mouse events to an element without one. */}
        <div aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={(event) => event.key === "Tab" && trapFocus(event, ref.current, onClose)}
          className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto overflow-x-hidden rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-xl focus:outline-none"
        >
          {content}
        </div>
      </div>
    );

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className="fixed z-50 bg-white border border-gray-200 shadow-xl rounded-xl overflow-y-auto focus:outline-none"
      style={{
        left: position?.left ?? anchor.left,
        top: position?.top ?? anchor.bottom + GAP,
        width: WIDTH,
        maxHeight: position?.maxHeight,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {content}
    </div>
  );
}

/** A small rounded status pill for the popover header: "Available", "Confirmed", "Blocked". */
export function PopoverBadge({
  tone,
  children,
}: {
  tone: "green" | "blue" | "gray" | "red";
  children: ReactNode;
}) {
  const tones = {
    green: "bg-green-50 text-green-700",
    blue: "bg-primary-50 text-primary-700",
    gray: "bg-gray-100 text-gray-700",
    red: "bg-red-50 text-red-700",
  };
  return (
    <span
      className={`shrink-0 mt-0.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** A popover action row: an icon tile and a label, like the calendar's "New Booking" and "Block Room". */
export function PopoverAction({
  tone,
  icon,
  label,
  onClick,
}: {
  tone: "primary" | "red";
  icon: string;
  label: string;
  onClick: () => void;
}) {
  const colours =
    tone === "primary"
      ? {
          row: "hover:bg-primary-50 hover:text-primary-700",
          tile: "bg-primary-50 text-primary-600",
        }
      : { row: "hover:bg-red-50 hover:text-red-700", tile: "bg-red-50 text-red-500" };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-sm text-left text-gray-700 rounded-md transition-colors ${colours.row}`}
    >
      <span className={`w-7 h-7 flex items-center justify-center rounded-md ${colours.tile}`}>
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
        </svg>
      </span>
      <span className="font-medium">{label}</span>
    </button>
  );
}

export const PLUS_ICON = "M12 4v16m8-8H4";
export const BLOCK_ICON =
  "M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636";
