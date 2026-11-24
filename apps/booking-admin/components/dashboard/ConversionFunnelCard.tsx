"use client";

import { useEffect, useId, useRef, useState } from "react";
import { formatNumber } from "@/lib/utils";
import { funnelCsv, funnelDisplay, funnelRows } from "@/lib/utils/dashboardFunnel";
import { TIME_RANGES, type ConversionFunnel, type TimeRange } from "@/services/dashboard";

type Props = {
  funnel: ConversionFunnel | null;
  loading: boolean;
  error: boolean;
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  exportFileName: string;
  /** The page's selected range; the page tabs and this menu share it. */
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  /** Opens the Details window on conversion (VAY-2594). */
  onDetails?: () => void;
};

export function ConversionFunnelCard({
  funnel,
  loading,
  error,
  locale,
  t,
  exportFileName,
  timeRange,
  onTimeRangeChange,
  onDetails,
}: Props) {
  const tooltipId = useId();
  const rangeLabelId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  // The six steps of the card (VAY-2594); the CSV keeps every stage.
  const display = funnel?.steps.some((step) => step.count > 0) ? funnelDisplay(funnel) : null;

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // Closing the popover removes the focused option, so hand focus back to its button.
  const closeMenu = () => {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  };

  const exportCsv = () => {
    closeMenu();
    if (!funnel) return;
    const csv = funnelCsv(
      funnelRows(funnel),
      locale,
      [
        t("dashboard.conversionFunnel.csvStep"),
        t("dashboard.conversionFunnel.csvVisitors"),
        t("dashboard.conversionFunnel.csvPercentOfVisits"),
        t("dashboard.conversionFunnel.csvLost"),
        t("dashboard.conversionFunnel.csvLostPercent"),
      ],
      (stage) => t(`dashboard.funnel.${stage}`),
    );
    // The byte-order mark lets spreadsheet apps read non-Latin step names as UTF-8.
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName;
    document.body.append(link);
    link.click();
    link.remove();
    // Safari can fail a download whose object URL is revoked right after the click.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            {t("dashboard.conversionFunnel.title")}
          </h3>
          <div className="group relative mt-0.5 flex items-center gap-1.5 text-[13px] text-gray-500">
            <span>{t("dashboard.conversionFunnel.subtitle")}</span>
            <button
              type="button"
              aria-label={t("dashboard.conversionFunnel.infoLabel")}
              aria-describedby={tooltipId}
              className="rounded-full text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"
                />
              </svg>
            </button>
            {/* Anchored to the row start, not the icon, so long subtitles cannot push it off-card. */}
            <span
              id={tooltipId}
              role="tooltip"
              className="pointer-events-none invisible absolute left-0 top-full z-10 mt-2 w-72 max-w-[calc(100vw-4rem)] rounded-lg bg-gray-900 px-3 py-2 text-xs leading-relaxed text-white opacity-0 shadow-lg transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
            >
              {t("dashboard.conversionFunnel.info")}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onDetails && (
            <button
              type="button"
              onClick={onDetails}
              aria-label={t("dashboard.details.open.conversion")}
              className="h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-[13px] font-medium text-gray-900 hover:bg-gray-50"
            >
              {t("dashboard.stats.details")} ›
            </button>
          )}
          <div ref={menuRef} className="relative">
            <button
              ref={menuButtonRef}
              type="button"
              aria-label={t("dashboard.conversionFunnel.options")}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.5" />
                <circle cx="12" cy="12" r="1.5" />
                <circle cx="19" cy="12" r="1.5" />
              </svg>
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-10 mt-1 min-w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                <p
                  id={rangeLabelId}
                  className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400"
                >
                  {t("dashboard.conversionFunnel.timeRange")}
                </p>
                <div role="group" aria-labelledby={rangeLabelId}>
                  {TIME_RANGES.map(([range, label]) => (
                    <button
                      key={range}
                      type="button"
                      aria-pressed={timeRange === range}
                      onClick={() => {
                        closeMenu();
                        onTimeRangeChange(range);
                      }}
                      className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] text-gray-700 hover:bg-gray-50"
                    >
                      {t(label)}
                      {timeRange === range && (
                        <svg
                          className="w-4 h-4 text-primary-600"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                          aria-hidden="true"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="m4.5 12.75 6 6 9-13.5"
                          />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
                <div className="my-1 border-t border-gray-100" />
                <button
                  type="button"
                  disabled={!funnel}
                  onClick={exportCsv}
                  className="block w-full px-3 py-1.5 text-left text-[13px] text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400"
                >
                  {t("dashboard.conversionFunnel.exportCsv")}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {display ? (
        <div className="flex flex-col gap-3" aria-busy={loading}>
          <ol className="flex flex-col gap-2.5">
            {display.rows.map((row) => (
              <li
                key={row.stage}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:flex-nowrap"
              >
                <span className="w-full shrink-0 text-[13px] text-gray-700 sm:w-[150px]">
                  {t(`dashboard.funnelSteps.${row.key}`)}
                </span>
                <div className="h-7 min-w-0 flex-1 overflow-hidden rounded-md bg-[#F6F7F9]">
                  {row.count > 0 ? (
                    <div
                      className="flex h-full min-w-[44px] items-center rounded-md bg-[#2B4BF2]"
                      style={{ width: `${row.width}%` }}
                    >
                      <span className="pl-2 text-xs font-semibold text-white">
                        {formatNumber(row.count, locale)}
                      </span>
                    </div>
                  ) : (
                    // Nobody reached this step: no bar, a grey 0 on the empty track.
                    <span className="flex h-full items-center pl-2 text-xs font-semibold text-gray-400">
                      {formatNumber(0, locale)}
                    </span>
                  )}
                </div>
                <span className="w-[54px] shrink-0 text-right text-xs text-gray-500">
                  {row.continued === null ? "" : `${formatNumber(row.continued, locale)}%`}
                </span>
              </li>
            ))}
          </ol>
          <div className="flex justify-between gap-3 border-t border-[#F0F2F5] pt-3 text-[13px]">
            <span className="text-gray-500">{t("dashboard.funnelSteps.overallLabel")}</span>
            <span className="font-semibold text-gray-900">
              {display.overall === null
                ? "—"
                : t("dashboard.funnelSteps.overall", {
                    percent: formatNumber(display.overall, locale, {
                      maximumFractionDigits: display.overall < 10 ? 2 : 1,
                    }),
                  })}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-gray-500 text-center py-8" aria-busy={loading}>
          {loading
            ? t("common.loading")
            : error
              ? t("dashboard.funnel.error")
              : t("dashboard.conversionFunnel.noData")}
        </p>
      )}
    </div>
  );
}
