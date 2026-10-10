import type { ConversionFunnel } from "@/services/dashboard";

export type FunnelRow = {
  stage: string;
  count: number;
  percentOfVisits: number | null;
  /** Guests lost since the eligible previous step; null on the first row or an empty previous step. */
  drop: number | null;
  dropPercent: number | null;
};

/**
 * The API's previousCount is the eligible previous step: card clicks for the card-only
 * authorization row, authorized cards plus non-card submissions for completion. Using it
 * keeps non-card guests out of the authorization drop and completion from going negative.
 */
export function funnelRows(funnel: ConversionFunnel): FunnelRow[] {
  return funnel.steps.map(({ stage, count, percentOfVisits, previousCount }, index) => {
    const drop = index > 0 && previousCount > 0 ? Math.max(previousCount - count, 0) : null;
    return {
      stage,
      count,
      percentOfVisits,
      drop,
      dropPercent: drop === null ? null : Math.round((drop / previousCount) * 1000) / 10,
    };
  });
}

/**
 * Spreadsheet apps in comma-decimal locales (de, fr, it, es, nl, ru, id) split columns on
 * ";", so those exports use ";" and comma decimals; others use "," and dot decimals.
 */
export function funnelCsv(
  rows: FunnelRow[],
  locale: string,
  header: string[],
  label: (stage: string) => string,
) {
  const decimal =
    new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")
      ?.value ?? ".";
  const separator = decimal === "," ? ";" : ",";
  const cell = (value: string | number | null) =>
    `"${(typeof value === "number" ? String(value).replace(".", decimal) : (value ?? "")).replaceAll('"', '""')}"`;
  return [
    header,
    ...rows.map((row) => [
      label(row.stage),
      row.count,
      row.percentOfVisits,
      row.drop,
      row.dropPercent,
    ]),
  ]
    .map((line) => line.map(cell).join(separator))
    .join("\r\n");
}
