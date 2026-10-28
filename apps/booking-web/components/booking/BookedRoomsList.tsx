"use client";

import { useLocale, useTranslations } from "next-intl";
import { bookedMeal } from "@/lib/bookedMeal";
import { choiceKeys, choiceText } from "@/lib/roomChoices";
import type { BookedRoom } from "@/lib/types";
import { resolveLocale } from "@/lib/utils";
import type { PricingOffer } from "@/services/api/replacementOffers";

/** A booked room's meal in plain words, "No meals included" for room only (VAY-2360 D7), and, when
 * asked, its cancellation terms (VAY-2320). */
export function useBookedRoomLine() {
  const tc2 = useTranslations("confirmation");
  const th = useTranslations("home");
  const locale = useLocale();
  const formatDate = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(resolveLocale(locale), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return (
    room: BookedRoom,
    { checkIn, timezone, terms }: { checkIn: string; timezone?: string; terms: boolean },
  ) => {
    const rate =
      terms && room.mealPlan
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
    const meal = bookedMeal(room.mealPlan, {
      noMeals: tc2("noMeals"),
      meal: (plan) => th(`choice.meal.${plan}`),
    });
    // A booked stay's free cancellation that is over has simply ended (VAY-2392).
    const cancellation = rate?.cancellationPassed
      ? th("choice.freeEnded")
      : rate?.cancellationTerms;
    return [meal, cancellation].filter(Boolean).join(" · ");
  };
}

/** VAY-2320: a booking's rooms, each with its own type, guests and terms (confirmation and My
 * booking). */
export default function BookedRoomsList({
  rooms,
  checkIn,
  timezone,
  labelClass,
  terms = true,
}: {
  rooms: BookedRoom[];
  checkIn: string;
  timezone?: string;
  /** The page's small caps label style. */
  labelClass: string;
  /** Each room's cancellation terms: off where the confirmation page has its own line for them. */
  terms?: boolean;
}) {
  const t = useTranslations("groupRooms");
  const tc = useTranslations("common");
  const roomLine = useBookedRoomLine();
  return (
    <div className="flex flex-col gap-3" data-testid="booked-rooms">
      <div className="flex justify-between gap-4">
        <span className={labelClass}>{t("yourRooms", { count: rooms.length })}</span>
        <span className={`${labelClass} hidden sm:inline`}>{tc("guests")}</span>
      </div>
      {rooms.map((room, index) => {
        const line = roomLine(room, { checkIn, timezone, terms });
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
              {line && <p className="text-sm text-gray-600">{line}</p>}
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
