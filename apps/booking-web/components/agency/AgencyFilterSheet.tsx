"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";

/**
 * The phone's filters (VAY-2463, Timo's mobile prototype): a sheet from the bottom of the screen
 * over the dimmed page, with Reset at the top and "Show X stays" at the bottom. The filters apply
 * as they are chosen, so the button always says how many stays the list will show. The page
 * behind is out of reach while it is open; Escape, a tap on the dimmed page or the button
 * closes it.
 */
export default function AgencyFilterSheet({
  count,
  canReset,
  onReset,
  onClose,
  children,
}: {
  /** The stays the list shows with these filters; null until the search answers. */
  count: number | null;
  canReset: boolean;
  onReset: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useTranslations("agency");
  const dialogRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape closes it wherever the focus is (Reset, once disabled, lets it fall to the page).
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  // A modal, as the hotel page's phone map: the page stays put and out of reach, and the focus
  // starts on the sheet so its title is read first.
  useEffect(() => {
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    const behind = Array.from(document.body.children).filter(
      (element) => element !== dialogRef.current && !element.hasAttribute("inert"),
    );
    behind.forEach((element) => element.setAttribute("inert", ""));
    sheetRef.current?.focus();
    return () => {
      root.style.overflow = overflow;
      behind.forEach((element) => element.removeAttribute("inert"));
    };
  }, []);

  return createPortal(
    <div
      ref={dialogRef}
      data-testid="agency-filter-sheet"
      className="fixed inset-0 z-[90] bg-black/45"
      // On the tap's click, not as the finger goes down: the click must not reach the page below.
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-[22px] bg-white shadow-[0_-8px_28px_rgba(0,0,0,0.18)] focus:outline-none"
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-4">
          <h2 id={titleId} className="text-[19px] font-bold text-gray-900">
            {t("filters")}
          </h2>
          <button
            type="button"
            onClick={onReset}
            disabled={!canReset}
            className="min-h-[44px] px-1 text-[15px] font-semibold text-gray-900 underline disabled:text-gray-300 disabled:no-underline"
          >
            {t("reset")}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2 pt-3">{children}</div>
        <div className="px-4 pb-[max(1.75rem,env(safe-area-inset-bottom))] pt-3">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[50px] w-full rounded-full bg-primary-600 px-6 text-base font-semibold text-white hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
          >
            {count === null ? t("showStaysPending") : t("showStays", { count })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
