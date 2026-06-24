"use client";

import { useState } from "react";
import Image from "next/image";
import { Addon, RoomType } from "@/lib/types";

interface MobileStaySummaryLabels {
  title: string;
  checkIn: string;
  checkOut: string;
  duration: string;
  guests: string;
  total: string;
  includesTaxes: string;
  nights: string;
  checkInFrom?: string;
  checkOutBy?: string;
}

interface MobileStaySummaryProps {
  room: RoomType;
  roomCount: number;
  checkIn: string;
  checkOut: string;
  checkInTime?: string;
  checkOutTime?: string;
  nights: number;
  adults: number;
  childGuests: number;
  roomTotal: number;
  grandTotal: number;
  selectedCurrency: string;
  addons: Addon[];
  selectedAddonIds: string[];
  addonQuantities: Record<string, number>;
  addonDates?: Record<string, string[]>;
  promoCode?: string;
  promoDiscountText?: string;
  discountAmount?: number;
  labels: MobileStaySummaryLabels;
  locale: string;
  formatDate: (date: string | Date, locale?: string) => string;
  formatPrice: (amount: number, fromCurrency: string) => string;
  convertAndRound: (amount: number, fromCurrency: string) => number;
}

export default function MobileStaySummary({
  room,
  roomCount,
  checkIn,
  checkOut,
  checkInTime,
  checkOutTime,
  nights,
  adults,
  childGuests,
  roomTotal,
  grandTotal,
  selectedCurrency,
  addons,
  selectedAddonIds,
  addonQuantities,
  addonDates,
  promoCode,
  promoDiscountText,
  discountAmount = 0,
  labels,
  locale,
  formatDate,
  formatPrice,
  convertAndRound,
}: MobileStaySummaryProps) {
  const [expanded, setExpanded] = useState(false);
  const selectedAddons = addons.filter((addon) => selectedAddonIds.includes(addon.id));
  const guestCount = adults + childGuests;

  return (
    <section className="min-[769px]:hidden mb-5 rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="w-full p-4 text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              {labels.title}
            </p>
            <p className="mt-1 truncate text-sm font-bold text-gray-900">
              {roomCount > 1 ? `${roomCount}× ` : ""}
              {room.name}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              {formatDate(checkIn, locale)} - {formatDate(checkOut, locale)}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-base font-bold text-gray-900">
              {formatPrice(grandTotal, selectedCurrency)}
            </p>
            <svg
              className={`ml-auto mt-1 h-4 w-4 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </div>
        </div>
      </button>

      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-4 border-t border-gray-100 p-4">
            <div className="flex gap-3">
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl">
                <Image
                  src={room.images[0]}
                  alt={room.name}
                  fill
                  sizes="64px"
                  className="object-cover"
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900">
                  {roomCount > 1 ? `${roomCount}× ` : ""}
                  {room.name}
                </p>
                <p className="text-xs text-gray-500">
                  {guestCount} {labels.guests.toLowerCase()} · {labels.nights}
                </p>
              </div>
              <p className="shrink-0 text-sm font-semibold text-gray-900">
                {formatPrice(roomTotal, selectedCurrency)}
              </p>
            </div>

            <div className="space-y-2 border-t border-gray-100 pt-4 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-gray-500">{labels.checkIn}</span>
                <span className="text-right font-semibold text-gray-900">
                  {formatDate(checkIn, locale)}
                  {checkInTime && labels.checkInFrom && (
                    <span className="block text-xs font-normal text-gray-500">
                      {labels.checkInFrom}
                    </span>
                  )}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-500">{labels.checkOut}</span>
                <span className="text-right font-semibold text-gray-900">
                  {formatDate(checkOut, locale)}
                  {checkOutTime && labels.checkOutBy && (
                    <span className="block text-xs font-normal text-gray-500">
                      {labels.checkOutBy}
                    </span>
                  )}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-500">{labels.duration}</span>
                <span className="font-semibold text-gray-900">{labels.nights}</span>
              </div>
            </div>

            {selectedAddons.length > 0 && (
              <div className="space-y-2 border-t border-gray-100 pt-4 text-sm">
                {selectedAddons.map((addon) => {
                  const count = addonQuantities[addon.id];
                  const dates = addonDates?.[addon.id];
                  const people = addon.perPerson
                    ? Math.max(1, Math.min(count ?? Math.max(1, adults), Math.max(1, adults)))
                    : 1;
                  const days = addon.perNight
                    ? Math.max(1, Math.min(dates?.length ?? count ?? nights, nights))
                    : 1;
                  const items = !addon.perPerson && !addon.perNight ? Math.max(1, count ?? 1) : 1;
                  const linePrice = convertAndRound(
                    addon.price * people * days * items,
                    addon.currency,
                  );
                  const parts: string[] = [];
                  if (addon.perPerson && people < adults) parts.push(`${people}/${adults}`);
                  if (addon.perNight && days < nights) parts.push(`${days}/${nights}`);
                  if (!addon.perPerson && !addon.perNight && items > 1) parts.push(`×${items}`);
                  const annotation = parts.length ? ` (${parts.join(" · ")})` : "";
                  return (
                    <div key={addon.id} className="flex justify-between gap-4">
                      <span className="text-gray-500">
                        {addon.name}
                        {annotation}
                      </span>
                      <span className="font-semibold text-gray-900">
                        {formatPrice(linePrice, selectedCurrency)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {!!promoCode && !!promoDiscountText && discountAmount > 0 && (
              <div className="flex justify-between gap-4 border-t border-gray-100 pt-4 text-sm">
                <span className="font-medium text-primary-600">
                  Promo {promoCode}
                  {promoDiscountText}
                </span>
                <span className="font-semibold text-primary-600">
                  -{formatPrice(discountAmount, selectedCurrency)}
                </span>
              </div>
            )}

            <div className="flex justify-between gap-4 border-t border-gray-100 pt-4">
              <span className="text-base font-bold text-gray-900">{labels.total}</span>
              <div className="text-right">
                <p className="text-lg font-bold text-gray-900">
                  {formatPrice(grandTotal, selectedCurrency)}
                </p>
                <p className="text-xs text-gray-500">{labels.includesTaxes}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
