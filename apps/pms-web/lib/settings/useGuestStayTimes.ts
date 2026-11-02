"use client";

import { useEffect, useState } from "react";
import { guestStayTimesService, type GuestStayTimes } from "@/services/settings/guestStayTimes";
import { useHasPmsPermission } from "./PmsAccessContext";

export type { GuestStayTimes };

const FRESH_FOR_MS = 60_000;
let cached: { at: number; times: Promise<GuestStayTimes | null> } | null = null;

/** One guest-rules read a minute, shared by the dashboard, the booking, the check-in and every calendar popover.
 * Switching property reloads the page, which empties it; a failed read isn't kept. */
function readGuestStayTimes(): Promise<GuestStayTimes | null> {
  if (!cached || Date.now() - cached.at > FRESH_FOR_MS) {
    const times = guestStayTimesService.load();
    const entry = { at: Date.now(), times };
    cached = entry;
    times.catch(() => {
      if (cached === entry) cached = null;
    });
  }
  return cached.times;
}

/** After saving the guest rules, so the next screen shows the new times. */
export function forgetGuestStayTimes() {
  cached = null;
}

/** The check-in and check-out times guests see on the booking page ("15:00", "11:00"): the saved guest rules, which a
 * live page republishes after each save. So the PMS never tells staff a different time (VAY-2455). Null until read,
 * while the property has none, or when they can't be read. Members who read bookings (`pms.reservation.read`, the
 * front desk too) may read them; others, such as housekeeping, see the day without a time. */
export function useGuestStayTimes(): GuestStayTimes | null {
  const canRead = useHasPmsPermission("pms.reservation.read");
  const [times, setTimes] = useState<GuestStayTimes | null>(null);
  useEffect(() => {
    if (!canRead) return;
    let active = true;
    readGuestStayTimes().then(
      (value) => active && setTimes(value),
      () => active && setTimes(null),
    );
    return () => {
      active = false;
    };
  }, [canRead]);
  return canRead ? times : null;
}
