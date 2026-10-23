"use client";

import { useLocale, useTranslations } from "next-intl";
import { choiceKeys, choiceText } from "@/lib/roomChoices";
import type { BookedRoom } from "@/lib/types";
import { resolveLocale } from "@/lib/utils";
import type { PricingOffer } from "@/services/api/replacementOffers";

/** VAY-2320: a booking's rooms, each with its own type, guests and terms (confirmation and My
 * booking). */
export default function BookedRoomsList({
  rooms,
  checkIn,
  timezone,
  labelClass,
}: {
  rooms: BookedRoom[];
  checkIn: string;
  timezone?: string;
  /** The page's small caps label style. */
  labelClass: string;
}) {
  const t = useTranslations("groupRooms");
  const th = useTranslations("home");
  const tc = useTranslations("common");
  const locale = useLocale();
  const formatDate = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(resolveLocale(locale), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return (
    <div className="flex flex-col gap-3" data-testid="booked-rooms">
      <div className="flex justify-between gap-4">
        <span className={labelClass}>{t("yourRooms", { count: rooms.length })}</span>
        <span className={`${labelClass} hidden sm:inline`}>{tc("guests")}</span>
      </div>
      {rooms.map((room, index) => {
        const rate = room.mealPlan
          ? choiceText(
              choiceKeys([
                {
                  publicOfferKey: "",
                  currency: "",
                  mealPlan: room.mealPlan as PricingOffer["mealPlan"],
                  ...(room.cancellation && { cancellation: room.cancellation }),
                },
              ])[0]!,
              { checkIn, timezone, formatDate },
              th,
            )
          : null;
        const guests = [
          tc("adults", { count: room.adults }),
          ...(room.children ? [tc("children", { count: room.children })] : []),
        ].join(", ");
        return (
          <div
            key={index}
            className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
          >
            <div className="min-w-0">
              <p className="font-semibold text-gray-900 sm:text-[17px]">
                {room.roomName
                  ? t("roomLine", { number: index + 1, room: room.roomName })
                  : t("roomLabel", { number: index + 1 })}
              </p>
              {rate && (
                <p className="text-sm text-gray-600">
                  {[rate.meal, rate.cancellationTerms].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
            <p className="text-sm font-semibold text-gray-800 sm:shrink-0 sm:text-right">
              {guests}
            </p>
          </div>
        );
      })}
    </div>
  );
}
