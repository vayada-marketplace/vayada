"use client";

import { useEffect, useRef, useState } from "react";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { SearchResultList, searchResultOptionId } from "@vayada/settings-ui";
import { useTranslation } from "@/lib/i18n";
import {
  loadSearchAccess,
  matchesSearch,
  SEARCH_ENTRIES,
  type SearchAccess,
} from "./navigationSearchEntries";

export default function NavigationSearch({ hotelId }: { hotelId?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [access, setAccess] = useState<SearchAccess | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Titles and descriptions are both searched, as in the PMS search (VAY-2202).
  const results = SEARCH_ENTRIES.filter(
    ([label, , , permission, key, hint]) =>
      access?.has(permission) && matchesSearch(query, `${label} ${t(key)} ${t(hint)}`),
  ).map(([, href, category, , key, hint, kind]) => ({
    id: href,
    label: t(key),
    description: t(hint),
    category,
    kind,
    href,
  }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        input.current?.focus();
      }
      if (event.key === "Escape") setOpen(false);
    };
    const onOutside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAccess(null);
    setActive(0);
    if (hotelId)
      void loadSearchAccess(hotelId).then((next) => {
        if (!cancelled) setAccess(next);
      });
    else setAccess(new Set());
    return () => {
      cancelled = true;
    };
  }, [open, hotelId]);

  useEffect(() => {
    root.current
      ?.querySelector(`[data-result-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      ref={root}
      className="mx-2 min-w-0 flex-1 max-w-sm sm:relative md:min-w-[12rem]"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1">
        <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-gray-400" />
        <input
          ref={input}
          role="combobox"
          aria-label={t("admin.searchPagesAndSettings")}
          aria-expanded={open}
          aria-controls="navigation-search-results"
          aria-autocomplete="list"
          aria-activedescendant={
            open && results[active]
              ? searchResultOptionId("navigation-search-results", active)
              : undefined
          }
          placeholder={t("admin.searchPagesAndSettings")}
          value={query}
          className="min-w-0 w-full bg-transparent text-[13px] outline-none placeholder:text-gray-400"
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setActive((index) =>
                Math.max(
                  0,
                  Math.min(results.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
                ),
              );
            }
            if (open && event.key === "Enter" && results[active]) {
              event.preventDefault();
              window.location.assign(results[active].href);
            }
          }}
        />
        <kbd className="hidden md:block shrink-0 rounded border border-gray-200 px-1 text-[10px] text-gray-400">
          {open ? "Esc" : "Ctrl K"}
        </kbd>
      </div>
      {open && (
        <div className="absolute left-2 right-2 top-full z-[100] mt-1 max-h-[25rem] overflow-auto rounded-xl border border-gray-200 bg-white pb-1.5 shadow-2xl sm:left-auto sm:right-0 sm:w-[28rem]">
          {access === null && (
            <p role="status" className="p-4 text-sm text-gray-500">
              {t("admin.loadingSearch")}
            </p>
          )}
          {access !== null && results.length === 0 && (
            <p role="status" className="px-4 py-8 text-center text-sm text-gray-400">
              {query.trim()
                ? t("admin.noSearchResults", { query: query.trim() })
                : t("common.noResultsFound")}
            </p>
          )}
          <SearchResultList
            id="navigation-search-results"
            label={t("admin.pagesAndSettings")}
            results={results}
            categoryLabel={(category) => t(`navigation.category.${category}`)}
            activeIndex={active}
            onActiveChange={setActive}
          />
        </div>
      )}
    </div>
  );
}
