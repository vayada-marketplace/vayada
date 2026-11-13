"use client";

import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { resolveLocale } from "@/lib/utils";
import type { SummaryRoom } from "./StaySummary";

/** VAY-2495: the stay in one small card at the top of a phone's details step: a photo, the room
 * and its rate, the dates, nights and guests, and Edit back to the rooms. Wide screens have the
 * "Your stay" card beside the form instead. */
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
      className="mb-6 flex items-center gap-3 rounded-2xl border border-gray-200 bg-white p-3 lg:hidden"
    >
      {photo && (
        <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-gray-100">
          <Image src={photo} alt="" fill className="object-cover" sizes="56px" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 truncate text-[15px] font-semibold text-gray-900">{title}</p>
          <button
            type="button"
            aria-label={t("stay.editStay")}
            disabled={locked}
            onClick={onEdit}
            className="shrink-0 text-sm font-semibold text-gray-900 underline underline-offset-2 disabled:opacity-40"
          >
            {t("stay.edit")}
          </button>
        </div>
        <p className="mt-0.5 text-[13px] text-gray-600">
          {[
            dates,
            Number.isFinite(nights) && nights > 0 ? t("stay.nights", { count: nights }) : "",
            guests,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
    </div>
  );
}
