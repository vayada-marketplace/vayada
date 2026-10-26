"use client";

import Link from "next/link";
import { CheckIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import { checkinPrimaryButton, checkinSecondaryButton } from "./CheckinStepCard";

/** After check-in: the rooms are occupied; open items stay on the booking (VAY-2373, p-16-0). */
export function CheckinDone({
  title,
  facts,
  rooms,
  openGuests,
  otherFlags,
  bookingHref,
  next,
}: {
  title: string;
  facts: string;
  rooms: Array<{ key: string; unit: string; type: string }>;
  /** "3 guests still need registration details" and who, when any. */
  openGuests: { title: string; detail: string } | null;
  /** Other open items: extra checks, keys. */
  otherFlags: string[];
  bookingHref: string;
  next: { href: string; label: string };
}) {
  const { t } = useTranslation();
  return (
    <div className="p-4 md:p-6">
      <div className="mx-auto mt-4 max-w-2xl rounded-2xl border border-gray-200 bg-white p-6 md:mt-10 md:p-9">
        <span
          aria-hidden="true"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-green-600 text-white"
        >
          <CheckIcon className="h-8 w-8" strokeWidth={2.5} />
        </span>
        <h1 className="mt-5 text-3xl font-extrabold text-gray-900">{title}</h1>
        <p className="mt-1 text-[15px] text-gray-600">{facts}</p>
        <ul className="mt-5 divide-y divide-gray-200 border-y border-gray-200">
          {rooms.map((room) => (
            <li key={room.key} className="flex items-center gap-3 py-3">
              <span className="text-[15px] font-bold text-gray-900">{room.unit}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-gray-600">{room.type}</span>
              <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">
                {t("checkIn.flow.done.occupied")}
              </span>
            </li>
          ))}
        </ul>
        {(openGuests || otherFlags.length > 0) && (
          <div className="mt-5 flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-sm font-bold text-amber-700"
            >
              !
            </span>
            <div className="min-w-0 text-[15px] text-amber-900">
              {openGuests && (
                <>
                  <p className="font-bold">{openGuests.title}</p>
                  <p>{openGuests.detail}</p>
                </>
              )}
              {otherFlags.length > 0 && (
                <ul className={`list-disc pl-5 ${openGuests ? "mt-2" : ""}`}>
                  {otherFlags.map((flag) => (
                    <li key={flag}>{flag}</li>
                  ))}
                </ul>
              )}
              <p className="mt-1">{t("checkIn.flow.done.openItems")}</p>
            </div>
          </div>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href={next.href} className={checkinPrimaryButton}>
            {next.label}
          </Link>
          <Link href={bookingHref} className={checkinSecondaryButton}>
            {t("checkIn.flow.done.openBooking")}
          </Link>
        </div>
      </div>
    </div>
  );
}
