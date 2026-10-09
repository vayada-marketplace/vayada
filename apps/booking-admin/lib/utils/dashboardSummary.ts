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

/** A period without bookings has no nightly rate rather than a rate of 0. */
export function compareRate(
  current: { rate: number; bookings: number },
  previous: { rate: number; bookings: number },
): SummaryComparison | null {
  if (current.bookings === 0) return { kind: "noData" };
  if (previous.bookings === 0) return null;
  return compareSummary(Math.round(current.rate), Math.round(previous.rate));
}

export type SparklineShape = { line: string; area: string } | null;

/**
 * Line and filled-area paths in a 100 x 32 box. Returns null (flat grey line) until at
 * least two points exist and one of them is nonzero; a flat nonzero series sits mid-box.
 */
export function sparklineShape(values: number[]): SparklineShape {
  if (values.length < 2 || values.every((value) => value === 0)) return null;
  const min = Math.min(...values);
  const range = Math.max(...values) - min;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = range ? 30 - ((value - min) / range) * 28 : 16;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${points.join(" L")}`;
  return { line, area: `${line} L100,32 L0,32 Z` };
}
