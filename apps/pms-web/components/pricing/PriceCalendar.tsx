"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import {
  calendarAdults,
  calendarNights,
  legendRanges,
  nightLabel,
  seasonGroups,
  seasonTones,
  type CalendarNight,
  type PriceRange,
} from "./priceCalendarModel";
import type { NightSelection } from "./nightActions";
import { headlineMinor, mainOffer, money, sampleAdults } from "./stepPricing";
import { calendarYear, YearCalendar } from "./YearCalendar";

/** "YYYY-MM" moved by `delta` months. */
export const shiftMonth = (month: string, delta: number) => {
  const date = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1),
  );
  return date.toISOString().slice(0, 7);
};

const chip = (selected: boolean) =>
  `inline-flex h-8 items-center rounded-full border px-3 text-[13px] font-medium transition-colors ${
    selected
      ? "border-primary-300 bg-primary-50 text-primary-700"
      : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
  }`;
const navButton =
  "flex h-8 w-8 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50";

/** "Prices by date" (VAY-2280, approved Paper board): the Prices tab's first card. One month of an option's nightly
 * prices from the engine's night evaluator (the one Channex nightly prices use), for the chosen rate and guests.
 * Nights take their season's colour; own prices get a dot, closed dates a lock, closed periods say "Not open"
 * (VAY-2284), nights that can't start a stay get a red dot, and nights without any price say so. The sample stay's
 * nights are outlined; picking a night starts it. The Year view (VAY-2284) shows the same nights for twelve months. */
export function PriceCalendar({
  room,
  options,
  offerId,
  onOffer,
  adults,
  onAdults,
  month,
  today,
  stay,
  selection = null,
  onMonth,
  onPick,
}: {
  room: PricingConfiguration | null;
  /** The rates the calendar can show (VAY-2284: Flexible and Non-refundable), with their names. */
  options: readonly { id: string; name: string }[];
  offerId: string;
  onOffer: (offerId: string) => void;
  /** Adults to price for; null: the tab's sample guests. */
  adults: number | null;
  onAdults: (adults: number) => void;
  month: string;
  today: string;
  stay: { checkIn: string; checkOut: string };
  /** The picked nights (the night panel's), outlined strongly; the sample stay's nights lightly. */
  selection?: NightSelection | null;
  onMonth: (month: string) => void;
  onPick: (date: string) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<"month" | "year">("month");
  // The approved phone board has no Year view: under 640px the calendar shows the month (VAY-2284).
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = globalThis.matchMedia?.("(min-width: 640px)");
    if (!query) return;
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const guests = room
    ? adults !== null && adults <= room.capacity.adults
      ? adults
      : sampleAdults(room)
    : 2;
  const months =
    room && view === "year" && wide
      ? calendarYear(room, offerId, guests, month.slice(0, 4), today, stay)
      : null;
  const nights = room && !months ? calendarNights(room, offerId, month, guests, today, stay) : [];
  // The Year view has no minimum-stay badges, so its legend doesn't explain them.
  const legendNights = months
    ? months.flatMap((value) => value.nights.map((night) => ({ ...night, minNights: 1 })))
    : nights;
  const counts = room ? calendarAdults(room) : [];
  const first = new Date(`${month}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Monday first, as the engine counts weekdays.
  const title = `${t(`pricing.month.${Number(month.slice(5, 7))}`)} ${month.slice(0, 4)}`;
  const views = [
    { key: "month", name: t("pricing.calendar.view.month") },
    { key: "year", name: t("pricing.calendar.view.year") },
  ] as const;
  return (
    <section
      aria-label={t("pricing.steps.calendar.title")}
      className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 md:p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-gray-500">
          {t("pricing.steps.calendar.title")}
        </h2>
        <p className="hidden text-[13px] text-gray-500 sm:block">{t("pricing.calendar.hint")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={
              months ? t("pricing.calendar.previousYear") : t("pricing.steps.calendar.previous")
            }
            onClick={() => onMonth(shiftMonth(month, months ? -12 : -1))}
            className={navButton}
          >
            <ChevronLeftIcon aria-hidden="true" className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={months ? t("pricing.calendar.nextYear") : t("pricing.steps.calendar.next")}
            onClick={() => onMonth(shiftMonth(month, months ? 12 : 1))}
            className={navButton}
          >
            <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
          </button>
          <span
            aria-live="polite"
            className="text-[16px] font-semibold text-gray-900 md:text-[18px]"
          >
            {months ? month.slice(0, 4) : title}
          </span>
          <button
            type="button"
            onClick={() => onMonth(today.slice(0, 7))}
            className="h-8 rounded-lg border border-gray-300 bg-white px-3 text-[13px] font-medium text-gray-800 hover:bg-gray-50"
          >
            {t("pricing.calendar.today")}
          </button>
        </div>
        <div
          role="group"
          aria-label={t("pricing.calendar.view.label")}
          className="hidden shrink-0 gap-0.5 rounded-lg bg-gray-100 p-[3px] sm:flex"
        >
          {views.map((value) => (
            <button
              key={value.key}
              type="button"
              aria-pressed={(value.key === "year") === !!months}
              onClick={() => setView(value.key)}
              className={`h-6 rounded-md px-3.5 text-[13px] ${
                (value.key === "year") === !!months
                  ? "bg-white font-medium text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {value.name}
            </button>
          ))}
        </div>
      </div>
      {room && (options.length > 1 || counts.length > 1) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[13px] text-gray-500">{t("pricing.calendar.showing")}</span>
          {options.length > 1 && (
            <div
              role="group"
              aria-label={t("pricing.calendar.optionsLabel")}
              className="flex flex-wrap gap-1.5"
            >
              {options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={option.id === offerId}
                  aria-label={t("pricing.calendar.showFor", { name: option.name })}
                  onClick={() => onOffer(option.id)}
                  className={chip(option.id === offerId)}
                >
                  <span>{option.name}</span>
                </button>
              ))}
            </div>
          )}
          {counts.length > 1 && (
            <>
              <span className="mx-1 text-[13px] text-gray-500">{t("pricing.calendar.with")}</span>
              <div
                role="group"
                aria-label={t("pricing.calendar.adultsLabel")}
                className="flex flex-wrap gap-1.5"
              >
                {counts.map((count) => (
                  <button
                    key={count}
                    type="button"
                    aria-pressed={count === guests}
                    onClick={() => onAdults(count)}
                    className={chip(count === guests)}
                    aria-label={t("pricing.calendar.showFor", {
                      name: t(
                        count === 1
                          ? "pricing.calendar.guests.one"
                          : "pricing.calendar.guests.other",
                        { count },
                      ),
                    })}
                  >
                    <span>
                      {t(
                        count === 1
                          ? "pricing.calendar.guests.one"
                          : "pricing.calendar.guests.other",
                        { count },
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {!room ? (
        <p className="text-[13px] text-gray-500">{t("pricing.steps.guests.invalid")}</p>
      ) : months ? (
        <YearCalendar
          months={months}
          currency={room.currency}
          selection={selection}
          onPick={onPick}
        />
      ) : (
        <div className="grid grid-cols-7 gap-1 md:gap-1.5">
          {Array.from({ length: 7 }, (_, day) => (
            <span
              key={`head-${day}`}
              aria-hidden="true"
              className="text-center text-[11px] font-medium uppercase tracking-wide text-gray-500"
            >
              {t(`pricing.steps.calendar.weekday.${day}`)}
            </span>
          ))}
          {Array.from({ length: lead }, (_, index) => (
            <span key={`lead-${index}`} aria-hidden="true" />
          ))}
          {nights.map((night) => (
            <Night
              key={night.date}
              night={night}
              currency={room.currency}
              title={title}
              selected={!!selection && night.date >= selection.from && night.date <= selection.to}
              onPick={onPick}
            />
          ))}
        </div>
      )}
      {room && (
        <Legend
          room={room}
          offerId={offerId}
          adults={guests}
          year={month.slice(0, 4)}
          nights={legendNights}
        />
      )}
    </section>
  );
}

function Night({
  night,
  currency,
  title,
  selected,
  onPick,
}: {
  night: CalendarNight;
  currency: string;
  title: string;
  selected: boolean;
  onPick: (date: string) => void;
}) {
  const { t } = useTranslation();
  const day = Number(night.date.slice(8));
  const price = night.totalMinor ? money(night.totalMinor, currency) : "—";
  const tone =
    night.kind === "none"
      ? "border-dashed border-red-300 bg-red-50"
      : night.kind === "closed"
        ? night.notOpen
          ? "border-gray-100 bg-gray-50"
          : "border-gray-300 bg-gray-200"
        : night.season
          ? seasonTones[night.season.tone].cell
          : "border-gray-200 bg-white";
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={[
        nightLabel(t, night, title, currency, selected),
        night.inStay ? t("pricing.steps.calendar.inStay") : "",
      ]
        .filter(Boolean)
        .join(", ")}
      title={
        night.minNights > 1
          ? t("pricing.calendar.minNightsTitle", { count: night.minNights })
          : undefined
      }
      onClick={() => onPick(night.date)}
      className={`flex h-[52px] min-w-0 flex-col justify-between rounded-lg border px-1 py-1.5 text-left md:h-[72px] md:rounded-[10px] md:px-2.5 md:py-2 ${tone} ${
        selected
          ? "ring-2 ring-inset ring-primary-600"
          : night.inStay
            ? "ring-1 ring-inset ring-primary-300"
            : "hover:border-gray-400"
      } ${night.past ? "opacity-50" : ""}`}
    >
      <span className="flex items-center justify-between gap-1">
        <span
          className={
            night.today
              ? "flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-[11px] font-semibold text-white"
              : "text-[11px] font-medium text-gray-500 md:text-[12px]"
          }
        >
          {day}
        </span>
        <span className="flex items-center gap-1">
          {night.noArrival && night.kind !== "closed" && (
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-red-500" />
          )}
          {night.ownPrice ? (
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-gray-900 md:h-[7px] md:w-[7px]"
            />
          ) : (
            night.kind === "priced" &&
            night.minNights > 1 && (
              <span className="hidden text-[11px] text-gray-500 md:inline">
                {t("pricing.calendar.minNights", { count: night.minNights })}
              </span>
            )
          )}
        </span>
      </span>
      {night.kind === "closed" && night.notOpen ? (
        <span className="truncate text-[11px] font-medium text-gray-400 md:text-[12px]">
          {t("pricing.calendar.notOpen")}
        </span>
      ) : night.kind === "closed" ? (
        <span className="flex items-center gap-1 text-gray-500">
          <LockClosedIcon aria-hidden="true" className="h-3 w-3 md:h-3.5 md:w-3.5" />
          <span className="hidden text-[12px] font-medium md:inline">
            {t("pricing.calendar.closed")}
          </span>
        </span>
      ) : night.kind === "none" ? (
        <span className="truncate text-[11px] font-semibold text-red-600 md:text-[12px]">
          {t("pricing.calendar.noPrice")}
        </span>
      ) : (
        <span className="truncate text-[12px] font-semibold text-gray-900 md:text-[15px]">
          {price}
        </span>
      )}
    </button>
  );
}

function Legend({
  room,
  offerId,
  adults,
  year,
  nights,
}: {
  room: PricingConfiguration;
  offerId: string;
  adults: number;
  year: string;
  nights: CalendarNight[];
}) {
  const { t } = useTranslation();
  const offer = room.offers.find((value) => value.id === offerId) ?? mainOffer(room);
  const owner = offer.price.kind === "independent" ? offer : mainOffer(room);
  const base = owner.price.kind === "independent" ? owner.price.calendar.base : null;
  // VAY-2284: every season of the year with its price range, whatever month is shown.
  const ranges = legendRanges(room, offerId, adults, year);
  const amount = (range: PriceRange) =>
    range.lowMinor === range.highMinor
      ? money(range.lowMinor, room.currency)
      : t("pricing.calendar.legend.range", {
          low: money(range.lowMinor, room.currency),
          high: money(range.highMinor, room.currency),
        });
  const swatch = (classes: string) => (
    <span aria-hidden="true" className={`h-3 w-3 shrink-0 rounded-[3px] border ${classes}`} />
  );
  const item = (key: string, mark: ReactNode, text: string) => (
    <li key={key} className="flex items-center gap-1.5">
      {mark}
      <span>{text}</span>
    </li>
  );
  const items = [
    base &&
      item(
        "base",
        swatch("border-gray-300 bg-white"),
        t("pricing.calendar.legend.standard", {
          amount: ranges.standard
            ? amount(ranges.standard)
            : money(headlineMinor(base), room.currency),
        }),
      ),
    ...seasonGroups(owner).map((group) => {
      const range = ranges.seasons[group.key];
      return item(
        group.key,
        swatch(seasonTones[group.tone].swatch),
        range ? `${group.name} ${amount(range)}` : group.name,
      );
    }),
    nights.some((night) => night.ownPrice) &&
      item(
        "own",
        <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-gray-900" />,
        t("pricing.calendar.legend.own"),
      ),
    nights.some((night) => night.kind === "closed" && !night.notOpen) &&
      item("closed", swatch("border-gray-300 bg-gray-200"), t("pricing.calendar.legend.closed")),
    nights.some((night) => night.notOpen) &&
      item("notOpen", swatch("border-gray-200 bg-gray-50"), t("pricing.calendar.legend.notOpen")),
    nights.some((night) => night.noArrival) &&
      item(
        "noArrival",
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-red-500" />,
        t("pricing.calendar.legend.noArrival"),
      ),
    nights.some((night) => night.kind === "none") &&
      item(
        "none",
        swatch("border-dashed border-red-300 bg-red-50"),
        t("pricing.calendar.legend.noPrice"),
      ),
    nights.some((night) => night.minNights > 1) && (
      <li key="min" className="hidden text-gray-500 md:list-item">
        {t("pricing.calendar.legend.minNights", {
          count: nights.find((night) => night.minNights > 1)?.minNights ?? 2,
        })}
      </li>
    ),
  ].filter(Boolean);
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap gap-x-3.5 gap-y-1.5 border-t border-gray-100 pt-3 text-[12px] text-gray-600">
      {items}
    </ul>
  );
}
