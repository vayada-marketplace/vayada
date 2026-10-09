"use client";

import { useEffect, useId, useRef, useState } from "react";
import { formatNumber } from "@/lib/utils";
import { funnelCsv, funnelRows } from "@/lib/utils/dashboardFunnel";
import type { ConversionFunnel } from "@/services/dashboard";

type Props = {
  funnel: ConversionFunnel | null;
  loading: boolean;
  error: boolean;
  locale: string;
  t: (key: string) => string;
  exportFileName: string;
};

// Branch rows compare with their own eligible cohort rather than the row above.
const DROP_BASE: Record<string, string> = {
  payment_authorized: "dashboard.funnel.ofCardClicks",
  booking_completed: "dashboard.funnel.ofEligibleSubmissions",
};

export function ConversionFunnelCard({ funnel, loading, error, locale, t, exportFileName }: Props) {
  const tooltipId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const rows = funnel?.steps.some((step) => step.count > 0) ? funnelRows(funnel) : null;

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

  const exportCsv = () => {
    setMenuOpen(false);
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

  const percent = (value: number | null) =>
    value === null ? "—" : `${formatNumber(value, locale)}%`;

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
            <div className="absolute right-0 top-full z-10 mt-1 min-w-36 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
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

      {rows ? (
        <ol className="space-y-3.5" aria-busy={loading}>
          {rows.map(({ stage, count, percentOfVisits, drop, dropPercent }) => (
            <li
              key={stage}
              className={stage === "payment_authorized" ? "pl-3 border-l-2 border-gray-200" : ""}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 mb-1.5">
                <span className="text-[13px] text-gray-900">
                  {t(`dashboard.funnel.${stage}`)}{" "}
                  <span className="text-gray-500">&middot; {formatNumber(count, locale)}</span>
                </span>
                <span className="flex items-baseline gap-2 text-[13px]">
                  <span className="text-gray-900">{percent(percentOfVisits)}</span>
                  {drop !== null && (
                    <span
                      className={`text-xs ${drop > 0 ? "text-red-600" : "text-gray-400"}`}
                      title={DROP_BASE[stage] ? t(DROP_BASE[stage]) : undefined}
                    >
                      {drop > 0 ? "\u2212" : ""}
                      {formatNumber(drop, locale)} ({percent(dropPercent)})
                      {DROP_BASE[stage] && <span className="sr-only"> {t(DROP_BASE[stage])}</span>}
                    </span>
                  )}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
                <div
                  className={`h-full rounded-full bg-gradient-to-r ${stage === "booking_completed" ? "from-green-400 to-green-700" : "from-primary-300 to-primary-600"}`}
                  style={{ width: `${Math.min(Math.max(percentOfVisits ?? 0, 0), 100)}%` }}
                />
              </div>
              {stage === "complete_booking_clicked" && funnel && (
                <div className="flex flex-wrap gap-x-3 text-xs text-gray-500 mt-1.5">
                  {funnel.paymentMethods.map(({ method, count: methodCount }) => (
                    <span key={method}>
                      {t(`dashboard.funnel.method.${method}`)}: {formatNumber(methodCount, locale)}{" "}
                      (
                      {count
                        ? formatNumber(Math.round((methodCount / count) * 1000) / 10, locale)
                        : 0}
                      %)
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
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
