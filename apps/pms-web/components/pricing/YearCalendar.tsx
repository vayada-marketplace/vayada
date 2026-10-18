"use client";

import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import type { NightSelection } from "./nightActions";
import {
  calendarNights,
  nightLabel,
  seasonTones,
  type CalendarNight,
  type PriceRange,
} from "./priceCalendarModel";
import { money } from "./stepPricing";

/** One month of the Year view: its nights, and what its heading says. */
export type CalendarMonth = {
  month: string;
  nights: CalendarNight[];
  summary:
    | { kind: "missing"; count: number }
    | ({ kind: "range" } & PriceRange)
    | { kind: "notOpen" | "closed" }
    | null;
};

/** A month's heading (VAY-2284): how many nights from today on have no price at all; otherwise the lowest and highest
 * price guests pay that month (own prices included); otherwise whether it is not open or closed. */
function monthSummary(nights: CalendarNight[]): CalendarMonth["summary"] {
  const missing = nights.filter((night) => night.kind === "none" && !night.past).length;
  if (missing) return { kind: "missing", count: missing };
  const prices = nights.flatMap((night) =>
    night.kind === "priced" && night.totalMinor !== null ? [BigInt(night.totalMinor)] : [],
  );
  if (prices.length) {
    const low = prices.reduce((a, b) => (b < a ? b : a)),
      high = prices.reduce((a, b) => (b > a ? b : a));
    return { kind: "range", lowMinor: low.toString(), highMinor: high.toString() };
  }
  if (nights.every((night) => night.kind === "closed"))
    return { kind: nights.every((night) => night.notOpen) ? "notOpen" : "closed" };
  return null;
}

// The editor rebuilds the room on every render; the year is worked out again only when something it shows changes.
let lastYear: { key: string; months: CalendarMonth[] } | null = null;
/** The twelve months of `year` ("YYYY") for one option and number of adults: the month view's nights, per month,
 * without the sample stay (the Year view doesn't outline it). */
export function calendarYear(
  room: PricingConfiguration,
  offerId: string,
  adults: number,
  year: string,
  today: string,
): CalendarMonth[] {
  const key = JSON.stringify([room, offerId, adults, year, today]);
  if (lastYear?.key === key) return lastYear.months;
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, "0")}`;
    const nights = calendarNights(room, offerId, month, adults, today, {
      checkIn: "",
      checkOut: "",
    });
    return { month, nights, summary: monthSummary(nights) };
  });
  lastYear = { key, months };
  return months;
}

// Four months in a row (each at least a quarter of the row, less the 1.25rem gaps), fewer when the card is narrower
// than four 8.5rem months.
const fourMonths = "repeat(auto-fill, minmax(max(8.5rem, calc(25% - 1rem)), 1fr))";

/** The Year view of "Prices by date" (VAY-2284, approved Paper board): twelve small months, up to four in a row,
 * each headed by its prices or by how many of its nights have no price yet. Dates take their season's colour; own
 * prices get a black dot, nights that can't start a stay a red one. Picking works as in the month view. */
export function YearCalendar({
  months,
  currency,
  selection,
  onPick,
}: {
  months: CalendarMonth[];
  currency: string;
  selection: NightSelection | null;
  onPick: (date: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-5" style={{ gridTemplateColumns: fourMonths }}>
      {months.map(({ month, nights, summary }) => {
        const name = t(`pricing.month.${Number(month.slice(5, 7))}`);
        const title = `${name} ${month.slice(0, 4)}`;
        const lead = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7; // Monday first
        return (
          <div key={month} role="group" aria-label={title} className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="text-[13px] font-semibold text-gray-900">{name}</span>
              {summary?.kind === "missing" ? (
                <span className="text-[11px] font-medium text-red-600">
                  {t("pricing.calendar.year.missing", { count: summary.count })}
                </span>
              ) : summary?.kind === "range" ? (
                <span className="whitespace-nowrap text-[11px] font-medium text-gray-600">
                  {summary.lowMinor === summary.highMinor
                    ? money(summary.lowMinor, currency)
                    : t("pricing.calendar.legend.range", {
                        low: money(summary.lowMinor, currency),
                        high: money(summary.highMinor, currency),
                      })}
                </span>
              ) : summary ? (
                <span className="text-[11px] font-medium text-gray-500">
                  {summary.kind === "notOpen"
                    ? t("pricing.calendar.notOpen")
                    : t("pricing.calendar.closed")}
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-7 gap-x-[3px] gap-y-1">
              {Array.from({ length: lead }, (_, index) => (
                <span key={`lead-${index}`} aria-hidden="true" />
              ))}
              {nights.map((night) => (
                <YearNight
                  key={night.date}
                  night={night}
                  title={title}
                  currency={currency}
                  selected={
                    !!selection && night.date >= selection.from && night.date <= selection.to
                  }
                  onPick={onPick}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function YearNight({
  night,
  title,
  currency,
  selected,
  onPick,
}: {
  night: CalendarNight;
  title: string;
  currency: string;
  selected: boolean;
  onPick: (date: string) => void;
}) {
  const { t } = useTranslation();
  const label = nightLabel(t, night, title, currency, selected);
  const noArrival = night.noArrival && night.kind !== "closed";
  const tone =
    night.kind === "none"
      ? "border-dashed border-red-300 bg-red-50 text-red-600"
      : night.kind === "closed"
        ? night.notOpen
          ? "border-gray-100 bg-gray-50 text-gray-400"
          : "border-gray-300 bg-gray-200 text-gray-600"
        : night.season
          ? `${seasonTones[night.season.tone].year} text-gray-800`
          : "border-gray-200 bg-white text-gray-700";
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      title={label}
      onClick={() => onPick(night.date)}
      className={`relative flex h-[22px] min-w-0 items-center justify-center rounded border text-[10px] font-medium ${tone} ${
        selected ? "ring-2 ring-inset ring-primary-600" : "hover:border-gray-400"
      } ${night.past ? "opacity-50" : ""}`}
    >
      {Number(night.date.slice(8))}
      {(noArrival || night.ownPrice) && (
        <span aria-hidden="true" className="absolute right-0.5 top-0.5 flex gap-px">
          {noArrival && <span className="h-1 w-1 rounded-full bg-red-500" />}
          {night.ownPrice && <span className="h-1 w-1 rounded-full bg-gray-900" />}
        </span>
      )}
    </button>
  );
}
