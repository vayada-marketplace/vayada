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
 * Conversion rate in %: confirmed bookings ÷ visitors, both from one period's funnel, so the card
 * and the funnel agree (VAY-2594). Null without visitors.
 */
export function conversionRate(steps: readonly { stage: string; count: number }[]): number | null {
  const visits = steps.find(({ stage }) => stage === "page_visit")?.count ?? 0;
  const bookings = steps.find(({ stage }) => stage === "booking_completed")?.count ?? 0;
  return visits > 0 ? (bookings / visits) * 100 : null;
}

/**
 * Compares two conversion rates in hundredths of a percent. No comparison without a previous
 * rate (no visitors then), and "No data yet" without a current one.
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
