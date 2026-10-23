"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import type { LocationMapPin } from "@vayada/domain-hotels";
import type { PricingRoom } from "@/services/api/replacementOffers";
import GuestMap, { type GuestMapPlace } from "./GuestMap";

// Room around the pills when the map fits them in; below, the cards drawn over the map (measured).
const FIT_PADDING = { top: 48, right: 48, bottom: 280, left: 48 };

/** The phone's accommodations map (VAY-2325): full screen under a short summary of the stay, the same pills as
 * on a wide screen, and the rooms as a row of cards to swipe. Swiping selects a room's pill; tapping a pill
 * brings its room's card into view. */
export default function AccommodationsPhoneMap({
  rooms,
  pins,
  places,
  apiKey,
  stay,
  renderCard,
  onClose,
}: {
  /** In the order the guest sorted them. */
  rooms: PricingRoom[];
  pins: LocationMapPin[];
  places: GuestMapPlace[];
  apiKey: string;
  /** The stay searched ("3 – 5 Nov · 2 adults"), and Edit to change it. */
  stay: { label: string; onEdit: () => void };
  renderCard: (
    room: PricingRoom,
    card: { compact: boolean; active: boolean; onActivate?: () => void },
  ) => ReactNode;
  onClose: () => void;
}) {
  const t = useTranslations("locationMap");
  const [selectedRoom, setSelectedRoom] = useState(rooms[0]?.roomTypeId ?? null);
  const [fitPadding, setFitPadding] = useState(FIT_PADDING);
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLButtonElement>(null);
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);

  // A modal: the page behind stays put and out of reach (a room's details still open over the map), and the
  // focus starts on "List".
  useEffect(() => {
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    const behind = Array.from(document.body.children).filter(
      (element) => element !== dialogRef.current && !element.hasAttribute("inert"),
    );
    behind.forEach((element) => element.setAttribute("inert", ""));
    listRef.current?.focus();
    const overlay = overlayRef.current?.offsetHeight;
    if (overlay) setFitPadding({ ...FIT_PADDING, bottom: overlay + 32 });
    return () => {
      root.style.overflow = overflow;
      behind.forEach((element) => element.removeAttribute("inert"));
      clearTimeout(settling.current);
    };
  }, []);

  const selectedPin = pins.findIndex(
    (pin) => selectedRoom !== null && pin.roomTypeIds.includes(selectedRoom),
  );
  // A pill selects its first room in the guest's order, and brings that room's card into view.
  const selectPin = (index: number) => {
    const at = rooms.findIndex(({ roomTypeId }) => pins[index]?.roomTypeIds.includes(roomTypeId));
    if (at < 0) return;
    setSelectedRoom(rooms[at].roomTypeId);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    carouselRef.current?.children[at]?.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: reduce ? "auto" : "smooth",
    });
  };
  // Swiping selects the card the row came to rest on: the one whose own resting place is nearest. At the ends,
  // where cards can't reach the middle, several share the resting place and the selected one stays.
  const swiped = () => {
    clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      const carousel = carouselRef.current;
      if (!carousel) return;
      const end = carousel.scrollWidth - carousel.clientWidth;
      const off = (card: Element) => {
        const { offsetLeft, offsetWidth } = card as HTMLElement;
        const rest = Math.min(
          end,
          Math.max(0, offsetLeft + offsetWidth / 2 - carousel.clientWidth / 2),
        );
        return Math.abs(rest - carousel.scrollLeft);
      };
      const cards = Array.from(carousel.children);
      const current = rooms.findIndex(({ roomTypeId }) => roomTypeId === selectedRoom);
      const nearest = cards.reduce(
        (best, card, index) => (off(card) < off(cards[best]) - 1 ? index : best),
        current < 0 ? 0 : current,
      );
      if (rooms[nearest]) setSelectedRoom(rooms[nearest].roomTypeId);
    }, 120);
  };

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("phoneMapLabel")}
      data-testid="accommodations-phone-map"
      className="fixed inset-0 z-[90] flex flex-col bg-white"
      onKeyDown={(event) => {
        // Escape from a room's details (a portal of its own) closes only those.
        if (event.key === "Escape" && dialogRef.current?.contains(event.target as Node)) onClose();
      }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-1.5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{stay.label}</p>
          <p className="text-sm text-gray-500">
            {t("accommodationsCount", { count: rooms.length })}
          </p>
        </div>
        <button
          type="button"
          onClick={stay.onEdit}
          className="min-h-[44px] shrink-0 px-2 text-sm font-semibold text-primary-600"
        >
          {t("editStay")}
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <GuestMap
          places={places}
          selected={selectedPin < 0 ? null : selectedPin}
          onSelect={selectPin}
          apiKey={apiKey}
          label={t("mapLabel")}
          className="h-full"
          fitPadding={fitPadding}
          gestureHandling="greedy"
        />
        {/* Above Google's logo and terms at the bottom of the map. */}
        <div
          ref={overlayRef}
          className="pointer-events-none absolute inset-x-0 bottom-7 flex flex-col items-center gap-3"
        >
          <button
            ref={listRef}
            type="button"
            onClick={onClose}
            className="pointer-events-auto inline-flex min-h-[44px] items-center gap-2 rounded-full bg-gray-900 px-5 text-sm font-semibold text-white shadow-lg"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeWidth={2}
                d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"
              />
            </svg>
            {t("viewList")}
          </button>
          <div
            ref={carouselRef}
            onScroll={swiped}
            aria-label={t("cardsLabel")}
            role="group"
            className="pointer-events-auto relative flex w-full snap-x snap-mandatory gap-3 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {rooms.map((room) => (
              <div key={room.roomTypeId} className="w-[85%] max-w-[360px] shrink-0 snap-center">
                {renderCard(room, {
                  compact: true,
                  active: room.roomTypeId === selectedRoom,
                  onActivate: () => setSelectedRoom(room.roomTypeId),
                })}
              </div>
            ))}
          </div>
          <div aria-hidden="true" className="flex gap-1.5">
            {rooms.map((room) => (
              <span
                key={room.roomTypeId}
                className={`h-1.5 rounded-full transition-all ${
                  room.roomTypeId === selectedRoom ? "w-4 bg-primary-600" : "w-1.5 bg-gray-300"
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
