"use client";

import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { LocationMapPin } from "@vayada/domain-hotels";
import type { PricingRoom } from "@/services/api/replacementOffers";
import {
  chooseMaps,
  chooseView,
  chosenView,
  mapsChosen,
  type AccommodationView,
} from "@/lib/mapsChoice";
import GuestMap, { MapGate, type GuestMapPlace } from "./GuestMap";

const WIDE = "(min-width: 1024px)";
const VIEWS = [
  ["list", "viewList"],
  ["split", "viewSplit"],
  ["map", "viewMap"],
] as const;

function onWidthChange(onChange: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Desktop widths, where the accommodations get their List | List + map | Map views (VAY-2324). */
export function useWideScreen(): boolean {
  return useSyncExternalStore(
    onWidthChange,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

/** Available Accommodations' room cards. With its rooms in several places on a wide screen (VAY-2324) the
 * guest picks List (today's cards), List + map (short cards next to a map, the default) or Map (a full-width
 * map with the selected room on it); the map replaces the Location section below, and Google loads only
 * after "Show map" (VAY-2216). The view and the press are remembered for this tab. */
export default function AccommodationViews({
  rooms,
  map,
  toolbar,
  notices,
  renderCard,
}: {
  /** In the order the guest sorted them. */
  rooms: PricingRoom[];
  /** The rooms' places, or null without the views. */
  map: { pins: LocationMapPin[]; places: GuestMapPlace[]; apiKey: string } | null;
  /** The sort, next to the views. */
  toolbar: ReactNode;
  /** Said above the cards, such as prices that failed. */
  notices: ReactNode;
  renderCard: (
    room: PricingRoom,
    card: { compact: boolean; active: boolean; onActivate?: () => void },
  ) => ReactNode;
}) {
  const t = useTranslations("locationMap");
  // This tab's choices, read at once: the cards only render in the browser, after the catalog loaded.
  const [view, setView] = useState<AccommodationView>(() => chosenView() ?? "split");
  const [requested, setRequested] = useState(mapsChosen);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  if (!map) {
    return (
      <>
        <div className="mb-5 flex items-center justify-end gap-2">{toolbar}</div>
        {notices}
        <div className="space-y-6">
          {rooms.map((room) => renderCard(room, { compact: false, active: false }))}
        </div>
      </>
    );
  }
  const { pins, places, apiKey } = map;
  const selectedPin = pins.findIndex(
    (pin) => selectedRoom !== null && pin.roomTypeIds.includes(selectedRoom),
  );
  // A pin selects its first room in the guest's order, and scrolls the cards next to the map to it.
  const selectPin = (index: number) => {
    const room = rooms.find(({ roomTypeId }) => pins[index]?.roomTypeIds.includes(roomTypeId));
    if (!room) return;
    setSelectedRoom(room.roomTypeId);
    const list = listRef.current;
    const card = document.getElementById(`room-card-${room.roomTypeId}`);
    if (!list || !card) return;
    const [inList, inCard] = [list.getBoundingClientRect(), card.getBoundingClientRect()];
    if (inCard.top >= inList.top && inCard.bottom <= inList.bottom) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollBy({ top: inCard.top - inList.top - 8, behavior: reduce ? "auto" : "smooth" });
  };
  const floating =
    view === "map" ? rooms.find(({ roomTypeId }) => roomTypeId === selectedRoom) : undefined;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-end gap-3">
        <div
          role="group"
          aria-label={t("viewsLabel")}
          className="inline-flex rounded-xl bg-gray-100 p-1"
        >
          {VIEWS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => {
                setView(value);
                chooseView(value);
              }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                view === value
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">{toolbar}</div>
      </div>
      {notices}
      <div
        className={
          view === "split"
            ? "grid h-[min(760px,calc(100vh-12rem))] min-h-[520px] grid-cols-2 gap-6 xl:grid-cols-[minmax(0,620px)_minmax(0,1fr)]"
            : ""
        }
      >
        {view !== "map" && (
          // List + map: the short cards scroll next to the map.
          <div
            ref={listRef}
            className={view === "split" ? "space-y-3 overflow-y-auto pr-1" : "space-y-6"}
          >
            {rooms.map((room) =>
              renderCard(room, {
                compact: view === "split",
                active: view === "split" && room.roomTypeId === selectedRoom,
                onActivate: view === "split" ? () => setSelectedRoom(room.roomTypeId) : undefined,
              }),
            )}
          </div>
        )}
        {/* One map in the same place for List + map and Map: switching between them keeps it loaded. */}
        {view !== "list" && (
          <div
            data-testid="accommodations-map"
            className={`relative overflow-hidden rounded-2xl border border-gray-200 ${
              view === "split" ? "h-full" : "h-[680px]"
            }`}
          >
            {requested ? (
              <GuestMap
                places={places}
                selected={selectedPin < 0 ? null : selectedPin}
                onSelect={selectPin}
                apiKey={apiKey}
                label={t("mapLabel")}
                className="h-full"
              />
            ) : (
              <MapGate
                className="h-full"
                onRequest={() => {
                  chooseMaps();
                  setRequested(true);
                }}
              />
            )}
            {floating && (
              // Above Google's logo and terms at the bottom of the map.
              <div className="absolute bottom-10 left-4 z-10 w-[460px] max-w-[calc(100%-2rem)] shadow-xl">
                {renderCard(floating, { compact: true, active: false })}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
