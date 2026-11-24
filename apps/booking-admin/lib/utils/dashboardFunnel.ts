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

/** The card's six steps (VAY-2594): the API's stages, without add-ons and card authorization. */
export const FUNNEL_DISPLAY_STEPS = [
  ["page_visit", "visitors"],
  ["dates_searched", "searched"],
  ["rate_selected", "selected"],
  ["details_completed", "details"],
  ["complete_booking_clicked", "payment"],
  ["booking_completed", "confirmed"],
] as const;

export type FunnelDisplayRow = {
  stage: string;
  /** Its label key under dashboard.funnelSteps. */
  key: (typeof FUNNEL_DISPLAY_STEPS)[number][1];
  count: number;
  /** % of the step before that got here; null on the first step or after an empty one. */
  continued: number | null;
  /** Bar width in %, relative to the visitors. */
  width: number;
};

/**
 * The six steps with each one's share of the step before, and the visitors who booked overall.
 * A step the API doesn't send (an older API without searched dates) is left out.
 */
export function funnelDisplay(funnel: ConversionFunnel): {
  rows: FunnelDisplayRow[];
  overall: number | null;
} {
  const byStage = new Map(funnel.steps.map((step) => [step.stage, step.count]));
  const visitors = byStage.get("page_visit") ?? 0;
  const rows: FunnelDisplayRow[] = [];
  for (const [stage, key] of FUNNEL_DISPLAY_STEPS) {
    const count = byStage.get(stage);
    if (count === undefined) continue;
    const before = rows.length > 0 ? rows[rows.length - 1].count : null;
    rows.push({
      stage,
      key,
      count,
      continued: before ? Math.round((count / before) * 100) : null,
      width: visitors > 0 ? Math.max(count > 0 ? 3 : 0, (count / visitors) * 100) : 0,
    });
  }
  const booked = byStage.get("booking_completed") ?? 0;
  return { rows, overall: visitors > 0 ? (booked / visitors) * 100 : null };
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
