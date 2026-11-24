"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowTopRightOnSquareIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { createBrowserAuthHandoff } from "@vayada/product-onboarding";
import { notificationLinkHref } from "@/lib/notificationLinks";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { readSelectedSharedPropertyId } from "@/lib/utils/sharedSetupGuard";
import { neighbourBookingDays } from "@/lib/utils/revenueChart";
import { getSelectedBookingHotelId } from "@/services/api/bookingHotelScope";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";
import { dashboardService, type DayBooking, type DayBookings } from "@/services/dashboard";

type Props = {
  date: string;
  /** The chart's days, for the arrows to the previous and next day with bookings. */
  days: readonly { date: string; bookings: number }[];
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  onNavigate: (date: string) => void;
  onClose: () => void;
};

function localDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

/** "27 Nov – 1 Dec" in the viewer's language. */
function stayDates(checkIn: string, checkOut: string, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
  const range = format as Intl.DateTimeFormat & {
    formatRange?: (start: Date, end: Date) => string;
  };
  const start = localDate(checkIn);
  const end = localDate(checkOut);
  return range.formatRange
    ? range.formatRange(start, end)
    : `${format.format(start)} – ${format.format(end)}`;
}

/**
 * Opens the booking in PMS, signed in on this property, in a new tab. The tab opens at the click,
 * so no popup blocker stops it; it goes to Reservations here when the sign-in exchange fails.
 */
async function openInPms(booking: DayBooking, fallback: string): Promise<void> {
  const tab = window.open("", "_blank");
  let url: string | null = null;
  const csrfToken = getAuthCsrfToken();
  // The canonical property, as the header's bell uses for PMS.
  const propertyId = readSelectedSharedPropertyId() ?? getSelectedBookingHotelId();
  if (csrfToken && propertyId) {
    try {
      url = await createBrowserAuthHandoff({
        csrfToken,
        routingHints: { propertyId },
        sourceSurface: "booking-admin",
        targetPath: `/bookings/${encodeURIComponent(booking.id)}`,
        targetSurface: "pms-web",
      });
    } catch {
      url = null;
    }
  }
  const target = url ?? fallback;
  if (tab) {
    tab.opener = null;
    tab.location.href = target;
  } else {
    window.location.href = target;
  }
}

/**
 * The direct bookings made on one day of the revenue chart (VAY-2594). Pinned 120px from the top,
 * so its header and arrows stay put whatever the number of bookings.
 */
export function DayBookingsWindow({ date, days, locale, t, onNavigate, onClose }: Props) {
  const [data, setData] = useState<DayBookings | null>(null);
  const [error, setError] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { previous, next } = neighbourBookingDays(days, date);
  const booked = days.filter((day) => day.bookings > 0);
  const firstBooked = booked.length > 0 ? booked[0].date : undefined;
  const lastBooked = booked.length > 0 ? booked[booked.length - 1].date : undefined;
  const title = t("dashboard.dayWindow.title", {
    date: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
      localDate(date),
    ),
  });

  // The window renders at the end of <body>, so focus moves into it and goes back on close.
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      // Tab stays in the window.
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.prototype.filter.call(
        dialogRef.current.querySelectorAll("button:not([disabled]), a[href]"),
        (element: HTMLElement) => element.offsetParent !== null,
      ) as HTMLElement[];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(false);
    dashboardService
      .getDayBookings(date)
      .then((day) => {
        if (!cancelled) setData(day);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  const money = (value: number, currency: string) =>
    formatCurrency(value, currency, locale, { notation: "compact", maximumFractionDigits: 1 });
  // At the first or last day an arrow turns off: focus moves to Close rather than leaving the window.
  const arrow = (
    target: string | null,
    end: string | undefined,
    label: string,
    icon: ReactNode,
  ) => (
    <button
      type="button"
      aria-label={label}
      disabled={!target}
      onClick={() => {
        if (!target) return;
        if (target === end) closeRef.current?.focus();
        onNavigate(target);
      }}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:cursor-default disabled:text-[#C9CED8] disabled:hover:bg-white"
    >
      {icon}
    </button>
  );
  const tile = (label: string, value: string) => (
    <div className="flex min-w-[120px] flex-1 flex-col gap-0.5 rounded-[10px] bg-[#F6F7F9] px-3.5 py-3">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-xl font-bold text-gray-900">{value}</span>
    </div>
  );

  // On <body>, not inside the page's space-y stack, whose margin would move the backdrop (VAY-2590).
  return createPortal(
    <>
      <button
        type="button"
        aria-label={t("dashboard.dayWindow.close")}
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-50 cursor-default bg-[rgba(17,24,39,0.32)]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed left-1/2 top-[120px] z-50 flex max-h-[calc(100%-160px)] w-[calc(100%-32px)] max-w-[640px] -translate-x-1/2 flex-col gap-[18px] overflow-y-auto rounded-2xl bg-white px-[22px] pb-6 pt-5 shadow-[0_24px_64px_rgba(17,24,39,0.22)]"
      >
        <div className="flex items-center gap-2">
          {arrow(
            previous,
            firstBooked,
            t("dashboard.dayWindow.previous"),
            <ChevronLeftIcon aria-hidden="true" className="h-4 w-4" />,
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="text-lg font-bold text-gray-900">{title}</h2>
            <span className="text-[13px] text-gray-500">{t("dashboard.dayWindow.subtitle")}</span>
          </div>
          {arrow(
            next,
            lastBooked,
            t("dashboard.dayWindow.next"),
            <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />,
          )}
          <button
            ref={closeRef}
            type="button"
            aria-label={t("dashboard.dayWindow.close")}
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F6F7F9] text-gray-700 hover:bg-gray-100"
          >
            <XMarkIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {tile(t("dashboard.stats.revenue"), data ? money(data.revenue, data.currency) : "--")}
          {tile(t("dashboard.stats.bookings"), data ? formatNumber(data.bookings, locale) : "--")}
          {tile(
            t("dashboard.dayWindow.roomNights"),
            data ? formatNumber(data.room_nights, locale) : "--",
          )}
        </div>
        {error ? (
          <p className="text-sm text-gray-500">{t("dashboard.dayWindow.error")}</p>
        ) : data?.bookings_hidden ? (
          <p className="text-sm text-gray-500">{t("dashboard.dayWindow.hidden")}</p>
        ) : !data ? (
          <p className="text-sm text-gray-500">{t("common.loading")}</p>
        ) : (
          <ul className="flex flex-col">
            {data.list.map((booking) => {
              const reservations = notificationLinkHref(
                { path: "/reservations", param: "search" },
                booking.reference,
              );
              const sub = [
                t("dashboard.dayWindow.arrival", {
                  dates: stayDates(booking.check_in, booking.check_out, locale),
                }),
                t(
                  booking.nights === 1 ? "dashboard.dayWindow.night" : "dashboard.dayWindow.nights",
                  { count: booking.nights },
                ),
                booking.room_names.join(", "),
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li
                  key={booking.id}
                  className="flex items-center gap-3 border-b border-[#F0F2F5] py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold text-gray-900">
                      {booking.reference}
                    </span>
                    <span className="text-xs text-gray-500">{sub}</span>
                  </div>
                  <span className="whitespace-nowrap text-sm font-semibold text-gray-900">
                    {money(booking.total, booking.currency)}
                  </span>
                  <a
                    href={reservations}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("dashboard.dayWindow.openBookingLabel", {
                      reference: booking.reference,
                    })}
                    onClick={(event) => {
                      if (!data.can_open_in_pms) return;
                      event.preventDefault();
                      void openInPms(booking, reservations);
                    }}
                    className="flex h-[30px] shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-gray-200 px-2.5 text-xs font-semibold text-gray-900 hover:bg-gray-50"
                  >
                    {t("dashboard.dayWindow.openBooking")}
                    <ArrowTopRightOnSquareIcon aria-hidden="true" className="h-3 w-3" />
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>,
    document.body,
  );
}
