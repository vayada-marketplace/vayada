"use client";

import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { resolveLocale } from "@/lib/utils";
import type { SummaryRoom } from "./StaySummary";

/** VAY-2495: the stay in one small card at the top of a phone's details step: a photo, the room
 * and its rate, the dates, nights and guests, and Edit back to the rooms (a tap anywhere on the
 * card, as in Timo's boards). Wide screens have the "Your stay" card beside the form instead. */
export default function StayBrief({
  rooms,
  checkIn,
  checkOut,
  guests,
  image,
  onEdit,
  locked = false,
}: {
  rooms: readonly SummaryRoom[];
  checkIn: string;
  checkOut: string;
  guests: string;
  /** The photo when the room has none (the hotel's first). */
  image?: string;
  onEdit: () => void;
  /** A booking attempt is open: the stay can't change until it settles. */
  locked?: boolean;
}) {
  const t = useTranslations("reviewPay");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(checkIn) && /^\d{4}-\d{2}-\d{2}$/.test(checkOut);
  // The browser's own range in the page's language ("Fri 13 Nov – Sat 14 Nov").
  const dates = dated
    ? new Intl.DateTimeFormat(resolveLocale(locale), {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).formatRange(new Date(`${checkIn}T00:00:00Z`), new Date(`${checkOut}T00:00:00Z`))
    : "";
  const single = rooms.length === 1 ? rooms[0] : undefined;
  const title = single
    ? [single.name, single.choice].filter(Boolean).join(" · ")
    : `${tCommon("room", { count: rooms.length })} · ${rooms.map((room) => room.name).join(", ")}`;
  const photo = rooms.find((room) => room.image)?.image ?? image;
  return (
    <div
      data-testid="stay-brief"
      className="relative mb-5 flex items-center gap-3 rounded-[14px] border border-gray-200 bg-gray-50 p-2.5 lg:hidden"
    >
      {photo && (
        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[10px] bg-gray-100">
          <Image src={photo} alt="" fill className="object-cover" sizes="48px" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-bold text-gray-900">{title}</p>
        <p className="mt-0.5 text-sm text-gray-600">
          {[
            dates,
            Number.isFinite(nights) && nights > 0 ? t("stay.nights", { count: nights }) : "",
            guests,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      {/* Its tap area covers the whole card. */}
      <button
        type="button"
        aria-label={t("stay.editStay")}
        disabled={locked}
        onClick={onEdit}
        className="shrink-0 rounded-[14px] text-sm font-semibold text-gray-900 underline underline-offset-2 after:absolute after:inset-0 after:rounded-[14px] focus:outline-none focus-visible:after:ring-2 focus-visible:after:ring-primary-500 disabled:opacity-40"
      >
        {t("stay.edit")}
      </button>
    </div>
  );
}
