"use client";

import { useState } from "react";
import { formatNumber } from "@/lib/utils";
import { roundedShares } from "@/lib/utils/channelMix";
import {
  TIME_RANGE_NAMES,
  type GuestInsights as Insights,
  type TimeRange,
} from "@/services/dashboard";

type Tab = "nationality" | "age" | "stay";

type Props = {
  data: Insights | null;
  loading: boolean;
  error: boolean;
  range: TimeRange;
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
};

/** Up to five countries, then the rest together. */
const SHOWN_COUNTRIES = 5;

function countryName(code: string, locale: string): string {
  try {
    const names = new Intl.DisplayNames([locale], { type: "region" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The country's flag emoji, from its two regional indicator letters. */
function flag(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return "";
  // U+1F1E6 (A) onwards, written as surrogate pairs for the ES5 target.
  const letter = (index: number) =>
    String.fromCharCode(0xd83c, 0xdde6 + code.charCodeAt(index) - 65);
  return letter(0) + letter(1);
}

/**
 * Guest insights (VAY-2594): who booked in the range across every channel, as four tiles and
 * one breakdown at a time (nationality, age at arrival or length of stay).
 */
export function GuestInsights({ data, loading, error, range, locale, t }: Props) {
  const [tab, setTab] = useState<Tab>("nationality");
  const guests = (count: number) =>
    t(count === 1 ? "dashboard.guests.guest" : "dashboard.guests.guests", {
      count: formatNumber(count, locale),
    });
  const average = (value: number, one: string, many: string) =>
    t(value === 1 ? one : many, {
      count: formatNumber(value, locale, { maximumFractionDigits: 1 }),
    });

  let rows: { label: string; count: number; flag?: string }[] = [];
  if (data && tab === "nationality") {
    const top = data.nationalities.filter((row) => row.country).slice(0, SHOWN_COUNTRIES);
    const rest = data.guests - top.reduce((sum, row) => sum + row.guests, 0);
    rows = top.map((row) => ({
      label: countryName(row.country!, locale),
      count: row.guests,
      flag: flag(row.country!),
    }));
    if (rest > 0) rows.push({ label: t("dashboard.guests.otherCountries"), count: rest });
  } else if (data && tab === "age") {
    rows = data.ages.map((row) => ({
      label: t(`dashboard.guests.age.${row.bucket}`),
      count: row.guests,
    }));
  } else if (data) {
    rows = data.stays.map((row) => ({
      label: t(`dashboard.guests.stay.${row.bucket}`),
      count: row.guests,
    }));
  }
  const base = tab === "age" ? (data?.age_known ?? 0) : (data?.guests ?? 0);
  const shares = roundedShares(rows.map((row) => (base > 0 ? (row.count / base) * 100 : 0)));
  const largest = Math.max(0, ...rows.map((row) => row.count));
  const topMarket = data?.nationalities.find((row) => row.country)?.country ?? null;

  const tile = (label: string, value: string) => (
    <div className="flex flex-col gap-0.5 rounded-[10px] bg-[#F6F7F9] px-3.5 py-3">
      <span className="text-xs text-gray-500">{label}</span>
      <span title={value} className="truncate text-lg font-bold text-gray-900">
        {value}
      </span>
    </div>
  );

  return (
    <section
      className={`flex min-w-0 flex-col gap-[18px] rounded-xl border border-gray-200 bg-white p-5 ${loading ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-base font-semibold text-gray-900">{t("dashboard.guests.title")}</h2>
          <span className="text-[13px] text-gray-500">
            {t("dashboard.guests.subtitle", { range: t(TIME_RANGE_NAMES[range]) })}
          </span>
        </div>
        <div
          role="group"
          aria-label={t("dashboard.guests.tabsLabel")}
          className="flex flex-wrap gap-0.5 rounded-lg bg-[#ECEEF2] p-[3px]"
        >
          {(["nationality", "age", "stay"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
              className={`rounded-[7px] px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                tab === key
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {t(`dashboard.guests.tab.${key}`)}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="py-6 text-center text-sm text-gray-500">{t("dashboard.guests.error")}</p>
      ) : !data || data.guests === 0 ? (
        <p className="py-6 text-center text-sm text-gray-500">
          {loading ? t("common.loading") : t("dashboard.guests.empty")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-6">
          <div className="grid flex-[1_1_240px] grid-cols-2 gap-2.5 self-start">
            {tile(t("dashboard.guests.tile.guests"), formatNumber(data.guests, locale))}
            {tile(
              t("dashboard.guests.tile.topMarket"),
              topMarket ? countryName(topMarket, locale) : "—",
            )}
            {tile(
              t("dashboard.guests.tile.averageStay"),
              data.average_nights === null
                ? "—"
                : average(data.average_nights, "dashboard.guests.night", "dashboard.guests.nights"),
            )}
            {tile(
              t("dashboard.guests.tile.averageLead"),
              data.average_lead_days === null
                ? "—"
                : average(
                    Math.round(data.average_lead_days),
                    "dashboard.guests.day",
                    "dashboard.guests.days",
                  ),
            )}
          </div>
          <div className="flex min-w-0 flex-[2_1_320px] flex-col gap-2.5">
            {tab === "age" && data.ages_hidden ? (
              <p className="py-2 text-sm text-gray-500">{t("dashboard.guests.agesHidden")}</p>
            ) : tab === "age" && data.age_known === 0 ? (
              <p className="py-2 text-sm text-gray-500">{t("dashboard.guests.noAges")}</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {rows.map((row, index) => (
                  // On phones the bar goes on its own line under the label and numbers.
                  <li
                    key={row.label}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] sm:flex-nowrap"
                  >
                    <span
                      title={row.label}
                      className="min-w-0 flex-1 truncate text-gray-700 sm:w-[120px] sm:flex-none sm:shrink-0"
                    >
                      {row.flag && (
                        <span aria-hidden="true" className="mr-1.5">
                          {row.flag}
                        </span>
                      )}
                      {row.label}
                    </span>
                    <div className="order-last h-2 w-full overflow-hidden rounded bg-[#F0F2F5] sm:order-none sm:w-auto sm:min-w-0 sm:flex-1">
                      <div
                        className="h-full rounded bg-[#2B4BF2]"
                        style={{ width: `${largest > 0 ? (row.count / largest) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="min-w-[76px] shrink-0 whitespace-nowrap text-right text-gray-500">
                      {guests(row.count)}
                    </span>
                    <span className="w-[40px] shrink-0 text-right font-semibold text-gray-900">
                      {shares[index] ?? 0}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {/* Only with ages to base it on: otherwise "No guest has a date of birth yet" says it. */}
            {tab === "age" && !data.ages_hidden && data.age_known > 0 && (
              <p className="text-xs text-gray-500">
                {t("dashboard.guests.ageNote", {
                  known: formatNumber(data.age_known, locale),
                  total: formatNumber(data.guests, locale),
                })}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
