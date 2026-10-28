"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** One chosen extra in the bar's list. */
export type ExtrasBarRow = {
  id: string;
  name: string;
  /** The date badge: "3" over "Nov"; "—" over "Stay" without a day; "?" over "Day" while the
   * guest still picks it. */
  badge: { top: string; bottom: string };
  sub: string;
  /** Its price, or null when the shown prices don't add up to the quote. */
  price: string | null;
  /** A "guest_pick" extra still waiting for its day. */
  needsDay: boolean;
  onRemove: () => void;
};

export type ExtrasBarLabels = {
  backToRooms: string;
  yourExtras: (count: number) => string;
  yourExtrasTitle: string;
  extrasTotal: string;
  toSchedule: (count: number) => string;
  showExtras: string;
  close: string;
  removeExtra: (name: string) => string;
};

const chevron = (d: string, className = "h-4 w-4") => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
  </svg>
);

/**
 * VAY-2391: the Extras step's bar, sticky at the bottom of the screen until it settles above the
 * footer, so Continue stays in view however many extras there are. Back on the left; on the
 * right the stay's line and total, the chosen extras as a chip that opens their list (a sheet
 * on phones), and Continue.
 */
export default function ExtrasBar({
  rows,
  extrasTotal,
  stay,
  continueLabel,
  onContinue,
  continueDisabled,
  waiting,
  hint,
  notice,
  onBack,
  labels,
}: {
  rows: ExtrasBarRow[];
  /** The extras' total, or null while it isn't known. */
  extrasTotal: string | null;
  /** The stay's line ("Garden room · Flexible · 3 nights") and total. */
  stay: { line: string; total: ReactNode };
  continueLabel: string;
  onContinue: () => void;
  continueDisabled: boolean;
  /** An extra still needs its day: Continue looks waiting but says why when pressed. */
  waiting: boolean;
  /** Why Continue can't go on yet, after it was pressed. */
  hint: string | null;
  /** A refused price, shown above the bar's row so it stays in view. */
  notice?: ReactNode;
  onBack: () => void;
  labels: ExtrasBarLabels;
}) {
  const [open, setOpen] = useState(false);
  const toSchedule = rows.filter((row) => row.needsDay).length;
  const shown = open && rows.length > 0;
  // The list closes with its last extra, so adding one later doesn't open it again.
  useEffect(() => {
    if (!rows.length) setOpen(false);
  }, [rows.length]);
  // Focus goes into the list when it opens and back to the chip when it closes.
  const chip = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    chip.current?.focus();
  };
  useEffect(() => {
    if (shown) closeButton.current?.focus();
  }, [shown]);
  // Other pinned buttons (Privacy choices) sit above the bar while it shows, as with RoomsBar.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty("--fixed-bottom-bar", `${element.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--fixed-bottom-bar");
    };
  }, []);
  useEffect(() => {
    if (!shown) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      chip.current?.focus();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [shown]);
  return (
    <div
      ref={bar}
      data-testid="extras-bar"
      // Above other pinned buttons (Privacy choices) while its list is open.
      className={`sticky bottom-0 ${shown ? "z-[60]" : "z-30"} border-t border-gray-200 bg-white shadow-[0_-6px_20px_rgba(17,24,39,0.06)]`}
    >
      <div className="relative mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-5 gap-y-3 px-4 py-3 sm:px-6 lg:px-8">
        {notice && <div className="order-first w-full">{notice}</div>}
        <button
          type="button"
          onClick={onBack}
          className="order-2 flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-gray-900 md:order-1"
        >
          {chevron("M15 19l-7-7 7-7")}
          {labels.backToRooms}
        </button>
        <div className="order-1 flex w-full items-center justify-between gap-4 md:order-2 md:ml-auto md:w-auto md:justify-end">
          {rows.length > 0 && (
            <button
              ref={chip}
              type="button"
              aria-expanded={shown}
              aria-controls={shown ? "extras-bar-list" : undefined}
              aria-label={[
                `${labels.showExtras}: ${labels.yourExtras(rows.length)}`,
                extrasTotal,
                toSchedule ? labels.toSchedule(toSchedule) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              onClick={() => setOpen((value) => !value)}
              className={`flex items-center gap-3 rounded-xl border px-3.5 py-1.5 text-left ${shown ? "border-primary-500" : "border-gray-200 hover:border-gray-300"}`}
            >
              <span className="flex flex-col">
                <span className="text-xs text-gray-500">{labels.yourExtras(rows.length)}</span>
                <span className="text-base font-bold text-gray-900">{extrasTotal ?? "—"}</span>
              </span>
              {toSchedule > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                  {labels.toSchedule(toSchedule)}
                </span>
              )}
              {chevron(shown ? "M19 9l-7 7-7-7" : "M5 15l7-7 7 7")}
            </button>
          )}
          <div className={rows.length ? "text-right" : "md:text-right"}>
            <p className={`text-xs text-gray-500 ${rows.length ? "hidden lg:block" : ""}`}>
              {stay.line}
            </p>
            {stay.total}
          </div>
        </div>
        <div className="order-3 flex flex-col items-end gap-1">
          <button
            type="button"
            disabled={continueDisabled}
            onClick={onContinue}
            className={`rounded-full px-5 py-3 font-semibold text-white disabled:opacity-40 ${waiting ? "bg-gray-400" : "bg-primary-600"}`}
          >
            {continueLabel}
          </button>
          {hint && (
            <p role="alert" className="text-xs text-amber-700">
              {hint}
            </p>
          )}
        </div>

        {shown && (
          <>
            {/* Phones: a sheet over the page. */}
            <div
              className="fixed inset-0 z-40 bg-black/30 md:hidden"
              aria-hidden="true"
              onClick={close}
            />
            <div
              id="extras-bar-list"
              role="dialog"
              aria-label={labels.yourExtrasTitle}
              className="fixed inset-x-0 bottom-0 z-50 max-h-[75dvh] overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl md:absolute md:inset-x-auto md:bottom-full md:right-8 md:mb-3 md:w-[380px] md:rounded-2xl md:border md:border-gray-200 md:p-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-bold text-gray-900">{labels.yourExtrasTitle}</h2>
                <button
                  ref={closeButton}
                  type="button"
                  aria-label={labels.close}
                  onClick={close}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-700"
                >
                  {chevron("M6 18L18 6M6 6l12 12", "h-3.5 w-3.5")}
                </button>
              </div>
              <ul className="space-y-2">
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center gap-3 rounded-xl border border-gray-100 p-2.5"
                  >
                    <span
                      className={`flex w-12 flex-shrink-0 flex-col items-center rounded-lg py-1 text-[11px] font-semibold uppercase ${row.needsDay ? "bg-amber-50 text-amber-800" : "bg-gray-100 text-gray-500"}`}
                    >
                      <span className="text-[15px] font-bold normal-case">{row.badge.top}</span>
                      {row.badge.bottom}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-gray-900">{row.name}</span>
                      <span
                        className={`block text-xs ${row.needsDay ? "text-amber-700" : "text-gray-500"}`}
                      >
                        {row.sub}
                      </span>
                    </span>
                    {row.price && (
                      <span className="text-sm font-bold text-gray-900">{row.price}</span>
                    )}
                    <button
                      type="button"
                      aria-label={labels.removeExtra(row.name)}
                      onClick={row.onRemove}
                      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-gray-200 text-gray-400 hover:border-red-200 hover:text-red-500"
                    >
                      {chevron("M6 18L18 6M6 6l12 12", "h-3.5 w-3.5")}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-gray-500">{labels.extrasTotal}</span>
                <span className="font-bold text-gray-900">{extrasTotal ?? "—"}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
