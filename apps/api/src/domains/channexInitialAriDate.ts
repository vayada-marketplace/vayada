import { DEFAULT_FULL_ARI_DAYS_AHEAD } from "../jobs/pmsChannexAriHorizon.js";

/** Calendar-date admission only; no availability, capability or send permission. */
export function admitChannexInitialAriDate(date: string, timeZone: unknown, now: Date) {
  const unavailable = { kind: "unavailable", reason: "ari_date_unavailable" } as const;
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    typeof timeZone !== "string" ||
    !timeZone ||
    timeZone !== timeZone.trim() ||
    !Number.isFinite(now.getTime())
  )
    return unavailable;
  const selected = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(selected.getTime()) || selected.toISOString().slice(0, 10) !== date)
    return unavailable;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        calendar: "iso8601",
        numberingSystem: "latn",
      })
        .formatToParts(now)
        .map(({ type, value }) => [type, value]),
    );
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const end = new Date(`${today}T00:00:00.000Z`);
    // Calendar arithmetic intentionally avoids 24-hour additions in the hotel's zone.
    end.setUTCDate(end.getUTCDate() + DEFAULT_FULL_ARI_DAYS_AHEAD);
    const through = end.toISOString().slice(0, 10);
    if (date < today || date > through) return unavailable;
    return { kind: "admitted" as const, date, propertyLocalDate: today, through, timeZone };
  } catch {
    return unavailable;
  }
}
