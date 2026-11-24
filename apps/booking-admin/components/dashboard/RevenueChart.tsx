"use client";

import { useRef, useState } from "react";
import { formatCurrency } from "@/lib/utils";
import { axisLabelIndexes, barHeight, chartCeiling, tooltipAlign } from "@/lib/utils/revenueChart";
import type { RevenueDays } from "@/services/dashboard";

const CHART_HEIGHT = 170;

type Props = {
  data: RevenueDays | null;
  loading: boolean;
  error: boolean;
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Opens the day window on a day with bookings. */
  onOpenDay: (date: string) => void;
  /** Opens the Details window on revenue. */
  onDetails?: () => void;
};

function shortDate(iso: string, locale: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
    new Date(year, (month ?? 1) - 1, day ?? 1),
  );
}

/**
 * Revenue over time (VAY-2594): one bar per day of the range, for the direct bookings made that
 * day. Hover or focus shows the day; a click on a day with bookings opens them. On touch, the first
 * tap shows the nearest day's tooltip and a second tap on it opens the day.
 */
export function RevenueChart({ data, loading, error, locale, t, onOpenDay, onDetails }: Props) {
  const [active, setActive] = useState<number | null>(null);
  // Touch picks the bar nearest the finger across the whole chart, since a day can be 2px wide
  // on a phone: the first tap shows it, a second tap on it opens the day. Mouse and keyboard use
  // the bars themselves.
  const lastPointer = useRef<string>("mouse");
  // The bar a first tap picked: kept apart from the hover state, which the browser's mouse events
  // after a tap can clear.
  const touchSelected = useRef<number | null>(null);
  const barsRef = useRef<HTMLDivElement>(null);
  // A second tap opens the day on the click that follows it: opening on the tap itself would let
  // that click land on the new window's backdrop and close it again.
  const pendingOpen = useRef<number | null>(null);
  const hover = (index: number) => {
    if (lastPointer.current !== "touch") setActive(index);
  };
  const nearestBar = (x: number) => {
    const bars = barsRef.current?.children;
    let best = -1;
    let distance = Infinity;
    for (let index = 0; bars && index < bars.length; index += 1) {
      const box = bars[index].getBoundingClientRect();
      const gap = Math.abs(box.left + box.width / 2 - x);
      if (gap < distance) {
        distance = gap;
        best = index;
      }
    }
    return best;
  };
  const days = data?.days ?? [];
  const ceiling = chartCeiling(Math.max(0, ...days.map((day) => day.revenue)));
  const compact = (value: number) =>
    formatCurrency(value, data?.currency ?? "EUR", locale, {
      notation: "compact",
      maximumFractionDigits: 1,
    });
  // Up to a week, each bar is capped and labelled under itself; longer ranges fill the width
  // and label five dates spread across it.
  const short = days.length <= 7;
  const labels = short ? days.map((_, index) => index) : axisLabelIndexes(days.length);
  // Thinner gaps for longer ranges, so 90 bars fit on a phone.
  const gap = days.length > 31 ? "gap-px" : days.length > 14 ? "gap-[3px]" : "gap-1";
  const column = `relative flex h-full min-w-0 flex-1 flex-col justify-end ${short ? "max-w-[64px]" : ""}`;

  return (
    <section className="flex min-w-0 flex-col gap-3.5 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold text-gray-900">
            {t("dashboard.revenueChart.title")}
          </h2>
          <span className="text-[13px] text-gray-500">{t("dashboard.revenueChart.subtitle")}</span>
        </div>
        {onDetails && (
          <button
            type="button"
            onClick={onDetails}
            aria-label={t("dashboard.details.open.revenue")}
            className="h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-[13px] font-medium text-gray-900 hover:bg-gray-50"
          >
            {t("dashboard.stats.details")} ›
          </button>
        )}
      </div>
      {error ? (
        <p className="py-10 text-center text-sm text-gray-500">
          {t("dashboard.revenueChart.error")}
        </p>
      ) : (
        <div className={`flex gap-2.5 ${loading ? "opacity-60" : ""}`}>
          <div
            aria-hidden="true"
            className="flex min-w-[44px] flex-col justify-between text-right text-[11px] text-gray-500"
            style={{ height: CHART_HEIGHT }}
          >
            <span>{ceiling > 0 ? compact(ceiling) : ""}</span>
            <span>{ceiling > 0 ? compact(ceiling / 2) : ""}</span>
            <span>0</span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div
              className={`flex items-end border-b border-gray-200 ${gap} ${short ? "justify-center" : ""}`}
              style={{
                height: CHART_HEIGHT,
                backgroundImage: "linear-gradient(#F0F2F5 1px, transparent 1px)",
                backgroundSize: `100% ${CHART_HEIGHT / 2}px`,
              }}
              ref={barsRef}
              onMouseLeave={() => {
                if (lastPointer.current !== "touch") setActive(null);
              }}
              onPointerDown={(event) => {
                lastPointer.current = event.pointerType;
              }}
              onPointerMove={(event) => {
                if (event.pointerType === "mouse") lastPointer.current = "mouse";
              }}
              onPointerUp={(event) => {
                if (event.pointerType !== "touch") return;
                const index = nearestBar(event.clientX);
                const day = days[index];
                if (!day) return;
                if (day.bookings > 0 && touchSelected.current === index) {
                  pendingOpen.current = index;
                } else {
                  touchSelected.current = index;
                  setActive(index);
                }
              }}
              onClick={() => {
                const index = pendingOpen.current;
                pendingOpen.current = null;
                if (index === null || !days[index]) return;
                touchSelected.current = null;
                setActive(null);
                onOpenDay(days[index].date);
              }}
            >
              {days.map((day, index) => {
                const booked = day.bookings > 0;
                const on = active === index;
                const dim = active !== null && !on;
                const value = booked
                  ? compact(day.revenue)
                  : t("dashboard.revenueChart.noBookings");
                const date = shortDate(day.date, locale);
                const align = tooltipAlign(index, days.length);
                const color = !booked
                  ? "bg-[#E5E7EB]"
                  : on
                    ? "bg-[#1E3AD8]"
                    : dim
                      ? "bg-[#9AABF9]"
                      : "bg-[#2B4BF2]";
                const bar = (
                  <>
                    {on && (
                      <span
                        role="tooltip"
                        className={`pointer-events-none absolute z-10 whitespace-nowrap rounded-md bg-[#111827] px-2.5 py-1.5 text-left text-white shadow-[0_4px_12px_rgba(17,24,39,0.2)] ${
                          align === "left"
                            ? "left-0"
                            : align === "right"
                              ? "right-0"
                              : "left-1/2 -translate-x-1/2"
                        }`}
                        style={{
                          bottom: barHeight(day.revenue, day.bookings, ceiling, CHART_HEIGHT) + 8,
                        }}
                      >
                        <span className="block text-[11px] text-[#C9CED8]">{date}</span>
                        <span className="block text-[13px] font-semibold">{value}</span>
                        {booked && (
                          <span className="mt-0.5 block text-[11px] text-[#C9CED8]">
                            {t(
                              day.bookings === 1
                                ? "dashboard.revenueChart.bookingHint"
                                : "dashboard.revenueChart.bookingsHint",
                              { count: day.bookings },
                            )}
                          </span>
                        )}
                      </span>
                    )}
                    <span
                      className={`block rounded-t-[3px] transition-colors ${color}`}
                      style={{
                        height: barHeight(day.revenue, day.bookings, ceiling, CHART_HEIGHT),
                      }}
                    />
                  </>
                );
                return booked ? (
                  <button
                    key={day.date}
                    type="button"
                    aria-label={t("dashboard.revenueChart.barLabel", { date, value })}
                    // touch-manipulation: a second tap opens the day instead of zooming the page.
                    className={`${column} cursor-pointer touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300`}
                    onMouseEnter={() => hover(index)}
                    onFocus={(event) => {
                      // Keyboard focus shows the day; focus coming back from the window doesn't.
                      if (event.currentTarget.matches(":focus-visible")) setActive(index);
                    }}
                    onBlur={() => setActive(null)}
                    onClick={(event) => {
                      // Touch is handled by the chart; a keyboard click (detail 0) always opens.
                      if (event.detail !== 0 && lastPointer.current === "touch") return;
                      setActive(null);
                      onOpenDay(day.date);
                    }}
                  >
                    {bar}
                  </button>
                ) : (
                  <div
                    key={day.date}
                    className={`${column} touch-manipulation`}
                    onMouseEnter={() => hover(index)}
                  >
                    {bar}
                  </div>
                );
              })}
            </div>
            <div
              className={`flex text-[11px] text-gray-500 ${short ? `justify-center ${gap}` : "justify-between"}`}
              aria-hidden="true"
            >
              {labels.map((index) => (
                <span
                  key={days[index].date}
                  className={short ? "min-w-0 max-w-[64px] flex-1 truncate text-center" : ""}
                >
                  {shortDate(days[index].date, locale)}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
