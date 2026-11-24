/** Helpers for the dashboard's revenue chart and its day window (VAY-2594). */

/**
 * The chart's top line: a round number at or above the best day whose half is round too, as in
 * "IDR 8M / IDR 4M / 0". Zero without revenue.
 */
export function chartCeiling(max: number): number {
  if (!(max > 0)) return 0;
  const power = Math.pow(10, Math.floor(Math.log10(max)));
  for (const step of [1, 2, 4, 5, 6, 8]) {
    if (step * power >= max) return step * power;
  }
  return 10 * power;
}

/** Bar height in px: at least 3px for a day with bookings, a 2px grey line without. */
export function barHeight(revenue: number, bookings: number, ceiling: number, height: number) {
  if (bookings === 0) return 2;
  return Math.max(3, ceiling > 0 ? Math.round((revenue / ceiling) * height) : 3);
}

/** Which days get a date under the chart: the first, the last and up to three spread between. */
export function axisLabelIndexes(count: number, labels = 5): number[] {
  if (count <= labels) return Array.from({ length: count }, (_, index) => index);
  return Array.from({ length: labels }, (_, k) => Math.round((k * (count - 1)) / (labels - 1)));
}

/** A tooltip near either edge lines up with that side, so it isn't cut off. */
export function tooltipAlign(index: number, count: number): "left" | "center" | "right" {
  if (index < count * 0.2) return "left";
  if (index > count * 0.8) return "right";
  return "center";
}

/** The closest days with bookings before and after this one, for the day window's arrows. */
export function neighbourBookingDays(
  days: readonly { date: string; bookings: number }[],
  date: string,
): { previous: string | null; next: string | null } {
  const booked = days.filter((day) => day.bookings > 0).map((day) => day.date);
  const before = booked.filter((day) => day < date);
  return {
    previous: before.length > 0 ? before[before.length - 1] : null,
    next: booked.find((day) => day > date) ?? null,
  };
}
