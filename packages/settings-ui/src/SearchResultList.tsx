import type { MouseEvent, ReactNode } from "react";
import { cn } from "./cn";

/** What a result opens; it picks the icon and the tile colour. */
export type SearchResultKind =
  | "page"
  | "setting"
  | "reservation"
  | "room"
  | "dashboard"
  | "design"
  | "addon"
  | "promo"
  | "module"
  | "location"
  | "guest";

export interface SearchResult {
  id: string;
  label: string;
  description?: string;
  category: string;
  kind: SearchResultKind;
  href: string;
  /** A pill after the label, e.g. "2 reservations". */
  badge?: string;
  /** A guest's initials, shown in a round avatar instead of the kind's icon. */
  initials?: string;
  /** What Enter does on the active row, e.g. "Open profile". */
  hint?: string;
}

const TILES: Record<SearchResultKind, string> = {
  page: "bg-violet-50 text-violet-500",
  dashboard: "bg-violet-50 text-violet-500",
  module: "bg-violet-50 text-violet-500",
  setting: "bg-amber-50 text-amber-500",
  location: "bg-amber-50 text-amber-500",
  reservation: "bg-blue-50 text-blue-500",
  promo: "bg-blue-50 text-blue-500",
  room: "bg-emerald-50 text-emerald-500",
  addon: "bg-emerald-50 text-emerald-500",
  design: "bg-pink-50 text-pink-500",
  guest: "bg-[#EEF0FD] text-[#2D3FD3]",
};

const ICONS: Record<SearchResultKind, ReactNode> = {
  page: (
    <>
      <path d="M5 12h14" />
      <path d="m13 18 6-6-6-6" />
    </>
  ),
  setting: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  reservation: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
    </>
  ),
  room: (
    <>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </>
  ),
  dashboard: (
    <>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </>
  ),
  design: (
    <>
      <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
      <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
    </>
  ),
  addon: (
    <>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13" />
      <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
      <path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5" />
    </>
  ),
  promo: (
    <>
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2" />
      <path d="M13 17v2" />
      <path d="M13 11v2" />
    </>
  ),
  module: (
    <>
      <rect width="20" height="12" x="2" y="6" rx="6" />
      <circle cx="16" cy="12" r="2" />
    </>
  ),
  location: (
    <>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  guest: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
    </>
  ),
};

export const searchResultOptionId = (listId: string, index: number) => `${listId}-${index}`;

interface SearchResultListProps {
  /** Listbox id; option ids come from searchResultOptionId(id, index). */
  id: string;
  label: string;
  /** Results of one category must sit next to each other: a header starts each run. */
  results: SearchResult[];
  categoryLabel: (category: string) => string;
  activeIndex: number;
  onActiveChange: (index: number) => void;
  onSelect?: (result: SearchResult, event: MouseEvent<HTMLAnchorElement>) => void;
  /** Larger rows with two-line results, as in the PMS search (VAY-2420). */
  large?: boolean;
}

/** The PMS search result rows, shared by the PMS and Booking Admin searches (VAY-2202). */
export function SearchResultList({
  id,
  label,
  results,
  categoryLabel,
  activeIndex,
  onActiveChange,
  onSelect,
  large = false,
}: SearchResultListProps) {
  return (
    <div id={id} role="listbox" aria-label={label}>
      {results.map((result, index) => (
        <div key={result.id}>
          {(index === 0 || results[index - 1].category !== result.category) && (
            <div
              className={cn(
                "font-semibold uppercase",
                large
                  ? "px-5 pt-3.5 pb-2 text-xs tracking-[0.06em] text-[#5B6474]"
                  : "px-4 pt-3 pb-1.5 text-[11px] text-gray-400 tracking-wide",
              )}
            >
              {categoryLabel(result.category)}
            </div>
          )}
          <a
            id={searchResultOptionId(id, index)}
            data-result-index={index}
            role="option"
            aria-selected={index === activeIndex}
            href={result.href}
            onMouseEnter={() => onActiveChange(index)}
            onClick={(event) => {
              // Modified clicks keep the browser's own handling (new tab, new window).
              if (!onSelect || event.button !== 0) return;
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              onSelect(result, event);
            }}
            className={cn(
              "w-full flex items-center text-left transition-colors",
              large ? "px-5 py-2.5 gap-3.5" : "px-4 py-2.5 gap-3",
              index === activeIndex
                ? large
                  ? "bg-[#EEF0FD]"
                  : "bg-primary-50"
                : "hover:bg-gray-50",
            )}
          >
            {result.initials ? (
              <span
                aria-hidden="true"
                className={cn(
                  "rounded-full flex items-center justify-center shrink-0 font-semibold text-[#2D3FD3]",
                  large ? "w-10 h-10 text-sm" : "w-7 h-7 text-[11px]",
                  index === activeIndex ? "bg-white" : "bg-[#EEF0FD]",
                )}
              >
                {result.initials}
              </span>
            ) : (
              <span
                className={cn(
                  "flex items-center justify-center shrink-0",
                  large ? "w-10 h-10 rounded-[10px]" : "w-7 h-7 rounded-lg",
                  TILES[result.kind],
                )}
              >
                <svg
                  className={large ? "w-[18px] h-[18px]" : "w-3.5 h-3.5"}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {ICONS[result.kind]}
                </svg>
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className={cn(
                    "block min-w-0 truncate",
                    large
                      ? cn(
                          "font-semibold text-gray-900",
                          result.kind === "guest" ? "text-[15px]" : "text-sm",
                        )
                      : "text-[13px] font-medium text-gray-900",
                  )}
                >
                  {result.label}
                </span>
                {result.badge && (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-px text-xs font-semibold text-[#344054]",
                      index === activeIndex ? "bg-white" : "bg-gray-100",
                    )}
                  >
                    {result.badge}
                  </span>
                )}
              </span>
              {result.description && (
                <span
                  className={cn(
                    "block truncate",
                    large ? "text-[13px] text-[#5B6474]" : "text-[11px] text-gray-400",
                  )}
                >
                  {result.description}
                </span>
              )}
            </span>
            {index === activeIndex && result.hint && (
              <span
                aria-hidden="true"
                className="text-xs border border-[#C7CDF7] bg-white rounded-md px-2 py-0.5 text-[#2D3FD3] leading-none shrink-0 whitespace-nowrap"
              >
                {result.hint} ↵
              </span>
            )}
            {index === activeIndex && !result.hint && (
              <kbd
                aria-hidden="true"
                className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 bg-gray-50 text-gray-400 leading-none shrink-0"
              >
                ↵
              </kbd>
            )}
          </a>
        </div>
      ))}
    </div>
  );
}
