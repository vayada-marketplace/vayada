"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { bookingsService } from "@/services/bookings";
import { roomsService, RoomType } from "@/services/rooms";
import { useTranslation } from "@/lib/i18n";
import { SearchResultList, type SearchResult } from "@vayada/settings-ui";

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
    href: "/settings/guest-flows#check-in",
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
  const { t } = useTranslation();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rooms, setRooms] = useState<RoomType[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);

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

      // Server-side booking search
      let bookingResults: SearchResult[] = [];
      try {
        const res = await bookingsService.list({ search: query.trim(), limit: 5 });
        bookingResults = res.bookings.map((b) => ({
          id: b.id,
          label: `${b.guestFirstName} ${b.guestLastName}`,
          description: `${b.bookingReference} · ${b.roomName} · ${b.checkIn}`,
          category: "reservation",
          kind: "reservation",
          href: `/bookings/${b.id}`,
        }));
      } catch {
        // Silently handle — rooms will still show
      }

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

      setResults([...pageResults, ...settingResults, ...bookingResults, ...roomResults]);
      setActiveIndex(0);
    }, 250);

    return () => clearTimeout(timer);
  }, [query, rooms, t]);

  const navigate = useCallback(
    (result: SearchResult) => {
      onClose();
      router.push(result.href);
    },
    [onClose, router],
  );

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
        className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 h-12 border-b border-gray-100">
          <svg
            className="w-4 h-4 text-gray-400 shrink-0"
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
            className="flex-1 text-sm text-gray-900 placeholder:text-gray-400 outline-none bg-transparent"
          />
          <kbd className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 bg-gray-50 text-gray-400 leading-none">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto">
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
      </div>
    </div>
  );
}
