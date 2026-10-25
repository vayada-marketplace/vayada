"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import {
  ArrowDownTrayIcon,
  Bars3Icon,
  ChevronUpDownIcon,
  LinkIcon,
} from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";

const item =
  "flex w-full items-start gap-3 px-4 py-2 text-left hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none";
const heading = "px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-gray-500";

/** Rooms & Rates' ☰ menu (VAY-2338): what hosts set up once, out of the way of the room list. It closes on a click
 * outside or Escape, which returns the focus to the ☰ button. */
export default function RoomsMenu({
  buttonRef,
  airbnbHref,
  canReorder,
  onLinkedInventory,
}: {
  buttonRef: RefObject<HTMLButtonElement>;
  /** Booking Admin's Airbnb import, when it is on. */
  airbnbHref: string | null;
  /** The calendar's reorder mode needs two rooms. */
  canReorder: boolean;
  onLinkedInventory: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, buttonRef]);

  return (
    <div
      ref={menu}
      className="relative"
      onBlur={(event) => {
        if (!menu.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={t("rooms.menu.label")}
        aria-expanded={open}
        aria-controls="rooms-menu"
        className={`flex h-10 w-10 items-center justify-center rounded-lg border text-gray-700 transition-colors ${open ? "border-gray-300 bg-gray-100" : "border-gray-200 bg-white hover:bg-gray-50"}`}
      >
        <Bars3Icon className="h-5 w-5" />
      </button>
      {open && (
        <div
          id="rooms-menu"
          className="absolute right-0 top-12 z-30 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white py-1.5 shadow-lg"
        >
          {airbnbHref && (
            <>
              <p className={heading}>{t("rooms.menu.import")}</p>
              <a
                href={airbnbHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className={item}
              >
                <ArrowDownTrayIcon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-gray-600" />
                <span>
                  <span className="block text-sm font-medium text-gray-900">
                    {t("rooms.menu.importAirbnb")}
                  </span>
                  <span className="block text-xs text-gray-500">{t("rooms.menu.newTab")}</span>
                </span>
              </a>
              <div className="my-1.5 h-px bg-gray-200" />
            </>
          )}
          <p className={heading}>{t("rooms.menu.inventory")}</p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onLinkedInventory();
            }}
            className={item}
          >
            <LinkIcon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-gray-600" />
            <span className="text-sm font-medium text-gray-900">{t("rooms.linkedInventory")}</span>
          </button>
          {/* The calendar reorders rooms on wider screens only. */}
          {canReorder && (
            <Link href="/calendar?reorder=1" className={`${item} hidden md:flex`}>
              <ChevronUpDownIcon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-gray-600" />
              <span>
                <span className="block text-sm font-medium text-gray-900">
                  {t("rooms.menu.reorder")}
                </span>
                <span className="block text-xs text-gray-500">{t("rooms.menu.reorderHint")}</span>
              </span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
