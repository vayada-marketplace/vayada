"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { dashboardService } from "@/services/dashboard";
import { settingsService } from "@/services/settings";
import { todayStatsMetrics, type TodayStats } from "./todayStats";

// The strip shows from 768 px; narrower screens skip the reads too.
const WIDE = "(min-width: 768px)";

// Today's numbers next to the property name (VAY-2203). They come from the Dashboard's Today read,
// so the strip and the Dashboard always agree, and are read again on every page change.
export default function DailyStatsStrip({ hotelId }: { hotelId?: string }) {
  const { t, locale } = useTranslation();
  const pathname = usePathname();
  const [stats, setStats] = useState<TodayStats | null>(null);
  const [wide, setWide] = useState(false);
  // How many metrics fit: all 3, 2 without page views, or none. A metric is never cut in half.
  const [shown, setShown] = useState(3);
  const [headerWidth, setHeaderWidth] = useState(0);
  const box = useRef<HTMLAnchorElement>(null);
  // A hotel whose Dashboard read was refused isn't asked again on every page change.
  const refused = useRef<string | null>(null);

  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!hotelId || !wide || refused.current === hotelId) return;
    let cancelled = false;
    settingsService
      .getPropertySettings(hotelId)
      .then(async (settings) => {
        if (!settings.time_zone) throw new Error("Property timezone is unavailable.");
        const today = await dashboardService.getStats("today", settings.time_zone);
        if (cancelled) return;
        setStats({
          revenue: today.revenue,
          bookings: today.bookings,
          pageViews: today.page_views,
          currency: settings.default_currency || "EUR",
        });
      })
      // No Dashboard access or a failed read: leave the strip out rather than show wrong zeros.
      .catch((error: unknown) => {
        if (cancelled) return;
        setStats(null);
        const status = (error as { status?: number } | null)?.status;
        if (status === 401 || status === 403) refused.current = hotelId;
      });
    return () => {
      cancelled = true;
    };
  }, [hotelId, pathname, wide]);

  // Start from all three whenever the numbers, the language or the room change, then drop
  // metrics from the end until the strip fits.
  useLayoutEffect(() => {
    setShown(3);
  }, [stats, locale, headerWidth]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && shown > 0 && el.scrollWidth > el.clientWidth) setShown(shown === 3 ? 2 : 0);
  }, [shown, stats, locale, headerWidth]);

  // The header's width changes with the window and the sidebar.
  const hasStats = stats !== null;
  useEffect(() => {
    const header = box.current?.closest("header");
    if (!header || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setHeaderWidth(entry.contentRect.width));
    observer.observe(header);
    return () => observer.disconnect();
  }, [hasStats]);

  if (!stats) return null;
  return (
    <>
      <div
        className={`h-5 w-px shrink-0 bg-gray-200 ${shown > 0 ? "hidden md:block" : "hidden"}`}
      />
      <Link
        ref={box}
        href="/dashboard"
        className={`${shown > 0 ? "hidden md:flex" : "hidden"} group min-w-0 flex-col justify-center overflow-hidden rounded-md px-1.5 py-0.5 hover:bg-gray-50`}
      >
        <span className="whitespace-nowrap text-[12px] font-semibold leading-tight text-gray-900">
          {t("layout.header.today")}
        </span>
        <span className="whitespace-nowrap text-[10px] leading-tight text-gray-400 group-hover:text-gray-600">
          {todayStatsMetrics(stats, t, locale).slice(0, shown).join(" · ")}
        </span>
      </Link>
    </>
  );
}
