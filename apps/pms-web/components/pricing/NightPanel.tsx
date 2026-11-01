"use client";

import { useState } from "react";
import {
  ArrowsRightLeftIcon,
  CalendarDaysIcon,
  LockClosedIcon,
  LockOpenIcon,
  MoonIcon,
  PencilSquareIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { amountInput, baseAmounts, errorText } from "./pricingAmounts";
import {
  moveToSeason,
  nightPrices,
  nightRules,
  ownPrice,
  selectedDates,
  setNightRules,
  setOwnPrices,
  type NightSelection,
} from "./nightActions";
import { seasonGroups, seasonTones } from "./priceCalendarModel";
import { recurringTemplate } from "./recurringPricingInputs";
import { mainOffer, money } from "./stepPricing";
import { rangeMinimum, setRangeMinimum, stayDefaults } from "./stayRuleSeasons";
import * as ui from "./pricingStyles";

type Room = PricingConfiguration;
type Entry =
  | { kind: "price"; values: string[] }
  | { kind: "minimum"; value: string }
  | { kind: "arrival"; noArrival: boolean; noDeparture: boolean }
  /** `season`: a season group's key, "" for a new season named `name`, or `STANDARD` for the standard price. */
  | { kind: "season"; season: string; name: string };
/** The season choice that moves dates back to the standard price (season group keys are JSON arrays). */
const STANDARD = "standard";
const action =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg border px-3 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/** The picked nights' panel beside "Prices by date" (VAY-2280, approved board): what each option costs that night,
 * and the one-off changes: an own price (the main option's single-date price; other options follow it), a minimum
 * stay for arrivals, closing or opening, and arrival/departure rules. Every change goes to the draft like the other
 * editors; Save publishes it. `room` is the draft, `shown` the draft with typed prices (null while one doesn't parse). */
export function NightPanel({
  room,
  shown,
  selection,
  adults,
  names,
  disabled,
  onClear,
  onChange,
  onPending,
}: {
  room: Room;
  shown: Room | null;
  selection: NightSelection | null;
  adults: number;
  names: Readonly<Record<string, string>>;
  disabled: boolean;
  onClear: () => void;
  onChange: (room: Room) => void;
  onPending: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const [entry, setEntry] = useState<Entry | null>(null),
    [error, setError] = useState("");
  if (!selection)
    return (
      <section
        aria-label={t("pricing.night.title")}
        className="space-y-2.5 rounded-2xl border border-gray-200 bg-white p-5 md:p-6"
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-gray-100">
          <CalendarDaysIcon aria-hidden="true" className="h-5 w-5 text-gray-500" />
        </span>
        <h2 className="text-[16px] font-semibold text-gray-900">{t("pricing.night.emptyTitle")}</h2>
        <p className="text-[14px] leading-5 text-gray-600">{t("pricing.night.emptyText")}</p>
      </section>
    );
  const dates = selectedDates(selection),
    single = dates.length === 1,
    date = dates[0];
  const main = mainOffer(room),
    template = recurringTemplate(main);
  const rules = dates.map((day) => nightRules(room, day));
  const allClosed = rules.every((value) => value.stopSell);
  const stayOwned = main.restrictions.kind === "own";
  const day = (value: string, long = false) => {
    const when = new Date(`${value}T00:00:00Z`),
      weekday = (when.getUTCDay() + 6) % 7;
    const monthName = t(`pricing.month.${when.getUTCMonth() + 1}`);
    return long
      ? t("pricing.night.dateLong", {
          weekday: t(`pricing.night.weekday.${weekday}`),
          day: when.getUTCDate(),
          month: monthName,
          year: when.getUTCFullYear(),
        })
      : `${t(`pricing.steps.calendar.weekday.${weekday}`)} ${when.getUTCDate()} ${t(`pricing.steps.monthShort.${when.getUTCMonth() + 1}`)}`;
  };
  const open = (next: Entry) => {
    if (disabled) return;
    setEntry(next);
    setError("");
    onPending(true);
  };
  const close = () => {
    setEntry(null);
    setError("");
    onPending(false);
  };
  const apply = (change: () => Room, keepOpen = false) => {
    if (disabled) return;
    try {
      onChange(change());
      if (!keepOpen) close();
    } catch (cause) {
      setError(errorText(cause, t, "pricing.night.changeFailed"));
    }
  };
  const clear = () => {
    close();
    onClear();
  };
  const groups = seasonGroups(main);
  // A single night says where its price comes from: its season, an own price or the standard price.
  const seasonOn = (value: string) =>
    groups.find((group) =>
      group.seasons.some((range) =>
        range.from <= range.through
          ? value.slice(5) >= range.from && value.slice(5) <= range.through
          : value.slice(5) >= range.from || value.slice(5) <= range.through,
      ),
    );
  const season = single ? seasonOn(date) : undefined;
  // Dates in a season move to another one, or back to the standard price (VAY-2305); others are added to one.
  const moving = dates.some((value) => seasonOn(value));
  const own = single ? ownPrice(room, date) : null;
  const prices = single && shown ? nightPrices(shown, date, adults) : [];
  const unpriced =
    single && !rules[0].stopSell && prices.length > 0 && prices.every((value) => !value.totalMinor);
  const fields = template ? baseAmounts(template, t) : [];
  // What a season choice costs for the calendar's guests, and its minimum stay.
  const sample = (price: Parameters<typeof baseAmounts>[0]) => {
    const amounts = baseAmounts(price);
    return amounts.length
      ? money(amounts[Math.min(adults, amounts.length) - 1][1], room.currency)
      : "—";
  };
  const minimumText = (nights: number) =>
    t(nights === 1 ? "pricing.night.minOne" : "pricing.night.minOther", { count: nights });
  // Back to the standard price only when there is one; a single date shows its month's own price, which comes first.
  const calendar = main.price.kind === "independent" ? main.price.calendar : null;
  const standard = calendar?.base
    ? (single &&
        calendar.months.find((entry) => entry.month === Number(date.slice(5, 7)))?.price) ||
      calendar.base
    : null;
  const choices = [
    ...(moving && standard
      ? [
          {
            key: STANDARD,
            name: t("pricing.night.standard"),
            dot: "bg-gray-300",
            sub: [
              sample(standard),
              ...(stayOwned ? [minimumText(stayDefaults(room).minArrivalNights)] : []),
            ].join(" · "),
          },
        ]
      : []),
    ...groups
      .filter((group) => !(single && group.key === season?.key))
      .map((group) => ({
        key: group.key,
        name: group.name,
        dot: seasonTones[group.tone].dot,
        sub: [
          sample(group.seasons[0].price),
          ...(stayOwned ? [minimumText(rangeMinimum(room, group.seasons[0]))] : []),
        ].join(" · "),
      })),
    { key: "", name: t("pricing.night.seasonNew"), dot: "", sub: "" },
  ];
  const span = single ? day(date) : `${day(dates[0])} – ${day(dates[dates.length - 1])}`;
  return (
    <section
      aria-label={t("pricing.night.title")}
      className="space-y-3 rounded-2xl border border-primary-300 bg-white p-5 md:p-6"
    >
      <div className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-[16px] font-semibold text-gray-900">
          {single ? day(date, true) : t("pricing.night.selected", { count: dates.length })}
        </h2>
        <button
          type="button"
          onClick={clear}
          className="h-8 shrink-0 rounded-lg border border-gray-300 bg-white px-3 text-[13px] font-medium text-gray-800 hover:bg-gray-50"
        >
          {t("pricing.night.clear")}
        </button>
      </div>
      {unpriced && (
        <p className="text-[13px] font-medium text-red-600">{t("pricing.night.noPrice")}</p>
      )}
      <p className="flex items-center gap-2 text-[13px] text-gray-600">
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${season ? seasonTones[season.tone].dot : "bg-gray-300"}`}
        />
        <span>
          {single
            ? [
                own
                  ? t("pricing.night.ownPrice")
                  : season
                    ? season.name
                    : t("pricing.night.standard"),
                rules[0].stopSell
                  ? t("pricing.calendar.closed")
                  : t(
                      rules[0].minArrivalNights === 1
                        ? "pricing.night.minOne"
                        : "pricing.night.minOther",
                      { count: rules[0].minArrivalNights },
                    ),
              ].join(" · ")
            : `${day(dates[0])} – ${day(dates[dates.length - 1])}`}
        </span>
      </p>
      {single && (
        <dl className="space-y-1.5 rounded-[10px] bg-gray-50 px-3.5 py-3">
          {prices.map(({ offerId, totalMinor }) => (
            <div key={offerId} className="flex items-center justify-between gap-3 text-[14px]">
              <dt className="min-w-0 truncate text-gray-700">{names[offerId] ?? ""}</dt>
              <dd className="font-semibold text-gray-900">
                {totalMinor ? money(totalMinor, room.currency) : "—"}
              </dd>
            </div>
          ))}
          {!shown && (
            <p className="text-[13px] text-gray-500">{t("pricing.steps.guests.invalid")}</p>
          )}
        </dl>
      )}
      {entry?.kind === "price" ? (
        <div className={ui.draftCard}>
          <p className="mb-2 text-[13px] font-semibold text-gray-900">
            {t(single ? "pricing.night.priceTitleOne" : "pricing.night.priceTitleMany", {
              currency: room.currency,
            })}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {fields.map(([label], index) => (
              <label key={index} className="block text-[12px] text-gray-600">
                {label}
                <input
                  aria-label={t("pricing.night.priceField", { field: label })}
                  inputMode="decimal"
                  className={`mt-1 ${ui.input}`}
                  disabled={disabled}
                  value={entry.values[index] ?? ""}
                  onChange={(event) =>
                    setEntry({
                      ...entry,
                      values: entry.values.map((value, at) =>
                        at === index ? event.target.value : value,
                      ),
                    })
                  }
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-gray-500">{t("pricing.night.priceHint")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={ui.primaryButton}
              disabled={disabled}
              onClick={() => apply(() => setOwnPrices(room, dates, entry.values))}
            >
              {t("pricing.night.apply")}
            </button>
            <button
              type="button"
              className={ui.secondaryButton}
              disabled={disabled}
              onClick={close}
            >
              {t("common.cancel")}
            </button>
            {dates.some((value) => ownPrice(room, value)) && (
              <button
                type="button"
                className={`${ui.secondaryButton} text-red-600`}
                disabled={disabled}
                onClick={() => apply(() => setOwnPrices(room, dates, null))}
              >
                {t(single ? "pricing.night.removePriceOne" : "pricing.night.removePriceMany")}
              </button>
            )}
          </div>
        </div>
      ) : entry?.kind === "minimum" ? (
        <div className={ui.draftCard}>
          <label className="block text-[13px] font-semibold text-gray-900">
            {t(single ? "pricing.night.minimumOne" : "pricing.night.minimumMany")}
            <input
              aria-label={t("pricing.night.minimumField")}
              inputMode="numeric"
              className={`mt-1.5 block w-32 ${ui.field}`}
              disabled={disabled}
              value={entry.value}
              onChange={(event) => setEntry({ ...entry, value: event.target.value })}
            />
          </label>
          <p className="mt-2 text-[12px] text-gray-500">{t("pricing.night.minimumHint")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={ui.primaryButton}
              disabled={disabled}
              onClick={() =>
                apply(() =>
                  setNightRules(room, dates, {
                    minArrivalNights: /^\d+$/.test(entry.value) ? Number(entry.value) : NaN,
                  }),
                )
              }
            >
              {t("pricing.night.apply")}
            </button>
            <button
              type="button"
              className={ui.secondaryButton}
              disabled={disabled}
              onClick={close}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : entry?.kind === "season" ? (
        <div className={ui.draftCard}>
          <p className="text-[13px] font-semibold text-gray-900">
            {t(moving ? "pricing.night.moveTitle" : "pricing.night.seasonTitle", { days: span })}
          </p>
          <div
            role="radiogroup"
            aria-label={t("pricing.night.seasonChoice")}
            className="mt-2 space-y-1.5"
          >
            {choices.map((choice) => (
              <button
                key={choice.key}
                type="button"
                role="radio"
                aria-checked={entry.season === choice.key}
                disabled={disabled}
                onClick={() => setEntry({ ...entry, season: choice.key })}
                className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left ${
                  entry.season === choice.key
                    ? "border-primary-300 bg-primary-50"
                    : "border-gray-200 bg-white hover:bg-gray-50"
                }`}
              >
                {choice.dot ? (
                  <span
                    aria-hidden="true"
                    className={`h-2.5 w-2.5 shrink-0 rounded-[3px] ${choice.dot}`}
                  />
                ) : (
                  <PlusIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary-600" />
                )}
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-gray-900">{choice.name}</span>
                  {choice.sub && (
                    <span className="block text-[12px] text-gray-500">{choice.sub}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
          {entry.season === "" && (
            <label className="mt-3 block text-[12px] text-gray-600">
              {t("pricing.night.seasonName")}
              <input
                aria-label={t("pricing.night.seasonName")}
                className={`mt-1 ${ui.input}`}
                disabled={disabled}
                value={entry.name}
                onChange={(event) => setEntry({ ...entry, name: event.target.value })}
              />
            </label>
          )}
          <p className="mt-2 text-[12px] text-gray-500">
            {t(moving ? "pricing.night.moveHint" : "pricing.night.seasonHint")}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={ui.primaryButton}
              disabled={disabled}
              onClick={() => {
                const group = groups.find((value) => value.key === entry.season);
                apply(() => {
                  const next = moveToSeason(
                    room,
                    selection,
                    entry.season === STANDARD
                      ? null
                      : group
                        ? { name: group.name, tier: group.tier }
                        : { name: entry.name, tier: "" },
                  );
                  // The days take the season's minimum stay too (VAY-2280 step 2).
                  const nights = group && stayOwned ? rangeMinimum(room, group.seasons[0]) : null;
                  return nights === null || nights === stayDefaults(room).minArrivalNights
                    ? next
                    : setRangeMinimum(
                        next,
                        [{ from: selection.from.slice(5), through: selection.to.slice(5) }],
                        nights,
                      );
                });
              }}
            >
              {t(moving ? "pricing.night.moveApply" : "pricing.night.seasonApply")}
            </button>
            <button
              type="button"
              className={ui.secondaryButton}
              disabled={disabled}
              onClick={close}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : entry?.kind === "arrival" ? (
        <div className={ui.draftCard}>
          <p className="text-[13px] font-semibold text-gray-900">
            {t("pricing.night.arrivalTitle")}
          </p>
          {(["noArrival", "noDeparture"] as const).map((key) => (
            <label key={key} className="mt-2 flex items-center gap-2 text-[13px] text-gray-700">
              <input
                type="checkbox"
                disabled={disabled}
                checked={entry[key]}
                onChange={(event) => setEntry({ ...entry, [key]: event.target.checked })}
              />
              {t(`pricing.night.${key}`)}
            </label>
          ))}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={ui.primaryButton}
              disabled={disabled}
              onClick={() =>
                apply(() =>
                  setNightRules(room, dates, {
                    closedToArrival: entry.noArrival,
                    closedToDeparture: entry.noDeparture,
                  }),
                )
              }
            >
              {t("pricing.night.apply")}
            </button>
            <button
              type="button"
              className={ui.secondaryButton}
              disabled={disabled}
              onClick={close}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            disabled={disabled || !template}
            className={`${action} w-full border-primary-600 bg-primary-600 text-white hover:bg-primary-700`}
            onClick={() =>
              open({
                kind: "price",
                values: fields.map((_, index) => {
                  const current = own && baseAmounts(own)[index]?.[1];
                  return current ? amountInput(current, room.currency) : "";
                }),
              })
            }
          >
            <PencilSquareIcon aria-hidden="true" className="h-4 w-4" />
            {t(single ? "pricing.night.ownPriceOne" : "pricing.night.ownPriceMany")}
          </button>
          {main.price.kind === "independent" && (
            <button
              type="button"
              disabled={disabled}
              className={`${action} w-full border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}
              onClick={() => open({ kind: "season", season: choices[0].key, name: "" })}
            >
              <ArrowsRightLeftIcon aria-hidden="true" className="h-4 w-4" />
              {t(
                moving
                  ? single
                    ? "pricing.night.moveOne"
                    : "pricing.night.moveMany"
                  : single
                    ? "pricing.night.addOne"
                    : "pricing.night.addMany",
              )}
            </button>
          )}
          {stayOwned && (
            // Side by side when both labels fit on one line each, otherwise one under the other.
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={disabled}
                className={`${action} flex-[1_0_auto] whitespace-nowrap border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}
                onClick={() => open({ kind: "minimum", value: String(rules[0].minArrivalNights) })}
              >
                <MoonIcon aria-hidden="true" className="h-4 w-4" />
                {t("pricing.night.minimum")}
              </button>
              <button
                type="button"
                disabled={disabled}
                className={`${action} flex-[1_0_auto] whitespace-nowrap ${allClosed ? "border-gray-300 text-gray-800" : "border-red-200 text-red-600"} bg-white hover:bg-gray-50`}
                onClick={() =>
                  apply(() => setNightRules(room, dates, { stopSell: !allClosed }), true)
                }
              >
                {allClosed ? (
                  <LockOpenIcon aria-hidden="true" className="h-4 w-4" />
                ) : (
                  <LockClosedIcon aria-hidden="true" className="h-4 w-4" />
                )}
                {t(
                  allClosed
                    ? single
                      ? "pricing.night.openOne"
                      : "pricing.night.openMany"
                    : single
                      ? "pricing.night.closeOne"
                      : "pricing.night.closeMany",
                )}
              </button>
            </div>
          )}
          {stayOwned && (
            <button
              type="button"
              disabled={disabled}
              className={ui.stepLink}
              onClick={() =>
                open({
                  kind: "arrival",
                  noArrival: rules.every((value) => value.closedToArrival),
                  noDeparture: rules.every((value) => value.closedToDeparture),
                })
              }
            >
              {t("pricing.night.arrival")}
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className={ui.errorText}>
          {error}
        </p>
      )}
    </section>
  );
}
