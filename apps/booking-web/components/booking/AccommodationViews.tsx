"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
import AccommodationsPhoneMap from "./AccommodationsPhoneMap";
import GuestMap, { MapGate, type GuestMapPlace } from "./GuestMap";
import {
  NearbyChips,
  NearbyPlaceCard,
  closeNearby,
  nearbyOnMap,
  nearbyReference,
  useNearbyLayer,
} from "./NearbyMapLayer";

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
function useWideScreen(): boolean {
  return useSyncExternalStore(
    onWidthChange,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

/** Available Accommodations' room cards. With the rooms in several places, the map replaces the Location
 * section below, and Google loads only after the guest asks for it (VAY-2216):
 * - on a wide screen (VAY-2324) the guest picks List (today's cards), List + map (short cards next to a map,
 *   the default) or Map (a full-width map with the selected room on it), and "Show map" opens the map; the view
 *   and the press are remembered for this tab;
 * - on a phone (VAY-2325) the cards have a floating "Map" button that opens a full-screen map. */
export default function AccommodationViews({
  slug,
  rooms,
  map,
  stay,
  heading,
  tabs,
  toolbar,
  notices,
  renderCard,
}: {
  /** The hotel's booking page, for its nearby places (VAY-2327). */
  slug: string;
  /** In the order the guest sorted them. */
  rooms: PricingRoom[];
  /** The rooms' places, or null without the views. */
  map: { pins: LocationMapPin[]; places: GuestMapPlace[]; apiKey: string } | null;
  /** The stay searched, for the phone map's summary, and Edit to change it. */
  stay: { label: string; onEdit: () => void };
  /** "Available Accommodations", left of the views and the sort on one row (VAY-2448). */
  heading: ReactNode;
  /** A group's room tabs, on their own row below the heading (VAY-2412, VAY-2448). */
  tabs: ReactNode;
  /** The sort, right of the views. */
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
  const wide = useWideScreen();
  const [phoneMap, setPhoneMap] = useState(false);
  // The phone's "Map" button floats only while the cards are on screen.
  const [cardsOnScreen, setCardsOnScreen] = useState(false);
  const [phoneCards, setPhoneCards] = useState<HTMLDivElement | null>(null);
  const mapButtonRef = useRef<HTMLButtonElement>(null);
  // The host's nearby places, once the guest asked for a map (VAY-2327).
  const nearby = useNearbyLayer(slug, Boolean(map) && requested);

  useEffect(() => {
    if (!phoneCards) return;
    const observer = new IntersectionObserver((entries) =>
      setCardsOnScreen(entries[entries.length - 1].isIntersecting),
    );
    observer.observe(phoneCards);
    return () => observer.disconnect();
  }, [phoneCards]);

  // VAY-2448: the heading with the views and the sort on one row; on a phone the controls wrap
  // below the heading. A group's tabs follow on their own row, their underline on its border.
  const toolbarRow = (controls: ReactNode) => (
    <>
      <div
        className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-3 ${tabs ? "mb-5" : "mb-9"}`}
      >
        {heading}
        <div className="flex flex-wrap items-center gap-3">{controls}</div>
      </div>
      {tabs && <div className="mb-3 min-w-0 border-b border-gray-200">{tabs}</div>}
    </>
  );

  if (!map || !wide) {
    return (
      <>
        {toolbarRow(toolbar)}
        {notices}
        <div ref={map ? setPhoneCards : undefined} className="space-y-7">
          {rooms.map((room) => renderCard(room, { compact: false, active: false }))}
        </div>
        {map && cardsOnScreen && (
          // Pressing it is the guest's choice to load Google (VAY-2216), remembered for this tab.
          <button
            ref={mapButtonRef}
            type="button"
            onClick={() => {
              chooseMaps();
              setRequested(true);
              setPhoneMap(true);
            }}
            // Above the privacy settings pill and a group's rooms bar at the bottom of a phone.
            className="fixed bottom-[calc(4rem+var(--fixed-bottom-bar,0px))] left-1/2 z-40 inline-flex min-h-[44px] -translate-x-1/2 items-center gap-2 rounded-full bg-gray-900 px-5 text-sm font-semibold text-white shadow-lg"
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
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
              />
            </svg>
            {t("viewMap")}
          </button>
        )}
        {map && phoneMap && (
          <AccommodationsPhoneMap
            rooms={rooms}
            pins={map.pins}
            places={map.places}
            apiKey={map.apiKey}
            stay={{
              label: stay.label,
              // Once the map is gone and the page is in reach again.
              onEdit: () => {
                nearby.close();
                setPhoneMap(false);
                requestAnimationFrame(stay.onEdit);
              },
            }}
            renderCard={renderCard}
            nearby={nearby}
            onClose={() => {
              // A place's card belongs to this map: the next one opens on the rooms.
              nearby.close();
              setPhoneMap(false);
              requestAnimationFrame(() => mapButtonRef.current?.focus());
            }}
          />
        )}
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
    const card = list?.querySelector(`[data-testid="room-card-${room.roomTypeId}"]`);
    if (!list || !card) return;
    const [inList, inCard] = [list.getBoundingClientRect(), card.getBoundingClientRect()];
    if (inCard.top >= inList.top && inCard.bottom <= inList.bottom) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollBy({ top: inCard.top - inList.top - 8, behavior: reduce ? "auto" : "smooth" });
  };
  const floating =
    view === "map" ? rooms.find(({ roomTypeId }) => roomTypeId === selectedRoom) : undefined;
  const reference = nearbyReference(pins, places, selectedPin);

  return (
    <>
      {toolbarRow(
        <>
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
                  // A place's card stays with the map it was opened on.
                  if (value !== view) nearby.close();
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
          {toolbar}
        </>,
      )}
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
            className={view === "split" ? "space-y-3 overflow-y-auto pr-1" : "space-y-7"}
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
              <>
                <GuestMap
                  places={places}
                  selected={selectedPin < 0 ? null : selectedPin}
                  onSelect={selectPin}
                  apiKey={apiKey}
                  label={t("mapLabel")}
                  className="h-full"
                  nearby={nearbyOnMap(nearby)}
                />
                <NearbyChips
                  layer={nearby}
                  className="absolute left-3 right-3 top-3 z-10 sm:right-16"
                />
              </>
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
            {requested && nearby.selected && (
              // Bottom right: the selected room's card keeps the bottom left (VAY-2327).
              <NearbyPlaceCard
                place={nearby.selected}
                reference={reference}
                onClose={() => closeNearby(nearby)}
                className="absolute bottom-10 right-4 z-10 w-[340px] max-w-[calc(100%-2rem)]"
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}
