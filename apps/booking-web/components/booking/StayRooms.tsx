"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { calculateNights, formatDate, formatDateShort } from "@/lib/utils";
import type { RoomSortKey } from "@/lib/roomSorting";
import type { StayRoomsModel } from "@/lib/hooks/useStayRooms";
import { trackEvent } from "@/services/api/tracking";
import type { RoomPick } from "@/lib/roomPicker";
import type { PricingRoom } from "@/services/api/replacementOffers";
import RoomCard from "./RoomCard";
import RoomTabs, { RoomsHelp } from "./RoomsProgress";
import AccommodationViews from "./AccommodationViews";
import ApproximateAmountsNote from "./ApproximateAmountsNote";

// VAY-2449: the sort menu's options, as the hotel's Room Sorting lists them.
const SORT_LABELS: Record<RoomSortKey, string> = {
  recommended: "recommended",
  priceLow: "priceLowHigh",
  priceHigh: "priceHighLow",
  roomSize: "roomSize",
  capacity: "capacity",
  bestDeal: "bestDeal",
};

/**
 * A stay's rooms for the search (VAY-2461, out of the hotel page): "Available Accommodations"
 * with the sort, a group's room tabs and help, the room cards in their views (VAY-2324), and what
 * the page says without them. `useStayRooms` holds the state; the search card above opens the
 * dates (`onEditDates`) and "Who sleeps where" (`onEditGuests`).
 */
export default function StayRooms({
  model,
  onEditDates,
  onEditGuests,
  heading: headingText,
  intro,
}: {
  model: StayRoomsModel;
  onEditDates: () => void;
  onEditGuests: () => void;
  /** The section's title; "Available Accommodations" unless given. */
  heading?: ReactNode;
  /** Shown under the heading, above the rooms, such as the agency's stay box (VAY-2461). */
  intro?: ReactNode;
}) {
  const locale = useLocale();
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const {
    slug,
    hotel,
    checkIn,
    checkOut,
    adults,
    children: effectiveChildren,
    promoCode,
    hasAddons,
    rooms,
    roomsFailed,
    reloadCatalog,
    stay,
    roomPrices,
    shownRooms,
    menu,
    sortOption,
    setSortPick,
    roomCount,
    pickMode,
    slots,
    picks,
    draft,
    activeRoom,
    allChosen,
    kept,
    takenBy,
    offerOf,
    progressRooms,
    noneFits,
    roomsNeeded,
    selectRoom,
    chooseRoom,
    bookPart,
    continueWithRooms,
    changeRoomCount,
    removeRoom,
    openRoom,
    detailsRequests,
    detailsProperty,
    severalPlaces,
    locationLine,
    roomsMap,
  } = model;
  const nights = calculateNights(checkIn, checkOut);

  // VAY-2448: the sort sits on the heading's row: its icon, "Sort by" and the select.
  const sortControl = (
    <div className="flex items-center gap-2">
      <svg
        className="h-4 w-4 text-gray-500"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
        />
      </svg>
      <label htmlFor="room-sort" className="text-sm text-gray-500">
        {t("sortBy")}
      </label>
      <div className="relative">
        <select
          id="room-sort"
          value={sortOption}
          onChange={(event) => setSortPick(event.target.value as RoomSortKey)}
          className="min-h-[44px] cursor-pointer appearance-none rounded-full border border-gray-200 bg-white pl-4 pr-10 text-sm font-medium text-gray-900 hover:border-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          {menu.options.map((option) => (
            <option key={option} value={option}>
              {t(SORT_LABELS[option])}
            </option>
          ))}
        </select>
        <svg
          className="pointer-events-none absolute right-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-700"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </div>
  );
  const roomCard = (
    room: PricingRoom,
    view: { compact: boolean; active: boolean; onActivate?: () => void } = {
      compact: false,
      active: false,
    },
  ) => (
    <RoomCard
      key={room.roomTypeId}
      room={room}
      prices={roomPrices(room)}
      pricesState={
        stay.failed ? "failed" : stay.missing ? "missing" : stay.loading ? "loading" : "ready"
      }
      checkIn={checkIn}
      nights={nights}
      timezone={hotel.timezone}
      childGuests={effectiveChildren}
      promoCode={promoCode}
      onSelect={(publicOfferKey, count) =>
        pickMode ? chooseRoom(room, publicOfferKey) : selectRoom(publicOfferKey, count)
      }
      pick={
        pickMode
          ? {
              room: activeRoom + 1,
              guests: slots[activeRoom]!,
              takenBy: takenBy(room),
              chosen: picks.flatMap((pick, index) => {
                const offer = pick && index !== activeRoom ? offerOf(pick) : undefined;
                return offer ? [offer] : [];
              }),
              current:
                !allChosen && picks[activeRoom]?.roomTypeId === room.roomTypeId
                  ? picks[activeRoom]!.publicOfferKey
                  : null,
              onChangeGuests: onEditGuests,
              allChosen,
            }
          : undefined
      }
      chosen={kept?.roomTypeId === room.roomTypeId ? draft.picks[0]!.publicOfferKey : null}
      bookPart={
        !pickMode && adults > 1
          ? {
              guests: adults + effectiveChildren,
              onBook: (publicOfferKey, partAdults) => bookPart(room, publicOfferKey, partAdults),
            }
          : undefined
      }
      onView={() => trackEvent(slug, "room_viewed", { roomTypeId: room.roomTypeId })}
      detailsRequest={detailsRequests[room.roomTypeId] ?? 0}
      place={detailsProperty}
      locationLine={severalPlaces ? locationLine(room) : null}
      compact={view.compact}
      active={view.active}
      onActivate={view.onActivate}
    />
  );
  const notices = (
    <>
      {intro}
      {stay.failed && (
        <div role="alert" className="mb-5 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t("pricesFailed")}{" "}
          <button type="button" className="font-semibold underline" onClick={stay.retry}>
            {t("retryPrices")}
          </button>
        </div>
      )}
      {pickMode ? (
        <RoomsHelp
          count={roomCount}
          current={allChosen ? null : activeRoom}
          guests={slots[activeRoom]!}
          hasExtras={hasAddons}
          onContinue={() => continueWithRooms(picks as RoomPick[])}
        />
      ) : noneFits ? (
        // VAY-2393: no place fits the whole party; the rooms it needs are one click away.
        <div
          role="note"
          data-testid="none-fits"
          className="mb-5 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-amber-900">
            <strong>{t("oneRoom.noneFits", { count: adults + effectiveChildren })}</strong>{" "}
            {t("oneRoom.splitHint")}
          </p>
          <button
            type="button"
            onClick={() => changeRoomCount(roomsNeeded)}
            className="min-h-[44px] shrink-0 rounded-full bg-primary-600 px-5 text-sm font-semibold text-white hover:bg-primary-700"
          >
            {t("oneRoom.bookRooms", { count: roomsNeeded })}
          </button>
        </div>
      ) : null}
      {!pickMode && effectiveChildren > 0 && (
        <p className="mb-5 text-sm text-gray-500">{t("childrenPricedLater")}</p>
      )}
    </>
  );

  // On the heading's row the "≈" note takes a line of its own below it, so the sort stays
  // centred on the title.
  const heading = (
    <>
      <h2 className="min-w-0 text-2xl md:text-3xl font-heading text-gray-900">
        {headingText ?? t("availableAccommodations")}
      </h2>
      {/* VAY-2390: the cards lead with "≈" amounts in the guest's display currency. */}
      <ApproximateAmountsNote currency={hotel.currency} className="order-last basis-full" />
    </>
  );

  return (
    // VAY-2448: no stepper while choosing; the sort shares the heading's row.
    <div id="rooms" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 pb-12 scroll-mt-36">
      {rooms === null && !roomsFailed ? (
        <>
          <div className="mb-9">{heading}</div>
          {intro}
          <div className="space-y-7" aria-hidden="true">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="bg-white border border-gray-200 rounded-2xl overflow-hidden animate-pulse flex flex-col md:flex-row"
              >
                <div className="w-full md:w-[420px] h-64 md:min-h-[320px] bg-gray-200" />
                <div className="flex-1 p-5 space-y-4">
                  <div className="h-6 bg-gray-200 rounded w-48" />
                  <div className="h-4 bg-gray-200 rounded w-32" />
                  <div className="h-16 bg-gray-200 rounded-xl" />
                  <div className="h-16 bg-gray-200 rounded-xl" />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : rooms?.length ? (
        <>
          <AccommodationViews
            slug={slug}
            rooms={shownRooms}
            map={roomsMap}
            stay={{
              label: `${formatDateShort(checkIn, locale)} – ${formatDate(checkOut, locale)} · ${[
                tc("adults", { count: adults }),
                effectiveChildren > 0 && tc("children", { count: effectiveChildren }),
              ]
                .filter(Boolean)
                .join(", ")}`,
              // Back to the search, with the dates open and focused.
              onEdit: onEditDates,
            }}
            tabs={
              pickMode && (
                <RoomTabs
                  rooms={progressRooms}
                  current={allChosen ? null : activeRoom}
                  guests={slots}
                  onOpen={openRoom}
                  onRemove={removeRoom}
                />
              )
            }
            heading={heading}
            toolbar={menu.options.length ? sortControl : null}
            notices={notices}
            renderCard={roomCard}
          />
        </>
      ) : (
        <>
          <div className="mb-9">{heading}</div>
          {intro}
          {/* VAY-2446: no room cards (the catalog failed, or no room is bookable right now). */}
          <div
            role="alert"
            data-testid="rooms-unavailable"
            className="mb-6 flex flex-col gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 sm:flex-row sm:items-center sm:justify-between"
          >
            <p>{t("roomsUnavailable")}</p>
            <button
              type="button"
              onClick={reloadCatalog}
              className="min-h-[44px] shrink-0 rounded-full bg-primary-600 px-5 font-semibold text-white hover:bg-primary-700"
            >
              {t("retryPrices")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
