"use client";

import { formatNumber } from "@/lib/utils";
import { sparklinePath, type SummaryComparison } from "@/lib/utils/dashboardSummary";

type Props = {
  label: string;
  value: string;
  comparison: SummaryComparison | null;
  locale: string;
  t: (key: string) => string;
  sparkline: number[];
  onClick?: () => void;
  ariaLabel?: string;
};

// The design's green and red for changes and trend lines (VAY-2594).
const UP_TEXT = "text-[#0F7A3D]";
const DOWN_TEXT = "text-[#B42318]";
const UP_LINE = "#16A34A";
const DOWN_LINE = "#D92D20";
const FLAT_LINE = "#9CA3AF";

/** A KPI card: label, trend line, value and the relative change against the previous period. */
export function SummaryCard({
  label,
  value,
  comparison,
  locale,
  t,
  sparkline,
  onClick,
  ariaLabel,
}: Props) {
  const change = comparison?.kind === "change" ? comparison : null;
  const body = (
    <>
      <span className="flex w-full items-start justify-between gap-2">
        <span className="pt-0.5 text-[11px] font-semibold uppercase leading-tight tracking-[0.06em] text-gray-500">
          {label}
        </span>
        <Sparkline
          values={sparkline}
          color={change ? (change.up ? UP_LINE : DOWN_LINE) : FLAT_LINE}
        />
      </span>
      <span className="w-full truncate text-2xl font-bold tracking-tight text-gray-900">
        {value}
      </span>
      <span className="flex min-h-4 w-full items-center justify-between gap-1.5">
        {comparison && (
          <span
            className={`text-xs font-medium ${change ? (change.up ? UP_TEXT : DOWN_TEXT) : "text-gray-500"}`}
          >
            {changeText(comparison, locale, t)}
          </span>
        )}
        {onClick && (
          <span className="ml-auto shrink-0 text-xs font-medium text-primary-600">
            {t("dashboard.stats.details")} ›
          </span>
        )}
      </span>
    </>
  );
  const className =
    "flex flex-col gap-2.5 rounded-xl border border-gray-200 bg-white p-4 text-left text-gray-900";
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={`${className} cursor-pointer transition-all hover:border-gray-300 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-300`}
    >
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** Always a relative change: "↑ 18% vs prev. period", never points or amounts (VAY-2594). */
function changeText(
  comparison: SummaryComparison,
  locale: string,
  t: (key: string) => string,
): string {
  if (comparison.kind === "noData") return t("dashboard.stats.noDataYet");
  const vs = t("dashboard.stats.vsPreviousPeriod");
  if (comparison.kind === "unchanged") return `± 0% ${vs}`;
  if (comparison.percent === null) return `↑ ${t("dashboard.stats.upFromZero")}`;
  const rounded = Math.round(comparison.percent);
  const percent = rounded === 0 ? "<1" : formatNumber(rounded, locale);
  return `${comparison.up ? "↑" : "↓"} ${percent}% ${vs}`;
}

// Decorative trend line: no axes, tooltips or hover states.
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const path = sparklinePath(values);
  return (
    <svg
      className="h-[26px] w-[72px] shrink-0 overflow-visible"
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d={path ?? "M0,30 L100,30"}
        fill="none"
        stroke={path ? color : "#D1D5DB"}
        strokeWidth={1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
