import { useEffect, useState } from "react";
import { pmsSettingsService } from "@/services/settings";

/**
 * VAY-2348: a booking-page bank transfer (or PayPal) booking waiting for the guest's money. Its
 * rooms are held until the payment deadline, when the system releases it if the hotel hasn't
 * marked the payment as received.
 */
export const AWAITING_PAYMENT_BADGE_CLASS = "border-amber-200 text-amber-800 bg-amber-50";
/** The striped amber calendar bar: held, not yet confirmed. */
export const AWAITING_PAYMENT_BAR_CLASS = "border border-dashed border-amber-600 text-amber-900";
export const AWAITING_PAYMENT_BAR_STYLE = {
  backgroundImage:
    "repeating-linear-gradient(135deg, #FEF3C7 0px, #FEF3C7 6px, #FFFBEB 6px, #FFFBEB 12px)",
} as const;

/** "Tue, 27 Oct, 15:30": the deadline in the hotel's time zone (the browser's when unknown). */
export function formatPaymentDeadline(
  iso: string,
  locale?: string,
  timeZone?: string | null,
): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  try {
    return date.toLocaleString(locale, timeZone ? { ...options, timeZone } : options);
  } catch {
    return date.toLocaleString(locale, options);
  }
}

/** The current hotel's IANA time zone, or null until (or unless) it is known. */
export function useHotelTimeZone(): string | null {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    pmsSettingsService
      .getHotelDetails()
      .then((hotel) => {
        if (alive) setZone(hotel?.timezone || null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return zone;
}
