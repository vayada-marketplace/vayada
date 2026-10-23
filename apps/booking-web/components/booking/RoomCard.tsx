"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { useCurrency } from "@/contexts/CurrencyContext";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import { choiceKeys, choiceText } from "@/lib/roomChoices";
import { resolveLocale } from "@/lib/utils";
import type { PricingRoom } from "@/services/api/replacementOffers";
import { quoteMoneyAmount } from "@/services/api/replacementOffers";
import type { StayRoomPrices } from "@/services/api/stayPrices";
import RateOption from "./RateOption";
import RoomDetailModal from "./RoomDetailModal";

/** "3 Nov" for a stay date (YYYY-MM-DD), the same in every time zone. */
const shortDate = (date: string, locale: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(resolveLocale(locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** The booking page's room card, restored from the old booking page (VAY-2190) on pricing v2:
 * photos, facts, amenities, the room's bookable choices as rate rows and one "Select This Rate"
 * button that opens /book with that choice. Prices are a preview; /book quotes the stay. */
export default function RoomCard({
  room,
  prices,
  pricesState,
  checkIn,
  nights,
  timezone,
  childGuests,
  promoCode,
  onSelect,
  onView: onViewed,
  detailsRequest = 0,
}: {
  room: PricingRoom;
  /** Stay prices for this room; null while loading, when they failed or aren't offered. */
  prices: StayRoomPrices | null;
  /** Without prices ("failed", or "missing" when the API has no stay-prices read) the choices
   * can still be picked: /book prices the stay. */
  pricesState: "loading" | "ready" | "failed" | "missing";
  checkIn: string;
  nights: number;
  timezone?: string;
  /** Children in the search, to say why a room that takes none doesn't fit. */
  childGuests: number;
  /** The guest's promo code, to say when it doesn't apply to this room. */
  promoCode?: string | null;
  onSelect: (publicOfferKey: string, roomCount: number) => void;
  /** The room's details were opened. */
  onView?: () => void;
  /** Raised to open the room's details from elsewhere, such as its pin on the location map (VAY-2126). */
  detailsRequest?: number;
}) {
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { approximate } = useCurrency();
  const [imageIndex, setImageIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const onView = () => {
    setDetailsOpen(true);
    onViewed?.();
  };
  const handledDetailsRequest = useRef(detailsRequest);
  useEffect(() => {
    if (detailsRequest === handledDetailsRequest.current) return;
    handledDetailsRequest.current = detailsRequest;
    onView();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new request opens the details
  }, [detailsRequest]);

  const images = room.images ?? [];
  // Without prices for this room (failed, no read, or the room missing from the answer) the
  // choices stay choosable and /book prices the stay.
  const unpricedRoom =
    pricesState === "failed" || pricesState === "missing" || (pricesState === "ready" && !prices);
  // A room the party doesn't fit isn't sold out: it says how many guests it takes instead.
  const tooSmall = prices !== null && prices.roomCount === null;
  const soldOut = prices?.availability === "sold_out" && !tooSmall;
  const roomCount = prices?.roomCount ?? 1;
  const keys = choiceKeys(room.offers);
  const all = room.offers.map((offer, index) => {
    const price = prices?.offers.find((p) => p.publicOfferKey === offer.publicOfferKey);
    return {
      offer,
      text: choiceText(
        keys[index]!,
        { checkIn, timezone, formatDate: (date) => shortDate(date, locale) },
        t,
      ),
      priced: price?.status === "priced" ? price : null,
      unavailable: !!prices && price?.status !== "priced" && price?.status !== "unpriced",
      bookable:
        !soldOut &&
        !tooSmall &&
        (unpricedRoom || price?.status === "priced" || price?.status === "unpriced"),
    };
  });
  // A choice whose free cancellation has passed is hidden while the same meal is still bookable
  // in another choice (old VAY-370 rule); otherwise it stays, saying cancellation has passed.
  const shown = all
    .filter(
      (choice) =>
        !choice.text.cancellationPassed ||
        !all.some(
          (other) =>
            other !== choice &&
            !other.text.cancellationPassed &&
            other.bookable &&
            other.offer.mealPlan === choice.offer.mealPlan,
        ),
    )
    .sort((a, b) => {
      if (!a.priced || !b.priced) return Number(!a.priced) - Number(!b.priced);
      return (
        quoteMoneyAmount(a.priced.totalMinor, a.priced.currency) -
        quoteMoneyAmount(b.priced.totalMinor, b.priced.currency)
      );
    });
  const selectable = shown.filter(({ bookable }) => bookable);
  // The cheapest choice starts selected, as the old card did with non-refundable.
  const selected = selectable.find(({ offer }) => offer.publicOfferKey === picked) ?? selectable[0];

  const amount = (choice: (typeof shown)[number]) =>
    choice.priced ? quoteMoneyAmount(choice.priced.totalMinor, choice.priced.currency) : null;
  // The charged amount in its own currency, with cents when it has them, then any approximation.
  const money = (value: number, currency: string) => {
    const exact = new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
    const approx = approximate(value, currency);
    return approx ? `${exact} (${approx})` : exact;
  };
  const discount = (choice: (typeof shown)[number]) => {
    if (choice.text.refundable !== false) return undefined;
    const refundable = shown.find(
      (other) => other.text.refundable === true && other.offer.mealPlan === choice.offer.mealPlan,
    );
    const own = amount(choice),
      base = refundable ? amount(refundable) : null;
    return own !== null && base ? Math.round((1 - own / base) * 100) : undefined;
  };

  // The choices and "Select This Rate", on the card and again in "View Details".
  const rates = (inDetails: boolean) => (
    <div className="border-t border-gray-100 pt-4">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
        {t("selectYourRate")}
      </p>
      <div className="space-y-3">
        {shown.map((choice) => {
          const total = amount(choice);
          return (
            <RateOption
              key={choice.offer.publicOfferKey}
              publicOfferKey={choice.offer.publicOfferKey}
              selected={choice === selected}
              onSelect={() => setPicked(choice.offer.publicOfferKey)}
              refundable={choice.text.refundable}
              title={choice.text.name}
              terms={choice.text.terms}
              totalLabel={total === null ? null : money(total, choice.priced!.currency)}
              nightlyLabel={
                total === null
                  ? null
                  : money(
                      Math.round((total / Math.max(nights, 1)) * 100) / 100,
                      choice.priced!.currency,
                    )
              }
              discountPercent={discount(choice)}
              unavailable={
                choice.unavailable ||
                (!choice.bookable && !soldOut && !tooSmall && pricesState === "ready")
              }
              loading={pricesState === "loading"}
              disabled={soldOut}
            />
          );
        })}
      </div>
      {promoCode && selected?.priced && !selected.priced.promoApplied && (
        <p className="text-xs text-gray-500 mt-2">{t("promoNotApplied", { code: promoCode })}</p>
      )}
      <button
        type="button"
        data-testid={inDetails ? undefined : `select-rate-${room.roomTypeId}`}
        onClick={() => selected && onSelect(selected.offer.publicOfferKey, roomCount)}
        disabled={!selected || tooSmall}
        className="w-full mt-4 py-3 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary-600"
      >
        {soldOut
          ? t("soldOut")
          : tooSmall || (prices && !selected)
            ? t("notAvailable")
            : t("selectThisRate")}
      </button>
      {tooSmall && room.occupancy && (
        <p className="text-sm mt-3 text-gray-600">
          {childGuests > 0 && room.occupancy.maxChildren === 0
            ? t("noChildren")
            : t("tooManyGuests", { count: room.occupancy.maxGuests })}
        </p>
      )}
      {/* Free rooms but no choice priced for the stay: say why the button reads "Not available". */}
      {prices && !selected && !soldOut && !tooSmall && (
        <p className="text-sm mt-3 text-gray-600">{t("notBookableForDates")}</p>
      )}
      {/* Rooms left only matter when a choice can be booked; never beside "Not available" (VAY-2319). */}
      {!soldOut && selected && prices?.roomsLeft != null && (
        <p
          className={`text-sm mt-3 flex items-center gap-1.5 font-medium ${prices.roomsLeft === 1 ? "text-red-700" : "text-amber-800"}`}
        >
          <span
            className={`w-2 h-2 rounded-full ${prices.roomsLeft === 1 ? "bg-red-500" : "bg-amber-500"}`}
          />
          {prices.roomsLeft === 1
            ? tc("lastRoomLeft")
            : tc("onlyLeft", { count: prices.roomsLeft })}
        </p>
      )}
    </div>
  );

  return (
    <div
      data-testid={`room-card-${room.roomTypeId}`}
      className={`bg-white border border-gray-200 rounded-2xl overflow-hidden transition-all ${soldOut ? "opacity-60" : "hover:shadow-lg"}`}
    >
      <div className="flex flex-col md:flex-row">
        <div
          className={`relative w-full h-64 md:w-[420px] md:min-h-[320px] md:h-auto flex-shrink-0 overflow-hidden ${images.length ? "" : "bg-gray-100 flex items-center justify-center"} cursor-pointer`}
          onClick={onView}
        >
          {images.length ? (
            <Image
              src={images[imageIndex]!.url}
              alt={images[imageIndex]!.alt ?? room.name}
              fill
              className="object-cover"
              sizes={bookingImageSizes.roomCard}
            />
          ) : (
            <svg
              className="w-14 h-14 text-gray-400"
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
          {soldOut && (
            <div className="absolute inset-0 bg-black/30 z-20 flex items-center justify-center">
              <span className="bg-white text-gray-900 text-sm font-bold px-5 py-2 rounded-full shadow">
                {t("soldOut")}
              </span>
            </div>
          )}
          {images.length > 1 && (
            <>
              {(["previous", "next"] as const).map((direction) => (
                <button
                  key={direction}
                  type="button"
                  aria-label={t(`gallery.${direction === "previous" ? "previous" : "next"}`)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setImageIndex(
                      (imageIndex + (direction === "next" ? 1 : images.length - 1)) % images.length,
                    );
                  }}
                  className={`absolute ${direction === "previous" ? "left-3" : "right-3"} top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50 transition-colors z-10`}
                >
                  <svg
                    className="w-4 h-4 text-gray-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d={direction === "next" ? "M9 5l7 7-7 7" : "M15 19l-7-7 7-7"}
                    />
                  </svg>
                </button>
              ))}
              <div className="absolute bottom-3 left-3 right-3 flex gap-1.5 z-10 overflow-x-auto">
                {images.map((image, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-label={image.alt ?? room.name}
                    onClick={(e) => {
                      e.stopPropagation();
                      setImageIndex(i);
                    }}
                    className={`relative h-12 w-16 rounded-md overflow-hidden border-2 transition-colors flex-shrink-0 ${i === imageIndex ? "border-white" : "border-transparent opacity-70 hover:opacity-100"}`}
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
            </>
          )}
        </div>

        <div className="flex-1 p-5 flex flex-col">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-2">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-xl font-bold text-gray-900">
                  {roomCount > 1 && <span className="text-primary-600">{roomCount}× </span>}
                  {room.name}
                </h3>
                {room.category && (
                  <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 border border-primary-200">
                    {room.category}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4 text-sm text-gray-500 mt-1">
                {room.size && (
                  <span className="flex items-center gap-1">
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                      />
                    </svg>
                    {room.size.value} m&sup2;
                  </span>
                )}
                {room.occupancy && (
                  <span className="flex items-center gap-1">
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                    {t("upToGuests", { count: room.occupancy.maxGuests })}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onView}
              className="flex items-center gap-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-full px-4 py-1.5 hover:bg-gray-50 transition-colors flex-shrink-0"
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
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              {t("viewDetails")}
            </button>
          </div>

          {room.amenities && room.amenities.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {room.amenities.slice(0, 4).map((amenity) => (
                <span
                  key={amenity}
                  className="inline-flex items-center gap-1.5 text-sm text-gray-700 border border-gray-200 px-3 py-1 rounded-full"
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
                  {amenity}
                </span>
              ))}
              {room.amenities.length > 4 && (
                <span className="inline-flex items-center text-sm text-gray-500 border border-gray-200 px-3 py-1 rounded-full">
                  {tc("more", { count: room.amenities.length - 4 })}
                </span>
              )}
            </div>
          )}

          {rates(false)}
        </div>
      </div>
      {detailsOpen && (
        <RoomDetailModal
          room={room}
          roomCount={roomCount}
          soldOut={soldOut}
          onClose={() => setDetailsOpen(false)}
        >
          {rates(true)}
        </RoomDetailModal>
      )}
    </div>
  );
}
