"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import type { PricingRoom } from "@/services/api/replacementOffers";
import RoomPlace, { type GuestPlace } from "./RoomPlace";

const AMENITIES_PREVIEW_COUNT = 8;
/** On wide screens the rates stay pinned under the details while this much of the column is left
 * for them; with more rates they scroll with the details, so every rate stays reachable. */
const DETAILS_MIN_HEIGHT = 160;

/** "View Details" on a room card, restored from the old booking page (VAY-2190): the room's
 * photos, facts, full description and amenities, with the card's own choices below.
 * VAY-2410: from lg up, a wide window whose 5:4 photo sets its height, with the details scrolling
 * beside it over the pinned rates. Smaller screens show one column, phones as before. */
export default function RoomDetailModal({
  room,
  roomCount,
  soldOut,
  place = null,
  onClose,
  children,
}: {
  room: PricingRoom;
  roomCount: number;
  soldOut: boolean;
  /** The property's place (VAY-2126), for "Where you'll stay" (VAY-2323), shown by the room's own switch (VAY-2445). */
  place?: GuestPlace | null;
  onClose: () => void;
  /** The card's choices and "Select This Rate", so both offer the same selection. */
  children: ReactNode;
}) {
  const t = useTranslations("home");
  const titleId = useId();
  const amenitiesId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ratesRef = useRef<HTMLDivElement>(null);
  const [imgIndex, setImgIndex] = useState(0);
  const [showAllAmenities, setShowAllAmenities] = useState(false);
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [descriptionCut, setDescriptionCut] = useState(false);
  // The pinned rates' height, or null while they scroll with the details.
  const [pinnedRatesHeight, setPinnedRatesHeight] = useState<number | null>(0);
  const [touchStartX, setTouchStartX] = useState<number | null>(null);
  const images = room.images ?? [];
  const amenities = room.amenities ?? [];
  const visibleAmenities = showAllAmenities
    ? amenities
    : amenities.slice(0, AMENITIES_PREVIEW_COUNT);
  const facts = [
    room.size && `${room.size.value} m²`,
    room.occupancy && t("upToGuests", { count: room.occupancy.maxGuests }),
    room.bedrooms && t("bedrooms", { count: room.bedrooms }),
    room.bathrooms && t("bathrooms", { count: room.bathrooms }),
  ].filter(Boolean);
  const step = (by: number) => setImgIndex((i) => (i + by + images.length) % images.length);

  // Close on Escape, keep the page behind from scrolling, and start at the close button.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = original;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Measured as the layout changes: whether four lines cut the description ("Read more"), and
  // whether the rates fit pinned under the details.
  useEffect(() => {
    const description = descriptionRef.current;
    const scroller = scrollRef.current;
    const rates = ratesRef.current;
    const observer = new ResizeObserver(() => {
      if (description && !showFullDescription)
        setDescriptionCut(description.scrollHeight > description.clientHeight + 1);
      if (scroller && rates)
        setPinnedRatesHeight(
          scroller.clientHeight - rates.offsetHeight >= DETAILS_MIN_HEIGHT
            ? rates.offsetHeight
            : null,
        );
    });
    for (const element of [description, scroller, rates]) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [showFullDescription]);

  // On the page body, so a sold-out card's fading doesn't apply to the dialog.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-stretch md:items-center justify-center bg-black/50 backdrop-blur-sm md:p-6 lg:py-10"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      {/* From lg the width keeps the 5:4 photo, and so the window, within the screen's height:
          the window is 12/25 of its width tall (3/5 wide photo, 4/5 of that high). */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative bg-white md:rounded-2xl shadow-2xl w-full h-full md:h-[90vh] md:max-h-full md:max-w-2xl lg:h-auto lg:max-w-[min(1360px,calc((100dvh_-_80px)*25/12))] overflow-hidden flex flex-col overscroll-contain"
      >
        <div className="flex items-center justify-end px-4 pt-3 pb-1 flex-shrink-0 lg:absolute lg:right-4 lg:top-4 lg:z-10 lg:p-0">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("closeRoomDetails")}
            className="p-1.5 rounded-full border border-gray-200 bg-white hover:bg-gray-50 text-gray-500"
          >
            <svg
              className="w-4 h-4"
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

        <div className="flex flex-col overflow-y-auto flex-1 min-h-0 overscroll-contain lg:grid lg:grid-cols-[3fr_2fr] lg:overflow-hidden">
          <div className="flex flex-col lg:relative">
            <div
              className={`relative h-72 lg:h-auto lg:w-full lg:aspect-[5/4] flex-shrink-0 select-none ${images.length ? "" : "bg-gray-100 flex items-center justify-center"}`}
              onTouchStart={(event) => setTouchStartX(event.touches[0]!.clientX)}
              onTouchEnd={(event) => {
                if (touchStartX === null || images.length < 2) return;
                const delta = event.changedTouches[0]!.clientX - touchStartX;
                if (Math.abs(delta) > 50) step(delta < 0 ? 1 : -1);
                setTouchStartX(null);
              }}
            >
              {images.length ? (
                <Image
                  src={images[imgIndex]!.url}
                  alt={images[imgIndex]!.alt ?? room.name}
                  fill
                  className="object-cover"
                  sizes={bookingImageSizes.roomModal}
                />
              ) : (
                <svg
                  className="w-16 h-16 text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.4}
                    d="M3 18v-6a2 2 0 012-2h14a2 2 0 012 2v6M3 18h18M3 18v2m18-2v2M6 10V7a1 1 0 011-1h4a1 1 0 011 1v3m0 0V7a1 1 0 011-1h4a1 1 0 011 1v3"
                  />
                </svg>
              )}
              {images.length > 1 && (
                <>
                  {([-1, 1] as const).map((by) => (
                    <button
                      key={by}
                      type="button"
                      onClick={() => step(by)}
                      aria-label={t(by < 0 ? "gallery.previous" : "gallery.next")}
                      className={`absolute ${by < 0 ? "left-2 lg:left-4" : "right-2 lg:right-4"} top-1/2 -translate-y-1/2 p-2 lg:p-4 rounded-full bg-white/85 hover:bg-white text-gray-700 shadow-md transition-colors`}
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d={by < 0 ? "M15 19l-7-7 7-7" : "M9 5l7 7-7 7"}
                        />
                      </svg>
                    </button>
                  ))}
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5 lg:hidden">
                    {images.map((_, i) => (
                      <span
                        key={i}
                        className={`h-1.5 rounded-full transition-all ${i === imgIndex ? "w-4 bg-white" : "w-1.5 bg-white/60"}`}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
            {/* Below the photo on smaller screens; over its foot, on a dark fade, from lg. */}
            {images.length > 1 && (
              <div className="flex gap-1.5 p-3 flex-shrink-0 bg-white overflow-x-auto lg:absolute lg:inset-x-0 lg:bottom-0 lg:gap-2 lg:bg-transparent lg:bg-gradient-to-t lg:from-black/60 lg:to-transparent lg:px-4 lg:pb-4 lg:pt-10">
                {images.map((image, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setImgIndex(i)}
                    aria-label={image.alt ?? room.name}
                    className={`relative w-16 h-12 lg:w-14 lg:h-[42px] flex-shrink-0 rounded-lg lg:rounded-md overflow-hidden border-2 transition ${i === imgIndex ? "border-primary-500 lg:border-white" : "border-transparent lg:opacity-70 lg:hover:opacity-100"}`}
                  >
                    <Image
                      src={image.url}
                      alt=""
                      fill
                      className="object-cover"
                      sizes={bookingImageSizes.roomThumb}
                      loading="lazy"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* From lg the column takes the photo's height and scrolls inside it. Its scroll padding
              keeps what keyboard focus scrolls to clear of the pinned rates. */}
          <div className="lg:relative">
            <div
              ref={scrollRef}
              style={
                pinnedRatesHeight === null ? undefined : { scrollPaddingBottom: pinnedRatesHeight }
              }
              className="lg:absolute lg:inset-0 lg:overflow-y-auto lg:flex lg:flex-col overscroll-contain"
            >
              <div className="px-6 pt-6 lg:grow">
                {soldOut && (
                  <div className="mb-4 lg:mr-8 px-4 py-3 rounded-xl bg-gray-100 border border-gray-200 text-sm font-semibold text-gray-800">
                    {t("soldOutForDates")}
                  </div>
                )}
                <div className="flex items-center gap-2 mb-2 flex-wrap lg:pr-10">
                  <h2 id={titleId} className="text-2xl font-bold text-gray-900">
                    {roomCount > 1 && <span className="text-primary-600">{roomCount}× </span>}
                    {room.name}
                  </h2>
                  {room.category && (
                    <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 border border-primary-200">
                      {room.category}
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-500 mb-4">{facts.join(" · ")}</p>
                {room.description && (
                  <div className="mb-5">
                    <p
                      ref={descriptionRef}
                      id={descriptionId}
                      className={`text-gray-600 leading-relaxed whitespace-pre-line ${showFullDescription ? "" : "line-clamp-4"}`}
                    >
                      {room.description}
                    </p>
                    {(descriptionCut || showFullDescription) && (
                      <button
                        type="button"
                        onClick={() => setShowFullDescription((expanded) => !expanded)}
                        aria-expanded={showFullDescription}
                        aria-controls={descriptionId}
                        className="mt-1 text-sm font-medium text-primary-600 hover:text-primary-700"
                      >
                        {showFullDescription ? t("showLess") : t("readMore")}
                      </button>
                    )}
                  </div>
                )}
                {amenities.length > 0 && (
                  <div className="mb-5">
                    <div id={amenitiesId} className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {visibleAmenities.map((amenity, index) => (
                        <span
                          key={`${amenity}-${index}`}
                          className="flex min-w-0 items-center gap-1.5 text-sm text-gray-600"
                        >
                          <svg
                            className="w-3.5 h-3.5 text-primary-500 flex-shrink-0"
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
                          <span className="truncate" title={amenity}>
                            {amenity}
                          </span>
                        </span>
                      ))}
                    </div>
                    {amenities.length > AMENITIES_PREVIEW_COUNT && (
                      <button
                        type="button"
                        onClick={() => setShowAllAmenities((expanded) => !expanded)}
                        aria-expanded={showAllAmenities}
                        aria-controls={amenitiesId}
                        className="mt-2 text-sm font-medium text-primary-600 hover:text-primary-700"
                      >
                        {showAllAmenities
                          ? t("showLess")
                          : t("viewFullAmenities", { count: amenities.length })}
                      </button>
                    )}
                  </div>
                )}
                <RoomPlace
                  room={room}
                  property={place}
                  apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? ""}
                />
              </div>
              <div
                ref={ratesRef}
                className={`bg-white px-6 pb-6 ${pinnedRatesHeight === null ? "" : "lg:sticky lg:bottom-0"}`}
              >
                {children}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
