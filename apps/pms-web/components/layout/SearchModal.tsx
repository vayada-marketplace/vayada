"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { bookingsService } from "@/services/bookings";
import { guestsService, type GuestSummary } from "@/services/guests";
import { roomsService, RoomType } from "@/services/rooms";
import { useTranslation } from "@/lib/i18n";
import { BOOKING_STATUS_LABEL_KEYS } from "@/lib/constants/statusStyles";
import {
  formatStayDates,
  guestActivity,
  guestInitials,
  localToday,
} from "@/lib/guests/guestDisplay";
import { useGuestsSectionOn } from "@/lib/guests/useGuestsSectionOn";
import { SearchResultList, searchResultOptionId, type SearchResult } from "@vayada/settings-ui";

interface PageEntry {
  id: string;
  labelKey: string;
  sublabelKey: string;
  href: string;
}

interface SettingEntry {
  id: string;
  labelKey: string;
  sublabelKey: string;
  href: string;
  // Lowercase, language-agnostic keywords matched in addition to the
  // translated label/sublabel — e.g. "money" → currency, "arrival" → check-in.
  keywords: string[];
}

const PAGES: PageEntry[] = [
  {
    id: "dashboard",
    labelKey: "layout.sidebar.dashboard",
    sublabelKey: "search.pageDashboardHint",
    href: "/dashboard",
  },
  {
    id: "calendar",
    labelKey: "layout.sidebar.calendar",
    sublabelKey: "search.pageCalendarHint",
    href: "/calendar",
  },
  {
    id: "bookings",
    labelKey: "layout.sidebar.reservations",
    sublabelKey: "search.pageReservationsHint",
    href: "/bookings",
  },
  {
    id: "guests",
    labelKey: "layout.sidebar.guests",
    sublabelKey: "search.pageGuestsHint",
    href: "/guests",
  },
  {
    id: "rooms",
    labelKey: "layout.sidebar.roomsAndRates",
    sublabelKey: "search.pageRoomsHint",
    href: "/rooms",
  },
  {
    id: "channel-manager",
    labelKey: "layout.sidebar.channelManager",
    sublabelKey: "search.pageChannelManagerHint",
    href: "/channel-manager",
  },
  {
    id: "settings",
    labelKey: "layout.sidebar.settings",
    sublabelKey: "search.pageSettingsHint",
    href: "/settings",
  },
];

const SETTINGS: SettingEntry[] = [
  {
    id: "change-language",
    labelKey: "search.settingChangeLanguage",
    sublabelKey: "search.settingChangeLanguageHint",
    href: "/settings/property#language",
    keywords: [
      "language",
      "locale",
      "translate",
      "translation",
      "sprache",
      "idioma",
      "langue",
      "bahasa",
      "语言",
      "язык",
    ],
  },
  {
    id: "change-currency",
    labelKey: "search.settingChangeCurrency",
    sublabelKey: "search.settingChangeCurrencyHint",
    href: "/settings/property#currency",
    keywords: ["currency", "money", "price", "eur", "usd", "gbp", "idr", "fx"],
  },
  {
    id: "property-details",
    labelKey: "search.settingPropertyDetails",
    sublabelKey: "search.settingPropertyDetailsHint",
    href: "/settings/property",
    keywords: [
      "property",
      "property details",
      "property settings",
      "hotel",
      "address",
      "city",
      "country",
      "state",
      "zip",
      "phone",
      "timezone",
      "lat",
      "long",
      "latitude",
      "longitude",
    ],
  },
  {
    id: "calendar-settings",
    labelKey: "search.settingCalendar",
    sublabelKey: "search.settingCalendarHint",
    href: "/settings/calendar",
    keywords: [
      "auto-rearrange",
      "auto rearrange",
      "rearrange",
      "auto-open",
      "auto open",
      "future calendar",
      "calendar settings",
      "calendar auto",
    ],
  },
  {
    id: "checkin-checklist",
    labelKey: "search.settingCheckinChecklist",
    sublabelKey: "search.settingCheckinChecklistHint",
    href: "/settings/check-in#extra-checks",
    keywords: [
      "checklist",
      "check-in checklist",
      "checkin checklist",
      "arrival tasks",
      "guest tasks",
    ],
  },
  {
    id: "checkout-inspection",
    labelKey: "search.settingCheckoutInspection",
    sublabelKey: "search.settingCheckoutInspectionHint",
    href: "/settings/guest-flows#check-out",
    keywords: [
      "checkout inspection",
      "check-out inspection",
      "inspection",
      "departure checklist",
      "room inspection",
    ],
  },
  {
    id: "localization",
    labelKey: "search.settingLocalization",
    sublabelKey: "search.settingLocalizationHint",
    href: "/settings/property#localization",
    keywords: ["localization", "localisation", "locale settings", "regional"],
  },
];

export default function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { locale, t } = useTranslation();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rooms, setRooms] = useState<RoomType[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  // With Guests off in Feature Hub, search leaves out the Guests page and guests (VAY-2423). Read
  // when the header mounts, so the answer is known before anyone types.
  const guestsOn = useGuestsSectionOn();

  // Load room types once (small dataset, OK to filter client-side)
  useEffect(() => {
    if (!open || roomsLoaded) return;
    roomsService
      .list()
      .then((r) => {
        setRooms(r);
        setRoomsLoaded(true);
      })
      .catch(console.error);
  }, [open, roomsLoaded]);

  // Reset state when modal opens
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setResults([]);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Search with debounce
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setActiveIndex(0);
      return;
    }

    const q = query.toLowerCase();
    const timer = setTimeout(async () => {
      // Pages match instantly against the translated label so the user
      // can jump between sections regardless of UI language.
      const pageResults: SearchResult[] = PAGES.filter((p) => {
        if (p.id === "guests" && !guestsOn) return false;
        const label = t(p.labelKey).toLowerCase();
        return label.includes(q) || p.id.includes(q);
      }).map((p) => ({
        id: `page-${p.id}`,
        label: t(p.labelKey),
        description: t(p.sublabelKey),
        category: "page",
        kind: "page",
        href: p.href,
      }));

      // Settings actions match against translated label/sublabel + keywords,
      // so synonyms like "money" or "arrival time" still surface the right setting.
      const settingResults: SearchResult[] = SETTINGS.filter((s) => {
        const label = t(s.labelKey).toLowerCase();
        const sublabel = t(s.sublabelKey).toLowerCase();
        if (label.includes(q) || sublabel.includes(q)) return true;
        return s.keywords.some((k) => k.includes(q) || q.includes(k));
      }).map((s) => ({
        id: `setting-${s.id}`,
        label: t(s.labelKey),
        description: t(s.sublabelKey),
        category: "setting",
        kind: "setting",
        href: s.href,
      }));

      // VAY-2420: the account's guest records, above their reservations. Each search fails on
      // its own, so the other groups still show.
      const today = localToday();
      const statusLabel = (status: string) =>
        BOOKING_STATUS_LABEL_KEYS[status] ? t(BOOKING_STATUS_LABEL_KEYS[status]) : "";
      const [guestResults, bookingResults] = await Promise.all([
        (guestsOn ? guestsService.search(query.trim(), 5) : Promise.resolve<GuestSummary[]>([]))
          .then((guests) =>
            guests.map(
              (guest): SearchResult => ({
                id: `guest-${guest.guestProfileId}`,
                label: `${guest.firstName} ${guest.lastName}`.trim(),
                description: [
                  guest.email,
                  guest.phone,
                  guestActivity(guest.lastCheckIn, today, locale, t),
                ]
                  .filter(Boolean)
                  .join(" · "),
                badge: t(
                  guest.reservations === 1 ? "guests.reservationsOne" : "guests.reservationsMany",
                  { count: guest.reservations },
                ),
                initials: guestInitials(guest.firstName, guest.lastName),
                hint: t("search.openProfile"),
                category: "guest",
                kind: "guest",
                href: `/guests/${guest.guestProfileId}`,
              }),
            ),
          )
          .catch(() => [] as SearchResult[]),
        bookingsService
          .list({ search: query.trim(), limit: 5 })
          .then((res) =>
            res.bookings.map(
              (b): SearchResult => ({
                id: b.id,
                label: `${b.guestFirstName} ${b.guestLastName}`,
                description: [
                  b.bookingReference,
                  formatStayDates(b.checkIn, b.checkOut, locale),
                  statusLabel(b.awaitingPaymentConfirmation ? "awaiting_payment" : b.status),
                ]
                  .filter(Boolean)
                  .join(" · "),
                category: "reservation",
                kind: "reservation",
                href: `/bookings/${b.id}`,
              }),
            ),
          )
          .catch(() => [] as SearchResult[]),
      ]);

      // Client-side room filtering (small dataset)
      const roomResults: SearchResult[] = rooms
        .filter((r) => r.name?.toLowerCase().includes(q) || r.category?.toLowerCase().includes(q))
        .slice(0, 5)
        .map((r) => ({
          id: r.id,
          label: r.name,
          description: `${r.category} · ${r.totalRooms} rooms · €${r.baseRate}/night`,
          category: "room",
          kind: "room",
          href: `/rooms`,
        }));

      setResults([
        ...pageResults,
        ...settingResults,
        ...guestResults,
        ...bookingResults,
        ...roomResults,
      ]);
      setActiveIndex(0);
    }, 250);

    return () => clearTimeout(timer);
  }, [query, rooms, locale, t, guestsOn]);

  const navigate = useCallback(
    (result: SearchResult) => {
      onClose();
      router.push(result.href);
    },
    [onClose, router],
  );

  // The chosen row stays in view while the arrow keys move through a long list.
  useEffect(() => {
    document
      .getElementById(searchResultOptionId("pms-search-results", activeIndex))
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results[activeIndex]) {
        e.preventDefault();
        navigate(results[activeIndex]);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, results, activeIndex, navigate, onClose]);

  if (!open) return null;

  const CATEGORY_LABELS: Record<string, string> = {
    guest: t("search.categoryGuests"),
    page: t("search.categoryPages"),
    setting: t("search.categorySettings"),
    reservation: t("search.categoryReservations"),
    room: t("search.categoryRoomTypes"),
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[20vh]"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Modal */}
      <div
        role="dialog"
        aria-label={t("search.placeholder")}
        className="relative w-full max-w-[680px] mx-4 bg-white rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[#EAECF0]">
          <svg
            className="w-5 h-5 text-[#5B6474] shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search.placeholder")}
            className="flex-1 min-w-0 text-lg text-[#101828] placeholder:text-gray-400 outline-none bg-transparent"
          />
          <kbd className="text-xs border border-[#D0D5DD] rounded-md px-2 py-0.5 text-[#475467] leading-none">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[min(60vh,420px)] overflow-y-auto py-2.5">
          {query.trim() && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              {t("search.noResults", { query })}
            </div>
          )}

          <SearchResultList
            id="pms-search-results"
            label={t("search.placeholder")}
            results={results}
            categoryLabel={(category) => CATEGORY_LABELS[category] || category}
            large
            activeIndex={activeIndex}
            onActiveChange={setActiveIndex}
            onSelect={(result, event) => {
              event.preventDefault();
              navigate(result);
            }}
          />

          {!query.trim() && (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              {t("search.startTyping")}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-x-[18px] gap-y-1 px-5 py-3 border-t border-[#EAECF0] text-xs text-[#5B6474]">
          <span>{t("search.hintNavigate")}</span>
          <span>{t("search.hintOpen")}</span>
          <span>{t("search.guestsMatched")}</span>
        </div>
      </div>
    </div>
  );
}
