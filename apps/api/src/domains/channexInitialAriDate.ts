import { DEFAULT_FULL_ARI_DAYS_AHEAD } from "../jobs/pmsChannexAriHorizon.js";

const unavailable = { kind: "unavailable", reason: "ari_date_unavailable" } as const;

/** Calendar-date admission only; no availability, capability or send permission. */
export function admitChannexInitialAriDate(
  date: string,
  timeZone: unknown,
  now: Date,
  anchorDate?: string,
) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return unavailable;
  const selected = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(selected.getTime()) || selected.toISOString().slice(0, 10) !== date)
    return unavailable;
  const window = initialAriWindow(timeZone, now, anchorDate);
  if (window.kind !== "window" || date < window.propertyLocalDate || date > window.through)
    return unavailable;
  return { ...window, kind: "admitted" as const, date };
}

/** Callers must verify completion provenance before supplying covered dates. */
export function selectNextChannexInitialAriDate(
  timeZone: unknown,
  now: Date,
  completed: readonly string[],
  anchorDate?: string,
) {
  const window = initialAriWindow(timeZone, now, anchorDate);
  if (window.kind !== "window") return window;
  const covered = new Set(completed);
  const cursor = new Date(`${window.propertyLocalDate}T00:00:00.000Z`);
  for (
    let date = window.propertyLocalDate;
    date <= window.through;
    date = cursor.toISOString().slice(0, 10)
  ) {
    if (!covered.has(date)) return { ...window, kind: "selected" as const, date };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { ...window, kind: "selected" as const, date: null };
}

function initialAriWindow(timeZone: unknown, now: Date, anchorDate?: string) {
  const today = channexPropertyLocalDate(timeZone, now);
  if (!today) return unavailable;
  const start = anchorDate ?? today;
  const parsed = new Date(`${start}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== start
  )
    return unavailable;
  const end = new Date(parsed);
  // Calendar arithmetic intentionally avoids 24-hour additions in the hotel's zone.
  end.setUTCDate(end.getUTCDate() + DEFAULT_FULL_ARI_DAYS_AHEAD);
  const through = end.toISOString().slice(0, 10);
  return { kind: "window" as const, propertyLocalDate: start, through, timeZone };
}

/** Validated hotel-local calendar date only; no horizon or provider authority. */
export function channexPropertyLocalDate(timeZone: unknown, now: Date): string | null {
  if (
    typeof timeZone !== "string" ||
    !timeZone ||
    timeZone !== timeZone.trim() ||
    !Number.isFinite(now.getTime())
  )
    return null;
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
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return null;
  }
}
