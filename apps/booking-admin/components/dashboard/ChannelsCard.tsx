"use client";

import { useState } from "react";
import { formatNumber } from "@/lib/utils";
import { channelRows, roundedShares, type ChannelChange } from "@/lib/utils/channelMix";
import type { ChannelMix } from "@/services/dashboard";

/** Brand colors for booking channels (VAY-2594). */
const CHANNEL_COLORS: Record<string, string> = {
  direct: "#2B4BF2",
  booking_com: "#003580",
  airbnb: "#FF5A5F",
  agoda: "#9CA3AF",
  expedia: "#F59E0B",
  other_ota: "#6B7280",
  unknown: "#D1D5DB",
};

/** Where direct guests came from, as the hotel records it on the booking. */
const SOURCE_COLORS: Record<string, string> = {
  booking_engine: "#2B4BF2",
  social_media: "#E1306C",
  whatsapp: "#25D366",
  email: "#0EA5E9",
  call: "#93A4F8",
  walk_in: "#9CA3AF",
  other: "#D1D5DB",
};

type Scope = "all" | "direct";
type View = "bars" | "donut";

type Props = {
  data: ChannelMix | null;
  loading: boolean;
  error: boolean;
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
};

function changeText(change: ChannelChange, t: Props["t"]): string {
  if (change.kind === "new") return t("dashboard.channels.new");
  if (change.kind === "unchanged") return "± 0%";
  return `${change.kind === "up" ? "↑" : "↓"} ${change.percent}%`;
}

function changeColor(change: ChannelChange): string {
  if (change.kind === "up" || change.kind === "new") return "text-[#0F7A3D]";
  if (change.kind === "down") return "text-[#B42318]";
  return "text-gray-500";
}

const segment = (on: boolean) =>
  `rounded-[7px] text-[13px] transition-colors ${
    // One weight either way, so switching never changes the toggles' width.
    on
      ? "bg-white font-medium text-gray-900 shadow-sm"
      : "font-medium text-gray-500 hover:text-gray-900"
  }`;

/**
 * Bookings by channel (VAY-2594): every channel's share of the range's bookings, or the direct ones
 * by source, as bars or a donut, each with the share's change against the period before. The
 * toggles keep their place whichever is on; a longer subtitle wraps under the title instead.
 */
export function ChannelsCard({ data, loading, error, locale, t }: Props) {
  const [scope, setScope] = useState<Scope>("all");
  const [view, setView] = useState<View>("bars");
  const counts = data ? (scope === "all" ? data.channels : data.sources) : [];
  const rows = channelRows(counts);
  const shares = roundedShares(rows.map((row) => row.share));
  const total = rows.reduce((sum, row) => sum + row.bookings, 0);
  const colors = scope === "all" ? CHANNEL_COLORS : SOURCE_COLORS;
  const label = (key: string) =>
    t(scope === "all" ? `dashboard.channels.name.${key}` : `dashboard.channels.source.${key}`);
  const color = (key: string) => colors[key] ?? "#D1D5DB";

  let start = 0;
  const gradient = rows
    .map((row) => {
      const from = start;
      start += row.share;
      return `${color(row.key)} ${from}% ${start}%`;
    })
    .join(", ");

  return (
    <section
      className={`flex min-w-0 flex-col gap-4 rounded-xl border border-gray-200 bg-white p-5 ${loading ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-[1_1_160px] flex-col gap-0.5">
          <h2 className="text-base font-semibold text-gray-900">{t("dashboard.channels.title")}</h2>
          <span className="text-[13px] text-gray-500">
            {t(
              scope === "all"
                ? "dashboard.channels.subtitleAll"
                : "dashboard.channels.subtitleDirect",
            )}
          </span>
        </div>
        {/* Wraps on narrow cards and in longer languages rather than sticking out. */}
        <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
          <div
            role="group"
            aria-label={t("dashboard.channels.scopeLabel")}
            className="flex gap-0.5 rounded-lg bg-[#ECEEF2] p-[3px]"
          >
            {(["all", "direct"] as const).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={scope === key}
                onClick={() => setScope(key)}
                className={`px-2.5 py-[5px] ${segment(scope === key)}`}
              >
                {t(key === "all" ? "dashboard.channels.all" : "dashboard.channels.direct")}
              </button>
            ))}
          </div>
          <div
            role="group"
            aria-label={t("dashboard.channels.viewLabel")}
            className="flex gap-0.5 rounded-lg bg-[#ECEEF2] p-[3px]"
          >
            <button
              type="button"
              aria-label={t("dashboard.channels.showBars")}
              aria-pressed={view === "bars"}
              onClick={() => setView("bars")}
              className={`flex h-[26px] w-[30px] items-center justify-center ${segment(view === "bars")}`}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M4 6h16M4 12h10M4 18h6" />
              </svg>
            </button>
            <button
              type="button"
              aria-label={t("dashboard.channels.showDonut")}
              aria-pressed={view === "donut"}
              onClick={() => setView("donut")}
              className={`flex h-[26px] w-[30px] items-center justify-center ${segment(view === "donut")}`}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="8" />
                <path d="M12 4v8l6 5" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <p className="py-6 text-center text-sm text-gray-500">{t("dashboard.channels.error")}</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-500">
          {loading
            ? t("common.loading")
            : t(scope === "all" ? "dashboard.channels.empty" : "dashboard.channels.emptyDirect")}
        </p>
      ) : view === "bars" ? (
        <ul className="flex flex-col gap-3.5">
          {rows.map((row, index) => (
            <li key={row.key} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                  style={{ background: color(row.key) }}
                />
                <span className="min-w-0 flex-1 truncate font-medium text-gray-900">
                  {label(row.key)}
                </span>
                <span className="whitespace-nowrap text-gray-500">
                  {t(
                    row.bookings === 1
                      ? "dashboard.channels.booking"
                      : "dashboard.channels.bookings",
                    {
                      count: formatNumber(row.bookings, locale),
                    },
                  )}
                </span>
                <span className="min-w-[40px] text-right font-semibold text-gray-900">
                  {shares[index]}%
                </span>
                <span
                  className={`min-w-[52px] whitespace-nowrap text-right text-xs font-semibold ${changeColor(row.change)}`}
                >
                  {changeText(row.change, t)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-[#F0F2F5]">
                <div
                  className="h-full rounded"
                  style={{ width: `${row.width}%`, background: color(row.key) }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          <div
            role="img"
            aria-label={t("dashboard.channels.donutLabel", {
              summary: rows.map((row, index) => `${label(row.key)} ${shares[index]}%`).join(", "),
            })}
            className="flex h-40 w-40 shrink-0 items-center justify-center rounded-full"
            style={{ background: `conic-gradient(${gradient})` }}
          >
            <div className="flex h-28 w-28 flex-col items-center justify-center rounded-full bg-white">
              <span className="text-[22px] font-bold text-gray-900">
                {formatNumber(total, locale)}
              </span>
              <span className="text-xs text-gray-500">
                {t(
                  total === 1
                    ? "dashboard.channels.centerBooking"
                    : "dashboard.channels.centerBookings",
                )}
              </span>
            </div>
          </div>
          {/* Fixed columns, so long names never push the numbers out of line or out of the card. */}
          <ul className="flex min-w-0 flex-[1_1_240px] flex-col gap-3">
            {rows.map((row, index) => (
              <li
                key={row.key}
                className="grid grid-cols-[10px_minmax(0,1fr)_28px_44px_60px] items-center gap-x-2 text-sm"
              >
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-[3px]"
                  style={{ background: color(row.key) }}
                />
                <span className="truncate text-gray-900">{label(row.key)}</span>
                <span className="text-right text-gray-500">
                  {formatNumber(row.bookings, locale)}
                </span>
                <span className="text-right font-semibold text-gray-900">{shares[index]}%</span>
                <span
                  className={`whitespace-nowrap text-right text-xs font-semibold ${changeColor(row.change)}`}
                >
                  {changeText(row.change, t)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
