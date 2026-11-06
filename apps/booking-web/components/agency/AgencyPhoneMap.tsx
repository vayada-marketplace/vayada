"use client";

import { useEffect, useRef, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import AgencyStayMap from "@/components/agency/AgencyStayMap";

/**
 * The phone's map of the agency's stays (VAY-2463, Timo's mobile prototype): the whole screen,
 * with what was searched on top, the stays' price pills, a tapped pill's card with View rooms,
 * and List to go back. Google loads once the guest asks (the Map button, or "Show map" when the
 * page opens on the map), as on a hotel's phone map (AccommodationsPhoneMap). A modal: the page
 * behind stays put and out of reach, and Escape (wherever the focus is) closes a stay's card
 * first, then the map.
 */
export default function AgencyPhoneMap({
  title,
  summary,
  onClose,
  ...map
}: Omit<ComponentProps<typeof AgencyStayMap>, "phone" | "compact" | "className"> & {
  /** "The Travel Ubud · 8 stays". */
  title: string;
  /** "16 – 18 Nov · 2 adults". */
  summary: string;
  onClose: () => void;
}) {
  const t = useTranslations("agency");
  const tm = useTranslations("locationMap");
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLButtonElement>(null);

  // A stay's card is on the map while its stay is picked, still listed and has a pin
  // (AgencyStayMap).
  const { onPick, picked, cards, stays } = map;
  const cardShown =
    picked !== null &&
    cards.some((card) => card.stay.propertyId === picked) &&
    stays.some((stay) => stay.propertyId === picked && stay.map);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (cardShown) onPick(null);
      else onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [cardShown, onPick, onClose]);

  useEffect(() => {
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    const behind = Array.from(document.body.children).filter(
      (element) => element !== dialogRef.current && !element.hasAttribute("inert"),
    );
    behind.forEach((element) => element.setAttribute("inert", ""));
    listRef.current?.focus();
    return () => {
      root.style.overflow = overflow;
      behind.forEach((element) => element.removeAttribute("inert"));
    };
  }, []);

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("phoneMapLabel")}
      data-testid="agency-phone-map"
      className="fixed inset-0 z-[90] bg-white"
    >
      <AgencyStayMap {...map} phone className="h-full" />
      {/* From tablets up Google's zoom buttons sit at the top right: the summary leaves them room. */}
      <div className="pointer-events-none absolute inset-x-4 top-4 z-20 sm:right-auto sm:w-[min(420px,calc(100%-6rem))]">
        <div className="flex flex-col rounded-[22px] bg-white px-[18px] py-2.5 shadow-[0_4px_14px_rgba(0,0,0,0.14)]">
          <strong className="truncate text-base text-gray-900">{title}</strong>
          <span className="truncate text-sm text-gray-500">{summary}</span>
        </div>
      </div>
      {/* Above Google's logo and terms at the bottom of the map. */}
      <button
        ref={listRef}
        type="button"
        onClick={onClose}
        className="absolute bottom-7 left-1/2 z-20 inline-flex min-h-[50px] -translate-x-1/2 items-center gap-2 rounded-full bg-white px-6 text-base font-semibold text-gray-900 shadow-[0_8px_24px_rgba(0,0,0,0.2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <svg
          aria-hidden="true"
          className="h-[18px] w-[18px]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
        {tm("viewList")}
      </button>
    </div>,
    document.body,
  );
}
