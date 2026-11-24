export type SummaryChange = { kind: "change"; up: boolean; amount: number; percent: number | null };
export type SummaryComparison = { kind: "noData" } | { kind: "unchanged" } | SummaryChange;

/** Change against the comparison window; percent is null when the previous value was 0. */
export function compareSummary(current: number, previous: number): SummaryComparison {
  const diff = current - previous;
  if (current === 0 && previous === 0) return { kind: "noData" };
  if (diff === 0) return { kind: "unchanged" };
  return {
    kind: "change",
    up: diff > 0,
    amount: Math.abs(diff),
    percent: previous > 0 ? (Math.abs(diff) / previous) * 100 : null,
  };
}

/**
 * Conversion rate in %: bookings made on the booking page ÷ its page views in the same period
 * (VAY-2594), counted only since the page counts every visit. Null without page views, or when
 * the API doesn't send them.
 */
export function conversionRate(bookings: number | null, pageViews: number | null): number | null {
  return bookings !== null && pageViews !== null && pageViews > 0
    ? (bookings / pageViews) * 100
    : null;
}

/**
 * Compares two conversion rates in hundredths of a percent. No comparison without a previous
 * rate (no page views then), and "No data yet" without a current one.
 */
export function compareConversion(
  current: number | null,
  previous: number | null,
): SummaryComparison | null {
  if (current === null) return { kind: "noData" };
  if (previous === null) return null;
  const now = Math.round(current * 100);
  const before = Math.round(previous * 100);
  return now === before ? { kind: "unchanged" } : compareSummary(now, before);
}

/**
 * The trend line in a 100 x 32 box. Null (a flat grey line) until at least two points exist and
 * one of them is nonzero; a flat nonzero series sits mid-box.
 */
export function sparklinePath(values: number[]): string | null {
  if (values.length < 2 || values.every((value) => value === 0)) return null;
  const min = Math.min(...values);
  const range = Math.max(...values) - min;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = range ? 30 - ((value - min) / range) * 28 : 16;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return `M${points.join(" L")}`;
}
