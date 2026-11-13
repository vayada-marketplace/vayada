"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

/** The bar's height: 10px + the 24px name + 8px + the 48px row + 12px. */
const STICKY_SEARCH_BAR_HEIGHT = 102;

/**
 * The hotel page's compact search on phones (VAY-2494, Timo's "Proposal – scrolled"): once the
 * search card (`#stay-search`) has scrolled up under the bar, a bar at the top of the screen
 * shows the hotel's name in the hero's lettering and, below it, the stay ("13–14 Nov · 2 adults")
 * in a pill with Edit, which goes back to the card, and the sort's round button when the rooms can
 * be sorted. Never from `md` up, where the card itself sticks.
 */
export default function StickySearchBar({
  title,
  label,
  onEdit,
  onSort,
}: {
  title: string;
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
    // Out of view = above the bar's own height: the bar then covers what is left of the card, so
    // the card and the bar never show together.
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]!;
        setShown(
          !entry.isIntersecting &&
            entry.boundingClientRect.top < (entry.rootBounds?.top ?? STICKY_SEARCH_BAR_HEIGHT),
        );
      },
      { rootMargin: `-${STICKY_SEARCH_BAR_HEIGHT}px 0px 0px 0px` },
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  if (!shown) return null;
  return (
    <div
      data-testid="sticky-search-bar"
      className="fixed inset-x-0 top-0 z-40 flex h-[102px] flex-col gap-2 bg-white/[0.97] px-4 pb-3 pt-2.5 shadow-[0_1px_0_rgb(229,231,235),0_6px_16px_rgba(31,26,22,0.06)] md:hidden"
    >
      <p className="h-6 truncate text-center font-heading text-xl italic leading-6 text-gray-900">
        {title}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-full border border-gray-200 bg-white pl-3.5 pr-2 text-left text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          <svg
            className="h-[18px] w-[18px] shrink-0 text-primary-600"
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
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{label}</span>
          <span className="flex h-[34px] shrink-0 items-center rounded-full bg-primary-50 px-3 text-sm font-semibold">
            {t("edit")}
          </span>
        </button>
        {onSort && (
          <button
            type="button"
            onClick={onSort}
            aria-label={t("sort")}
            aria-haspopup="dialog"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-900 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <svg
              className="h-[18px] w-[18px]"
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
    </div>
  );
}
