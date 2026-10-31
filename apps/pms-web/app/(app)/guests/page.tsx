"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRightIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { PageHeader } from "@/components/layout/PageHeader";
import { useTranslation } from "@/lib/i18n";
import { guestActivity, guestInitials, localToday } from "@/lib/guests/guestDisplay";
import { guestDataSettingsService, guestsService, type GuestSummary } from "@/services/guests";

// The API returns at most 100; search finds the others.
const LIMIT = 100;

/** VAY-2420: the account's guests, newest stay first, with search (D8: a simple list). */
export default function GuestsPage() {
  const { locale, t } = useTranslation();
  const [query, setQuery] = useState("");
  const [guests, setGuests] = useState<GuestSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Settings › Guest data can switch the phone off for the account (VAY-2420).
  const [phoneOff, setPhoneOff] = useState(false);
  useEffect(() => {
    guestDataSettingsService
      .get()
      .then((loaded) => setPhoneOff(loaded.settings.fields.phone === "off"))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(
      () => {
        guestsService
          .search(query, LIMIT)
          .then((list) => {
            if (!alive) return;
            setGuests(list);
            setFailed(false);
          })
          .catch(() => alive && setFailed(true));
      },
      query ? 250 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  const today = localToday();

  return (
    <div className="p-4 md:p-6">
      {/* Left-aligned like every PMS page, so the title doesn't jump between pages (VAY-2423). */}
      <div className="max-w-[960px]">
        <PageHeader
          title={t("guests.title")}
          subtitle={t("guests.subtitle")}
          className="mb-4 md:mb-5"
        />
        <label className="flex items-center gap-2 h-10 px-3 rounded-[10px] border border-[#D0D5DD] bg-white">
          <MagnifyingGlassIcon className="w-4 h-4 text-[#5B6474] shrink-0" aria-hidden="true" />
          <span className="sr-only">{t("guests.searchLabel")}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("guests.searchPlaceholder")}
            className="flex-1 min-w-0 text-sm text-[#101828] outline-none bg-transparent"
          />
        </label>

        <div className="mt-4 bg-white border border-[#E4E7EC] rounded-2xl overflow-hidden">
          {failed ? (
            <p className="px-6 py-10 text-center text-sm text-red-600">
              {t("guests.failedToLoad")}
            </p>
          ) : guests === null ? (
            <p className="px-6 py-10 text-center text-sm text-gray-400">{t("common.loading")}</p>
          ) : guests.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-[#5B6474]">
              {query.trim() ? t("guests.noMatches", { query: query.trim() }) : t("guests.empty")}
            </p>
          ) : (
            <ul>
              {guests.map((guest) => (
                <li key={guest.guestProfileId} className="border-b border-[#EAECF0] last:border-0">
                  <Link
                    href={`/guests/${guest.guestProfileId}`}
                    className="flex items-center gap-3.5 px-6 py-3.5 hover:bg-gray-50"
                  >
                    <span
                      aria-hidden="true"
                      className="w-10 h-10 rounded-full bg-[#EEF0FD] text-[#2D3FD3] text-sm font-semibold flex items-center justify-center shrink-0"
                    >
                      {guestInitials(guest.firstName, guest.lastName)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="text-[15px] font-semibold text-[#101828] truncate">
                          {`${guest.firstName} ${guest.lastName}`.trim()}
                        </span>
                        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-px text-xs font-semibold text-[#344054]">
                          {t(
                            guest.reservations === 1
                              ? "guests.reservationsOne"
                              : "guests.reservationsMany",
                            { count: guest.reservations },
                          )}
                        </span>
                      </span>
                      <span className="block text-[13px] text-[#475467] truncate">
                        {[
                          guest.email,
                          phoneOff ? null : guest.phone,
                          guestActivity(guest.lastCheckIn, today, locale, t),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <ChevronRightIcon className="w-[18px] h-[18px] text-[#98A2B3] shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        {guests?.length === LIMIT && (
          <p className="mt-3 text-xs text-[#5B6474]">{t("guests.listLimit", { count: LIMIT })}</p>
        )}
      </div>
    </div>
  );
}
