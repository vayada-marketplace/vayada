"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import type { PricingRoom } from "@/services/api/replacementOffers";

const AMENITIES_PREVIEW_COUNT = 10;

/** "View Details" on a room card, restored from the old booking page (VAY-2190): the room's
 * photos, facts, full description and amenities, with the card's own choices below. */
export default function RoomDetailModal({
  room,
  roomCount,
  soldOut,
  onClose,
  children,
}: {
  room: PricingRoom;
  roomCount: number;
  soldOut: boolean;
  onClose: () => void;
  /** The card's choices and "Select This Rate", so both offer the same selection. */
  children: ReactNode;
}) {
  const t = useTranslations("home");
  const titleId = useId();
  const amenitiesId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [imgIndex, setImgIndex] = useState(0);
  const [showAllAmenities, setShowAllAmenities] = useState(false);
  const [touchStartX, setTouchStartX] = useState<number | null>(null);
  const images = room.images ?? [];
  const amenities = room.amenities ?? [];
  const visibleAmenities = showAllAmenities
    ? amenities
    : amenities.slice(0, AMENITIES_PREVIEW_COUNT);
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

  // On the page body, so a sold-out card's fading doesn't apply to the dialog.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-stretch md:items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white md:rounded-2xl shadow-2xl w-full md:max-w-5xl h-full md:h-[90vh] overflow-hidden flex flex-col overscroll-contain"
      >
        <div className="flex items-center justify-end px-4 pt-3 pb-1 flex-shrink-0">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("closeRoomDetails")}
            className="p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 text-gray-500"
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

        <div className="flex flex-col md:flex-row overflow-y-auto md:overflow-hidden flex-1 min-h-0 overscroll-contain">
          <div className="md:w-1/2 md:flex-shrink-0 flex flex-col md:min-h-0">
            <div
              className={`relative h-72 md:h-auto md:flex-1 md:min-h-[300px] flex-shrink-0 select-none ${images.length ? "" : "bg-gray-100 flex items-center justify-center"}`}
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
                      className={`absolute ${by < 0 ? "left-2" : "right-2"} top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/85 hover:bg-white text-gray-700 shadow-md transition-colors`}
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
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
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
            {images.length > 1 && (
              <div className="flex gap-1.5 p-3 flex-shrink-0 bg-white overflow-x-auto">
                {images.map((image, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setImgIndex(i)}
                    aria-label={image.alt ?? room.name}
                    className={`relative w-16 h-12 flex-shrink-0 rounded-lg overflow-hidden border-2 transition-colors ${i === imgIndex ? "border-primary-500" : "border-transparent"}`}
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

          <div className="md:w-1/2 flex flex-col md:flex-1 md:min-h-0">
            <div className="md:flex-1 md:overflow-y-auto overscroll-contain p-6">
              {soldOut && (
                <div className="mb-4 px-4 py-3 rounded-xl bg-gray-100 border border-gray-200 text-sm font-semibold text-gray-800">
                  {t("soldOutForDates")}
                </div>
              )}
              <div className="flex items-center gap-2 mb-2 flex-wrap">
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
              <div className="flex items-center gap-3 text-sm text-gray-500 mb-4 flex-wrap">
                {room.size && <span>{room.size.value} m&sup2;</span>}
                {room.occupancy && (
                  <span>{t("upToGuests", { count: room.occupancy.maxGuests })}</span>
                )}
              </div>
              {room.description && (
                <p className="text-gray-600 leading-relaxed whitespace-pre-line mb-5">
                  {room.description}
                </p>
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
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
