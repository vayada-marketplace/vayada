"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { RoomType } from "@/lib/types";
import { useCurrency } from "@/contexts/CurrencyContext";
import { getNonRefundableRate } from "@/lib/constants/booking";
import { getFreeCancellationDays, isFlexibleCancellationExpired } from "@/lib/constants/booking";
import RateOption from "./RateOption";

interface RoomCardProps {
  room: RoomType;
  nights: number;
  totalGuests: number;
  imageIndex: number;
  checkIn: string;
  hotelTimezone?: string;
  onChangeImageIndex: (index: number) => void;
  selectedRate: "flexible" | "nonrefundable" | null;
  onChangeSelectedRate: (next: "flexible" | "nonrefundable") => void;
  onView: () => void;
  onSelectRate: (rateType: "flexible" | "nonrefundable", requiredRooms: number) => void;
  active?: boolean;
  highlighted?: boolean;
  onHover?: (hovered: boolean) => void;
  onSelectCard?: () => void;
}

export default function RoomCard({
  room,
  nights,
  totalGuests,
  imageIndex,
  checkIn,
  hotelTimezone,
  onChangeImageIndex,
  selectedRate,
  onChangeSelectedRate,
  onView,
  onSelectRate,
  active = false,
  highlighted = false,
  onHover,
  onSelectCard,
}: RoomCardProps) {
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency();

  const minRequiredRooms = Math.max(1, Math.ceil(totalGuests / room.maxOccupancy));
  const soldOut = room.remainingRooms < minRequiredRooms;
  const [selectedRooms, setSelectedRooms] = useState(minRequiredRooms);
  const roomQuantityOptions = Array.from(
    { length: Math.max(0, room.remainingRooms - minRequiredRooms + 1) },
    (_, index) => minRequiredRooms + index,
  );
  const displayRooms = soldOut ? minRequiredRooms : selectedRooms;
  const combinedCapacity = room.maxOccupancy * displayRooms;
  const showRoomQuantity = !soldOut && (roomQuantityOptions.length > 1 || displayRooms > 1);

  useEffect(() => {
    setSelectedRooms((value) => {
      if (room.remainingRooms < minRequiredRooms) return minRequiredRooms;
      return Math.min(Math.max(value, minRequiredRooms), room.remainingRooms);
    });
  }, [minRequiredRooms, room.remainingRooms]);

  // Per-night rates rounded in the displayed currency so nightly × nights matches
  // the shown total (avoids "$25 × 3 = $76" conversion rounding mismatch).
  const flexibleNightly = convertAndRound(room.baseRate, room.currency);
  const flexibleTotal = flexibleNightly * nights * displayRooms;
  const nonRefundableNightlyBase = getNonRefundableRate(room.baseRate, room.nonRefundableRate);
  const nonRefundableNightly = convertAndRound(nonRefundableNightlyBase, room.currency);
  const nonRefundableTotal = nonRefundableNightly * nights * displayRooms;
  const discount = Math.round((1 - nonRefundableNightlyBase / room.baseRate) * 100);
  const hasLastMinuteDeal = !!(
    room.lastMinuteDiscountPercent && room.lastMinuteDiscountPercent > 0
  );
  const originalFlexibleTotal =
    hasLastMinuteDeal && room.originalRate
      ? convertAndRound(room.originalRate, room.currency) * nights * displayRooms
      : null;

  const partialRefundTiers =
    room.partialRefundTiers && room.partialRefundTiers.length > 0
      ? [...room.partialRefundTiers].sort((a, b) => b.minDaysBeforeCheckIn - a.minDaysBeforeCheckIn)
      : null;
  const flexibleExpired = isFlexibleCancellationExpired(checkIn, room, hotelTimezone);
  const flexibleDescription = flexibleExpired
    ? t("flexibleNoLongerCancellable")
    : room.flexibleCancellationType === "partial_refund"
      ? partialRefundTiers
        ? t("partialRefundDesc", {
            percent: partialRefundTiers[0].refundPercent,
            days: partialRefundTiers[0].minDaysBeforeCheckIn,
          })
        : t("partialRefundDesc", {
            percent: room.partialRefundAmountPercent ?? 50,
            days: room.partialRefundCancelWindowDays ?? 30,
          })
      : t("flexibleDesc", { days: getFreeCancellationDays(room.cancellationPolicy) });
  // VAY-370: when free cancellation is no longer possible, hide Flexible Rate entirely —
  // unless no Non-Refundable exists, in which case keep Flexible visible with replacement copy.
  const showFlexibleRate =
    room.flexibleRateEnabled !== false && (!flexibleExpired || room.nonRefundableRate == null);
  const hasNonRefundable = room.nonRefundableRate != null;

  const effectiveSelectedRate: "flexible" | "nonrefundable" | null =
    selectedRate === "flexible" && showFlexibleRate
      ? "flexible"
      : selectedRate === "nonrefundable" && hasNonRefundable
        ? "nonrefundable"
        : hasNonRefundable
          ? "nonrefundable"
          : showFlexibleRate
            ? "flexible"
            : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      onClick={onSelectCard}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelectCard?.();
        }
      }}
      className={`bg-white border rounded-2xl overflow-hidden transition-all ${
        active || highlighted
          ? "border-primary-400 shadow-[0_0_0_3px_rgba(99,102,241,0.14)]"
          : "border-gray-200"
      } ${soldOut ? "opacity-60" : "hover:shadow-lg"}`}
    >
      <div className="flex flex-col md:flex-row">
        {/* Image carousel */}
        <div
          className="relative w-full h-64 md:w-[420px] md:min-h-[320px] md:h-auto flex-shrink-0 cursor-pointer overflow-hidden"
          onClick={onView}
        >
          <Image src={room.images[imageIndex]} alt={room.name} fill className="object-cover" />
          {soldOut && (
            <div className="absolute inset-0 bg-black/30 z-20 flex items-center justify-center">
              <span className="bg-white text-gray-900 text-sm font-bold px-5 py-2 rounded-full shadow">
                {t("soldOut")}
              </span>
            </div>
          )}
          {room.images.length > 1 && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onChangeImageIndex(imageIndex === 0 ? room.images.length - 1 : imageIndex - 1);
                }}
                className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50 transition-colors z-10"
              >
                <svg
                  className="w-4 h-4 text-gray-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onChangeImageIndex(imageIndex === room.images.length - 1 ? 0 : imageIndex + 1);
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50 transition-colors z-10"
              >
                <svg
                  className="w-4 h-4 text-gray-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </button>
              <div className="absolute bottom-3 left-3 right-3 flex gap-1.5 z-10 overflow-x-auto">
                {room.images.map((img, i) => (
                  <button
                    key={i}
                    onClick={(e) => {
                      e.stopPropagation();
                      onChangeImageIndex(i);
                    }}
                    className={`relative h-12 w-16 rounded-md overflow-hidden border-2 transition-colors flex-shrink-0 ${i === imageIndex ? "border-white" : "border-transparent opacity-70 hover:opacity-100"}`}
                  >
                    <Image src={img} alt="" fill className="object-cover" />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Details + rates */}
        <div className="flex-1 p-5 flex flex-col">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-2">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-xl font-bold text-gray-900">
                  {displayRooms > 1 && <span className="text-primary-600">{displayRooms}× </span>}
                  {room.name}
                </h3>
                {room.category && (
                  <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 border border-primary-200">
                    {room.category}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4 text-sm text-gray-500 mt-1">
                <span className="flex items-center gap-1">
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                    />
                  </svg>
                  {room.size} m&sup2;
                </span>
                <span className="flex items-center gap-1">
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  {t("upToGuests", { count: combinedCapacity })}
                </span>
              </div>
            </div>
            <button
              onClick={onView}
              className="flex items-center gap-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-full px-4 py-1.5 hover:bg-gray-50 transition-colors flex-shrink-0"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

          <div className="flex flex-wrap gap-2 mb-4">
            {room.features.slice(0, 4).map((feature) => (
              <span
                key={feature}
                className="inline-flex items-center gap-1.5 text-sm text-gray-700 border border-gray-200 px-3 py-1 rounded-full"
              >
                <svg
                  className="w-3.5 h-3.5 text-primary-500 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                {feature}
              </span>
            ))}
            {room.features.length > 4 && (
              <span className="inline-flex items-center text-sm text-gray-500 border border-gray-200 px-3 py-1 rounded-full">
                {tc("more", { count: room.features.length - 4 })}
              </span>
            )}
          </div>

          {hasLastMinuteDeal && (
            <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
              <span className="text-[11px] font-bold bg-amber-500 text-white px-2 py-0.5 rounded">
                -{room.lastMinuteDiscountPercent}%
              </span>
              <span className="text-sm font-medium text-amber-800">Last-minute deal</span>
              {originalFlexibleTotal && (
                <span className="ml-auto text-sm text-gray-400 line-through">
                  {formatPrice(originalFlexibleTotal, selectedCurrency)}
                </span>
              )}
            </div>
          )}

          <div className="border-t border-gray-100 pt-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              {t("selectYourRate")}
            </p>
            {showRoomQuantity && (
              <div
                className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="text-sm font-medium text-gray-700">
                  {tc("room", { count: displayRooms })}
                </span>
                {roomQuantityOptions.length > 1 ? (
                  <select
                    value={selectedRooms}
                    onChange={(event) => setSelectedRooms(Number(event.target.value))}
                    className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm font-semibold text-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-500"
                    aria-label={tc("room", { count: displayRooms })}
                  >
                    {roomQuantityOptions.map((count) => (
                      <option key={count} value={count}>
                        {tc("room", { count })}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-sm font-semibold text-gray-900">{displayRooms}</span>
                )}
              </div>
            )}
            <div className="space-y-3">
              {hasNonRefundable && (
                <RateOption
                  rateType="nonrefundable"
                  selected={effectiveSelectedRate === "nonrefundable"}
                  onSelect={() => onChangeSelectedRate("nonrefundable")}
                  iconType="nonrefundable"
                  title={t("nonRefundableRate")}
                  description={t("nonRefundableDesc")}
                  totalLabel={formatPrice(nonRefundableTotal, selectedCurrency)}
                  nightlyLabel={formatPrice(nonRefundableNightly * displayRooms, selectedCurrency)}
                  discountPercent={discount}
                  soldOut={soldOut}
                />
              )}
              {showFlexibleRate && (
                <RateOption
                  rateType="flexible"
                  selected={effectiveSelectedRate === "flexible"}
                  onSelect={() => onChangeSelectedRate("flexible")}
                  iconType="flexible"
                  title={t("flexibleRate")}
                  description={flexibleDescription}
                  totalLabel={formatPrice(flexibleTotal, selectedCurrency)}
                  nightlyLabel={formatPrice(flexibleNightly * displayRooms, selectedCurrency)}
                  soldOut={soldOut}
                />
              )}
            </div>
            <button
              onClick={() => {
                if (soldOut || !effectiveSelectedRate) return;
                onSelectRate(effectiveSelectedRate, selectedRooms);
              }}
              disabled={soldOut || !effectiveSelectedRate}
              className="w-full mt-4 py-3 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary-600"
            >
              {soldOut ? t("soldOut") : t("selectThisRate")}
            </button>
            {!soldOut && room.remainingRooms <= 3 && (
              <p
                className={`text-sm mt-3 flex items-center gap-1.5 font-medium ${
                  room.remainingRooms === 1 ? "text-red-700" : "text-amber-800"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    room.remainingRooms === 1 ? "bg-red-500" : "bg-amber-500"
                  }`}
                />
                {room.remainingRooms === 1
                  ? tc("lastRoomLeft")
                  : tc("onlyLeft", { count: room.remainingRooms })}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
