/** VAY-2391: when an extra happens, in PMS's date style: "Mon, Nov 16"; "Nov 16 – Nov 18" over
 * consecutive days, "Mon, Nov 16 · Wed, Nov 18" otherwise; null without a day. */
export function formatServiceDays(dates: string[] | undefined, locale?: string): string | null {
  const days = Array.from(new Set(dates ?? [])).sort();
  if (!days.length) return null;
  const day = (iso: string, weekday: boolean) =>
    new Date(iso + "T00:00:00").toLocaleDateString(locale, {
      ...(weekday ? { weekday: "short" as const } : {}),
      day: "numeric",
      month: "short",
    });
  const consecutive = days.every(
    (date, index) => index === 0 || Date.parse(date) - Date.parse(days[index - 1]!) === 86400000,
  );
  if (days.length === 1) return day(days[0]!, true);
  return consecutive
    ? `${day(days[0]!, false)} – ${day(days[days.length - 1]!, false)}`
    : days.map((date) => day(date, true)).join(" · ");
}
