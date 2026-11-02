import { MIDNIGHT, type ArrivalDay, type ArrivalFieldError } from "./arrivalTimesForm";

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** A latest check-in of 00:00 is midnight at the end of the arrival day, as the booking page says. */
const until = (t: Translate, time: string) =>
  time === MIDNIGHT ? t("settings.arrivalTimes.time.midnight") : time;

/** "From 15:00" or "15:00 – 22:00", as the timeline, the review and the booking page preview show check-in. */
export function checkInLabel(t: Translate, window: ArrivalDay["checkIn"]): string {
  if (!window) return t("settings.arrivalTimes.time.notSet");
  return window.until
    ? t("settings.arrivalTimes.time.range", { from: window.from, to: until(t, window.until) })
    : t("settings.arrivalTimes.time.from", { time: window.from });
}

/** "By 11:00" or "07:00 – 11:00": the booking page says "Check-out by 11:00". */
export function checkOutLabel(t: Translate, window: ArrivalDay["checkOut"]): string {
  if (!window) return t("settings.arrivalTimes.time.notSet");
  return window.from
    ? t("settings.arrivalTimes.time.range", { from: window.from, to: window.by })
    : t("settings.arrivalTimes.time.by", { time: window.by });
}

export function duration(t: Translate, total: number, short = false): string {
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours && mins)
    return short
      ? t("settings.arrivalTimes.duration.hoursMinutesShort", { hours, minutes: mins })
      : t("settings.arrivalTimes.duration.hoursMinutes", { hours, minutes: mins });
  if (hours) return t("settings.arrivalTimes.duration.hours", { hours });
  return t("settings.arrivalTimes.duration.minutes", { minutes: mins });
}

/** "Guests check out by 11:00 and check in from 15:00. That leaves 4 h to turn the room over." */
export function daySummary(t: Translate, day: ArrivalDay): string {
  if (!day.checkIn || !day.checkOut) return t("settings.arrivalTimes.day.summaryEmpty");
  const checkOut = day.checkOut.from
    ? t("settings.arrivalTimes.day.between", { from: day.checkOut.from, to: day.checkOut.by })
    : t("settings.arrivalTimes.day.by", { time: day.checkOut.by });
  const checkIn = day.checkIn.until
    ? t("settings.arrivalTimes.day.between", {
        from: day.checkIn.from,
        to: until(t, day.checkIn.until),
      })
    : t("settings.arrivalTimes.day.from", { time: day.checkIn.from });
  const summary = t("settings.arrivalTimes.day.summary", { checkOut, checkIn });
  return day.turnover !== null && day.turnover > 0
    ? `${summary} ${t("settings.arrivalTimes.day.turnover", { duration: duration(t, day.turnover) })}`
    : summary;
}

export function fieldError(t: Translate, error: ArrivalFieldError): string {
  switch (error.kind) {
    case "pickTime":
      return t("settings.arrivalTimes.error.pickTime");
    case "laterThan":
      return t("settings.arrivalTimes.error.laterThan", { time: error.time });
    case "earlierThan":
      return t("settings.arrivalTimes.error.earlierThan", { time: error.time });
    case "age":
      return t("settings.arrivalTimes.error.age");
  }
}

/** "Central Indonesia Time (UTC+8)" in the user's language, for the property's IANA time zone; null when unknown. */
export function timeZoneLabel(timeZone: string, locale: string, at = new Date()): string | null {
  if (!timeZone) return null;
  try {
    const part = (timeZoneName: "long" | "shortOffset") =>
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName })
        .formatToParts(at)
        .find((item) => item.type === "timeZoneName")?.value ?? "";
    const name = part("long");
    const offset = part("shortOffset").replace(/^GMT/, "UTC");
    if (!name) return null;
    return offset && offset !== name ? `${name} (${offset})` : name;
  } catch {
    return null;
  }
}
