"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { monthNights, money, sampleAdults } from "./stepPricing";

/** "YYYY-MM" moved by `delta` months. */
export const shiftMonth = (month: string, delta: number) => {
  const date = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1),
  );
  return date.toISOString().slice(0, 7);
};

/** "Price per night": one month of an option's nightly prices for the sample guests, from the engine's night
 * evaluator (the one Channex nightly prices use). Weekend-adjusted nights are amber, single-date prices blue, closed
 * nights marked; the sample stay's nights are outlined. Picking a night starts the sample stay there. */
export function PriceCalendar({
  room,
  offerId,
  optionName,
  month,
  stay,
  onMonth,
  onPick,
}: {
  room: PricingConfiguration | null;
  offerId: string;
  optionName: string;
  month: string;
  stay: { checkIn: string; checkOut: string };
  onMonth: (month: string) => void;
  onPick: (date: string) => void;
}) {
  const { t } = useTranslation();
  const nights = room ? monthNights(room, offerId, month) : [];
  const first = new Date(`${month}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Monday first, as the engine counts weekdays.
  const title = `${t(`pricing.month.${Number(month.slice(5, 7))}`)} ${month.slice(0, 4)}`;
  return (
    <section
      aria-label={t("pricing.steps.calendar.title")}
      className="space-y-3 rounded-2xl border border-gray-200 bg-white p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-gray-500">
          {t("pricing.steps.calendar.title")}
        </h3>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            aria-label={t("pricing.steps.calendar.previous")}
            onClick={() => onMonth(shiftMonth(month, -1))}
            className="rounded p-0.5 text-gray-400 hover:text-gray-700"
          >
            <ChevronLeftIcon aria-hidden="true" className="h-4 w-4" />
          </button>
          <span aria-live="polite" className="text-[14px] font-semibold text-gray-900">
            {title}
          </span>
          <button
            type="button"
            aria-label={t("pricing.steps.calendar.next")}
            onClick={() => onMonth(shiftMonth(month, 1))}
            className="rounded p-0.5 text-gray-400 hover:text-gray-700"
          >
            <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>
      <p className="text-[12px] text-gray-500">
        {t("pricing.steps.calendar.option", {
          name: optionName,
          guests: t(
            room && sampleAdults(room) === 1 ? "pricing.adults.one" : "pricing.adults.other",
            { count: room ? sampleAdults(room) : 2 },
          ),
        })}
      </p>
      {!room ? (
        <p className="text-[13px] text-gray-500">{t("pricing.steps.guests.invalid")}</p>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 7 }, (_, day) => (
            <span
              key={`head-${day}`}
              aria-hidden="true"
              className="text-center text-[12px] text-gray-400"
            >
              {t(`pricing.steps.calendar.weekday.${day}`)}
            </span>
          ))}
          {Array.from({ length: lead }, (_, index) => (
            <span key={`lead-${index}`} aria-hidden="true" />
          ))}
          {nights.map(({ date, night }) => {
            const projected = night.kind === "projected" ? night.night : null;
            const rules = projected?.restrictions;
            const closed = !!rules?.stopSell;
            const sources = projected?.sources.map((source) => source.kind) ?? [];
            const inStay = date >= stay.checkIn && date < stay.checkOut;
            const tone = sources.includes("date")
              ? "bg-primary-50"
              : sources.includes("weekday")
                ? "bg-amber-100"
                : "bg-gray-50";
            const price = projected ? money(projected.totalMinor, room.currency) : "—";
            const state = closed
              ? t("pricing.steps.calendar.closed")
              : rules?.closedToArrival
                ? t("pricing.steps.calendar.noArrival")
                : "";
            const stayText = inStay ? t("pricing.steps.calendar.inStay") : "";
            return (
              <button
                key={date}
                type="button"
                aria-label={[`${Number(date.slice(8))} ${title}`, price, state, stayText]
                  .filter(Boolean)
                  .join(", ")}
                title={state || undefined}
                onClick={() => onPick(date)}
                className={`relative flex h-[46px] flex-col items-center justify-center gap-px rounded-lg text-[12px] leading-[15px] ${tone} ${inStay ? "ring-[1.5px] ring-inset ring-primary-500" : "hover:ring-1 hover:ring-inset hover:ring-gray-300"}`}
              >
                {/* A night that can't start a stay gets a red dot, so it doesn't look like any other night. */}
                {!closed && rules?.closedToArrival && (
                  <span
                    aria-hidden="true"
                    className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-red-500"
                  />
                )}
                <span className="text-gray-700">{Number(date.slice(8))}</span>
                <span
                  className={`font-semibold ${closed ? "text-gray-400 line-through" : "text-gray-900"}`}
                >
                  {price}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
