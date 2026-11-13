"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

/**
 * The hotel page's compact search on phones (VAY-2494): once the search card (`#stay-search`) has
 * scrolled up under the bar, a bar at the top of the screen says the stay ("13–14 Nov · 2
 * adults") with Edit, which goes back to the card, and the sort's icon when the rooms can be
 * sorted. Never from `md` up, where the card itself sticks.
 */
export default function StickySearchBar({
  label,
  onEdit,
  onSort,
}: {
  label: string;
  onEdit: () => void;
  /** Opens the sort; none without a sort menu. */
  onSort?: () => void;
}) {
  const t = useTranslations("home.phoneSearch");
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const card = document.getElementById("stay-search");
    if (!card) return;
    // Out of view = above the bar's own 56px: the bar then covers what is left of the card, so
    // the card and the bar never show together.
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]!;
        setShown(
          !entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 56),
        );
      },
      { rootMargin: "-56px 0px 0px 0px" },
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  if (!shown) return null;
  return (
    <div
      data-testid="sticky-search-bar"
      className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-2 border-b border-gray-200 bg-white px-4 shadow-sm md:hidden"
    >
      <button
        type="button"
        onClick={onEdit}
        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-sm text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <svg
          className="h-4 w-4 shrink-0 text-gray-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <span className="min-w-0 truncate font-medium">{label}</span>
        <span className="shrink-0 text-gray-400" aria-hidden="true">
          ·
        </span>
        <span className="shrink-0 font-semibold underline underline-offset-2">{t("edit")}</span>
      </button>
      {onSort && (
        <button
          type="button"
          onClick={onSort}
          aria-label={t("sort")}
          aria-haspopup="dialog"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-gray-200 text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
