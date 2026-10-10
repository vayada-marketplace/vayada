"use client";

import { useId, type ReactNode } from "react";
import {
  sparklineShape,
  type SummaryChange,
  type SummaryComparison,
} from "@/lib/utils/dashboardSummary";

type Props = {
  icon: ReactNode;
  label: string;
  value: string;
  comparison: SummaryComparison | null;
  /** Formats a change without its sign, e.g. "18%", "LKR 22" or "1". */
  formatChange: (change: SummaryChange) => string;
  vsLabel: string;
  t: (key: string) => string;
  sparkline: number[];
  onClick?: () => void;
  ariaLabel?: string;
};

export function SummaryCard({
  icon,
  label,
  value,
  comparison,
  formatChange,
  vsLabel,
  t,
  sparkline,
  onClick,
  ariaLabel,
}: Props) {
  const body = (
    <>
      <div className="flex w-full items-start justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 pt-1 text-[11px] font-semibold uppercase leading-tight tracking-wider text-gray-500">
          <span className="shrink-0">{icon}</span>
          {label}
        </span>
        <Sparkline values={sparkline} />
      </div>
      <p className="mt-2 w-full truncate text-xl font-bold text-gray-900 md:text-2xl">{value}</p>
      {comparison && (
        <p
          className={`mt-1 text-[13px] ${
            comparison.kind !== "change"
              ? "text-gray-500"
              : comparison.up
                ? "text-green-600"
                : "text-red-500"
          }`}
        >
          {comparison.kind === "noData"
            ? t("dashboard.stats.noDataYet")
            : comparison.kind === "unchanged"
              ? t("dashboard.stats.samePeriod")
              : `${comparison.up ? "↑ +" : "↓ -"}${formatChange(comparison)} ${vsLabel}`}
        </p>
      )}
    </>
  );
  const className = "bg-white border border-gray-200 rounded-xl p-3 md:p-4 flex flex-col";
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={`${className} text-left hover:border-gray-300 hover:shadow-sm transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-300`}
    >
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

// Decorative trend line: no axes, tooltips or hover states.
function Sparkline({ values }: { values: number[] }) {
  const gradientId = `sparkline-${useId().replace(/:/g, "")}`;
  const shape = sparklineShape(values);
  return (
    <svg
      className="h-8 w-1/4 min-w-14 max-w-28 shrink-0 overflow-visible"
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {shape ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22C55E" stopOpacity={0.18} />
              <stop offset="100%" stopColor="#22C55E" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={shape.area} fill={`url(#${gradientId})`} />
          <path
            d={shape.line}
            fill="none"
            stroke="#16A34A"
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : (
        <path
          d="M0,30 L100,30"
          stroke="#D1D5DB"
          strokeWidth={1.75}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
