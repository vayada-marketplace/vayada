"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MinusIcon, PlusIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useTranslation } from "@/lib/i18n";
import { baseAmounts, decimalAmount, errorText } from "./pricingAmounts";
import { changeSeasonPrice } from "./PricingSeasons";
import { seasonGroups, seasonTones, type SeasonGroup } from "./priceCalendarModel";
import { recurringTemplate } from "./recurringPricingInputs";
import { onePriceAgain, pricePerAdultCount } from "./simplePricing";
import { moveRangeRule, rangeMinimum, setRangeMinimum, stayDefaults } from "./stayRuleSeasons";
import {
  adjustmentText,
  childrenSummary,
  currencySymbol,
  mainOffer,
  money,
  ownRuleOptions,
  setMinimumNights,
  yearPieces,
} from "./stepPricing";
import { SeasonWindow } from "./SeasonWindow";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

type Room = PricingConfiguration;
type Offer = Room["offers"][number];
type Season = SeasonGroup["seasons"][number];
const without = (record: Record<string, string[]>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
const days = (from: string, through: string) => {
  const day = (value: string) => new Date(`2000-${value}T00:00:00Z`).getTime();
  const span = Math.round((day(through) - day(from)) / 86400000) + 1;
  return span > 0 ? span : span + 366;
};

/** Step "Prices and seasons" (VAY-2280, approved board): the main option's standard price as the first row, then one
 * row per season (seasons stored with the same name and tier are one season with several date ranges), the year
 * bar, the price per number of guests, the weekend row (`children`) and the children's prices. Typing the standard
 * price keeps the editor's `ri:oi:ai` inputs as before; a season's price applies when the field is left, to every
 * range of that season. A range's chip opens the season window; "+ Dates" adds a range with the season's name and
 * price. `addOnMount`: the first-price form's "Add a season" added the prices; the new-season window opens at once. */
export function StepSeasons({
  room,
  offer,
  roomIndex,
  offerIndex,
  label,
  inputs,
  disabled,
  onInput,
  onEditMeal,
  onEditChildren,
  names,
  shown,
  onPriceMode,
  onChange,
  onPending,
  addOnMount = false,
  onAddStarted,
  children,
}: {
  room: Room;
  offer: Offer;
  roomIndex: number;
  offerIndex: number;
  label: string;
  inputs: Record<string, string>;
  disabled: boolean;
  onInput: (key: string, value: string) => void;
  onEditMeal: () => void;
  onEditChildren: () => void;
  names: Readonly<Record<string, string>>;
  /** The room with the typed standard price (null while it doesn't parse): switching the price per number of guests
   * starts from it, and `onPriceMode` takes the result (the typed fields no longer match). */
  shown: Room | null;
  onPriceMode: (room: Room) => void;
  onChange: (room: Room) => void;
  onPending: (pending: boolean) => void;
  addOnMount?: boolean;
  onAddStarted?: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{ index: number | null; prefill?: SeasonGroup } | null>(
    null,
  );
  const [typed, setTyped] = useState<Record<string, string[]>>({}),
    [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<{ group: SeasonGroup; season?: Season } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!addOnMount || disabled) return;
    setEditing({ index: null });
    onAddStarted?.();
  }, [addOnMount, disabled, onAddStarted]);
  // A typed season price or an open window holds Save, like the other editors' unapplied entries.
  const pending = Object.keys(typed).length > 0 || editing !== null,
    report = useRef(onPending);
  useEffect(() => {
    report.current = onPending;
  });
  useEffect(() => {
    report.current(pending);
  }, [pending]);
  if (offer.price.kind !== "independent") return null;
  const calendar = offer.price.calendar,
    base = calendar.base,
    scale = pricingCurrencyScale(room.currency)!;
  const groups = seasonGroups(offer),
    symbol = currencySymbol(room.currency);
  const template = recurringTemplate(offer);
  const columns = template ? baseAmounts(template, t) : [];
  const day = (monthDay: string) =>
    `${Number(monthDay.slice(3))} ${t(`pricing.steps.monthShort.${Number(monthDay.slice(0, 2))}`)}`;
  const priceText = (season: Season) =>
    money(baseAmounts(season.price)[0]?.[1] ?? "0", room.currency);
  const amountField = (
    aria: string,
    value: string,
    onValue: (value: string) => void,
    invalid = false,
    onBlur?: () => void,
  ) => (
    <span
      className={`flex h-10 w-full min-w-0 items-center gap-1.5 rounded-[10px] bg-gray-100 px-3 focus-within:ring-2 ${invalid ? "ring-2 ring-red-500" : "focus-within:ring-primary-500"}`}
    >
      {symbol && (
        <span aria-hidden="true" className="text-[14px] text-gray-500">
          {symbol}
        </span>
      )}
      <input
        aria-label={aria}
        inputMode="decimal"
        disabled={disabled}
        value={value}
        onChange={(event) => onValue(event.target.value)}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (event.key === "Enter") onBlur?.();
        }}
        className="min-w-0 grow bg-transparent text-[14px] font-semibold text-gray-900 outline-none disabled:cursor-not-allowed disabled:text-gray-500"
      />
    </span>
  );
  /** Applies a season's typed price to each of its ranges. */
  const commit = (group: SeasonGroup) => {
    const values = typed[group.key];
    if (!values || disabled) return;
    try {
      let next = room;
      for (const season of group.seasons) {
        const original = {
          name: season.name,
          tier: season.tier,
          from: season.from,
          through: season.through,
        };
        next = changeSeasonPrice(next, offer.id, original, values, original);
      }
      onChange(next);
      setTyped((previous) => without(previous, group.key));
      setErrors((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([name]) => name !== group.key)),
      );
    } catch (cause) {
      setErrors((previous) => ({
        ...previous,
        [group.key]: errorText(cause, t, "pricing.seasons.changeFailed"),
      }));
    }
  };
  // A season's minimum stay is a stay-rule season with its days (VAY-2280): it follows the range when the range's
  // days change, goes with it, and a new range of the season gets it too.
  const remove = (seasons: readonly Season[]) => {
    if (disabled) return;
    try {
      let next = room;
      for (const season of seasons)
        next = moveRangeRule(changeSeasonPrice(next, offer.id, season, null), season, null);
      onChange(next);
      setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.seasons.changeFailed"));
    }
  };
  const open = (target: { index: number | null; prefill?: SeasonGroup }) => {
    if (!disabled) setEditing(target);
  };
  const ownRules = offer.restrictions.kind === "own" && mainOffer(room).id === offer.id;
  const windowChange = (next: Room) => {
    try {
      const before = calendar.seasons,
        after = next.offers.find((value) => value.id === offer.id)?.price;
      const nextSeasons = after?.kind === "independent" ? after.calendar.seasons : [];
      let synced = next;
      if (ownRules && editing?.index != null) {
        const old = before[editing.index];
        synced = moveRangeRule(
          synced,
          old,
          nextSeasons.length < before.length ? null : (nextSeasons[editing.index] ?? null),
        );
      } else if (ownRules && editing?.prefill && nextSeasons.length > before.length) {
        const nights = rangeMinimum(room, editing.prefill.seasons[0]);
        if (nights !== stayDefaults(room).minArrivalNights)
          synced = setRangeMinimum(synced, [nextSeasons[nextSeasons.length - 1]], nights);
      }
      onChange(synced);
      setError("");
    } catch (cause) {
      onChange(next);
      setError(errorText(cause, t, "pricing.seasonTable.minStayError"));
    }
    setEditing(null);
  };
  const step = (change: () => Room) => {
    if (disabled) return;
    try {
      onChange(change());
      setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.seasonTable.minStayError"));
    }
  };
  /** `season`: a season's row (its buttons say which season); none: the standard price's (the main option's default). */
  const stepper = (
    aria: string,
    nights: number,
    change: (nights: number) => Room,
    season?: string,
  ) => (
    <div
      role="group"
      aria-label={aria}
      className="flex h-10 w-full items-center justify-between rounded-[10px] border border-gray-300 bg-white px-1.5 md:w-[112px]"
    >
      <button
        type="button"
        aria-label={
          season ? t("pricing.seasonTable.fewerFor", { season }) : t("pricing.steps.rules.fewer")
        }
        disabled={disabled || nights <= 1}
        onClick={() => step(() => change(nights - 1))}
        className="rounded-md p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
      >
        <MinusIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <output
        aria-live="polite"
        className="whitespace-nowrap text-[13px] font-medium text-gray-900"
      >
        {t(nights === 1 ? "pricing.seasonTable.nightOne" : "pricing.seasonTable.nightOther", {
          count: nights,
        })}
      </output>
      <button
        type="button"
        aria-label={
          season ? t("pricing.seasonTable.moreFor", { season }) : t("pricing.steps.rules.more")
        }
        disabled={disabled}
        onClick={() => step(() => change(nights + 1))}
        className="rounded-md p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
      >
        <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
  const guests = base && room.capacity.adults > 1 ? base : null;
  const back = guests?.mode === "occupancy" && shown ? onePriceAgain(shown) : null;
  const switchGuests = () => {
    if (disabled || !guests || !shown) return;
    try {
      const next = guests.mode === "flat" ? pricePerAdultCount(shown) : back;
      if (next) onPriceMode(next);
      setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.setup.errorConfiguration"));
    }
  };
  const pieces = yearPieces(offer);
  const gaps = pieces.some((piece) => piece.source.kind === "none");
  const tone = (index: number) => groups.find((group) => group.indexes.includes(index))?.tone ?? 0;
  const meal = offer.meal,
    own = ownRules ? ownRuleOptions(room) : [];
  return (
    <StepCard step={2} title={t("pricing.seasonTable.title")} hint={t("pricing.seasonTable.hint")}>
      {(groups.length > 0 || gaps) && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-gray-700">
              {t("pricing.seasonTable.year")}
            </span>
            <span className={`text-[12px] ${gaps ? "font-medium text-red-700" : "text-gray-500"}`}>
              {t(gaps ? "pricing.seasonTable.gaps" : "pricing.seasonTable.fills")}
            </span>
          </div>
          <div aria-hidden="true" className="flex h-2.5 overflow-hidden rounded-full">
            {pieces.map((piece) => (
              <span
                key={piece.start}
                style={{ flexGrow: piece.days }}
                className={
                  piece.source.kind === "season"
                    ? seasonTones[tone(piece.source.index)].dot
                    : piece.source.kind === "none"
                      ? "bg-red-500"
                      : piece.source.kind === "month"
                        ? "bg-gray-400"
                        : "bg-gray-200"
                }
              />
            ))}
          </div>
          <div aria-hidden="true" className="flex text-[11px] text-gray-500">
            {Array.from({ length: 12 }, (_, month) => (
              <span key={month} className="flex-1">
                {t(`pricing.steps.monthShort.${month + 1}`)}
              </span>
            ))}
          </div>
        </div>
      )}
      {guests && (
        <div className="flex items-center gap-3 rounded-xl bg-gray-50 px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-gray-900">
              {t("pricing.seasonTable.guests")}
            </p>
            <p className="text-[13px] text-gray-500">
              {guests.mode === "flat"
                ? t("pricing.seasonTable.guestsOff", { count: room.capacity.total })
                : guests.mode === "occupancy"
                  ? t(back ? "pricing.seasonTable.guestsOn" : "pricing.seasonTable.guestsLocked", {
                      count: room.capacity.adults,
                    })
                  : t("pricing.seasonTable.guestsOther", {
                      summary:
                        guests.mode === "per_person"
                          ? `${money(guests.unitMinor, room.currency)} ${t("pricing.steps.price.perAdultNight")}`
                          : guests.adjustments
                              .map((adjustment, index) =>
                                index + 1 === guests.baseGuests
                                  ? `${t(index ? "pricing.adults.other" : "pricing.adults.one", { count: index + 1 })} ${money(guests.baseMinor, room.currency)}`
                                  : `${t(index ? "pricing.adults.other" : "pricing.adults.one", { count: index + 1 })} ${adjustmentText(adjustment, room.currency)}`,
                              )
                              .join(" · "),
                    })}
            </p>
          </div>
          {(guests.mode === "flat" || guests.mode === "occupancy") && (
            <button
              type="button"
              role="switch"
              aria-checked={guests.mode === "occupancy"}
              aria-label={t("pricing.seasonTable.guests")}
              disabled={disabled || !shown || (guests.mode === "occupancy" && !back)}
              onClick={switchGuests}
              className={ui.switchTrack(guests.mode === "occupancy")}
            >
              <span className="h-[18px] w-[18px] rounded-full bg-white shadow-sm" />
            </button>
          )}
        </div>
      )}
      <div role="table" aria-label={t("pricing.seasonTable.title")} className="text-[14px]">
        <div
          role="row"
          className="hidden gap-3 border-b border-gray-200 pb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500 md:flex"
        >
          <span role="columnheader" className="w-[200px] shrink-0">
            {t("pricing.seasonTable.season")}
          </span>
          <span role="columnheader" className="min-w-0 flex-1">
            {t("pricing.seasonTable.dates")}
          </span>
          {ownRules && (
            <span role="columnheader" className="w-[112px] shrink-0">
              {t("pricing.seasonTable.minStay")}
            </span>
          )}
          {columns.map(([name]) => (
            <span key={name} role="columnheader" className="w-[104px] shrink-0">
              {columns.length > 1 ? name : t("pricing.seasonTable.price")}
            </span>
          ))}
          <span className="w-6 shrink-0" />
        </div>
        <div role="row" className="flex flex-col gap-2 py-3.5 md:flex-row md:items-start md:gap-3">
          <div role="cell" className="flex w-full shrink-0 items-start gap-2.5 md:w-[200px]">
            <span
              aria-hidden="true"
              className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-[3px] bg-gray-300"
            />
            <span>
              <span className="block font-semibold text-gray-900">
                {t("pricing.seasonTable.standard")}
              </span>
              <span className="block text-[12px] text-gray-500">
                {t("pricing.seasonTable.standardHint")}
              </span>
            </span>
          </div>
          <div role="cell" className="min-w-0 flex-1 pt-2 text-[13px] text-gray-500">
            {base ? t("pricing.seasonTable.otherDates") : t("pricing.steps.price.noBase")}
          </div>
          {ownRules && (
            <div role="cell" className="w-full md:w-[112px] md:shrink-0">
              {stepper(
                t("pricing.seasonTable.minStayAria", { season: t("pricing.seasonTable.standard") }),
                stayDefaults(room).minArrivalNights,
                (nights) => setMinimumNights(room, nights),
              )}
            </div>
          )}
          {base &&
            baseAmounts(base, t).map(([name, minor], ai) => (
              <div key={ai} role="cell" className="w-full md:w-[104px] md:shrink-0">
                {columns.length > 1 && (
                  <span className="mb-1 block text-[12px] text-gray-500 md:hidden">{name}</span>
                )}
                {amountField(
                  `${label} ${name}`,
                  inputs[`${roomIndex}:${offerIndex}:${ai}`] ?? decimalAmount(minor, scale),
                  (value) => onInput(`${roomIndex}:${offerIndex}:${ai}`, value),
                )}
              </div>
            ))}
          <span className="hidden w-6 shrink-0 md:block" />
        </div>
        {groups.map((group) => {
          const values =
            typed[group.key] ??
            baseAmounts(group.seasons[0].price).map(([, minor]) => decimalAmount(minor, scale));
          const nights = group.seasons.reduce(
            (sum, season) => sum + days(season.from, season.through),
            0,
          );
          return (
            <div key={group.key} role="row" className="space-y-1.5 border-t border-gray-100 py-3.5">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:gap-3">
                <div role="cell" className="flex w-full shrink-0 items-start gap-2.5 md:w-[200px]">
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-[3px] ${seasonTones[group.tone].dot}`}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-gray-900">{group.name}</span>
                    <span className="block text-[12px] text-gray-500">
                      {t("pricing.seasonTable.nights", { count: nights })}
                    </span>
                  </span>
                </div>
                <div role="cell" className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                  {group.seasons.map((season, at) => {
                    const range = `${day(season.from)} – ${day(season.through)}`;
                    return (
                      <span
                        key={at}
                        className={`inline-flex h-7 items-center gap-1 rounded-full border pl-2.5 pr-1 ${seasonTones[group.tone].cell}`}
                      >
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => open({ index: group.indexes[at] })}
                          className="text-[13px] font-medium text-gray-800 disabled:cursor-not-allowed"
                          aria-label={t("pricing.steps.seasons.editAria", {
                            season: `${season.name} · ${priceText(season)}`,
                            days: range,
                          })}
                        >
                          {range}
                        </button>
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={t("pricing.seasonTable.removeRange", {
                            days: range,
                            season: season.name,
                          })}
                          onClick={() =>
                            group.seasons.length > 1 ? remove([season]) : setDeleting({ group })
                          }
                          className="rounded-full p-0.5 text-gray-500 hover:bg-white/60 disabled:opacity-50"
                        >
                          <XMarkIcon aria-hidden="true" className="h-3 w-3" />
                        </button>
                      </span>
                    );
                  })}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => open({ index: null, prefill: group })}
                    className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-primary-300 px-2.5 text-[13px] font-medium text-primary-600 disabled:opacity-50"
                    aria-label={t("pricing.seasonTable.addDatesAria", { season: group.name })}
                  >
                    <PlusIcon aria-hidden="true" className="h-3 w-3" />{" "}
                    {t("pricing.seasonTable.addDates")}
                  </button>
                </div>
                {ownRules && (
                  <div role="cell" className="w-full md:w-[112px] md:shrink-0">
                    {stepper(
                      t("pricing.seasonTable.minStayAria", { season: group.name }),
                      rangeMinimum(room, group.seasons[0]),
                      (nights) => setRangeMinimum(room, group.seasons, nights),
                      group.name,
                    )}
                  </div>
                )}
                {values.map((value, ai) => (
                  <div key={ai} role="cell" className="w-full md:w-[104px] md:shrink-0">
                    {columns.length > 1 && (
                      <span className="mb-1 block text-[12px] text-gray-500 md:hidden">
                        {columns[ai]?.[0]}
                      </span>
                    )}
                    {amountField(
                      t("pricing.seasonTable.priceAria", {
                        season: group.name,
                        field: columns[ai]?.[0] ?? "",
                      }),
                      value,
                      (next) =>
                        setTyped((previous) => ({
                          ...previous,
                          [group.key]: values.map((current, at) => (at === ai ? next : current)),
                        })),
                      !!errors[group.key],
                      () => commit(group),
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t("pricing.seasonTable.delete", { season: group.name })}
                  onClick={() => setDeleting({ group })}
                  className="flex h-10 w-6 shrink-0 items-center justify-center self-end text-gray-400 hover:text-red-600 disabled:opacity-50 md:self-auto"
                >
                  <TrashIcon aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
              {errors[group.key] && (
                <p role="alert" className={ui.errorText}>
                  {errors[group.key]}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {template ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => open({ index: null })}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-primary-300 px-3.5 text-[14px] font-medium text-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlusIcon aria-hidden="true" className="h-4 w-4" /> {t("pricing.steps.seasons.add")}
        </button>
      ) : (
        <p className={ui.stepHint}>{t("pricing.seasons.noTemplate")}</p>
      )}
      {error && (
        <p role="alert" className={ui.errorText}>
          {error}
        </p>
      )}
      {own.length > 0 && (
        <p className={ui.stepHint}>
          {t("pricing.steps.rules.own", {
            names: own.map((value) => names[value.id] ?? "").join(", "),
          })}
        </p>
      )}
      {children}
      {room.capacity.children > 0 && (
        <div className="flex items-center gap-3 border-t border-gray-100 pt-4">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-gray-900">
              {t("pricing.steps.rules.children")}
            </p>
            <p className="truncate text-[13px] text-gray-500">{childrenSummary(room, t)}</p>
            {(room.children.bands.every((band) => band.countsTowardCapacity) ||
              room.children.bands.every((band) => !band.countsTowardCapacity)) && (
              <p className="text-[12px] text-gray-500">
                {room.children.bands.every((band) => band.countsTowardCapacity)
                  ? t("pricing.simple.more.childrenCounted", { count: room.capacity.total })
                  : t("pricing.simple.more.childrenNotCounted")}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label={t("pricing.steps.rules.childrenEdit")}
            disabled={disabled}
            onClick={onEditChildren}
            className={`shrink-0 ${ui.stepLink}`}
          >
            {t("pricing.steps.options.edit")}
          </button>
        </div>
      )}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-gray-600">
        {meal.kind === "room_only"
          ? t("pricing.simple.roomOnly")
          : t("pricing.simple.mealIncluded", {
              meal: t(`pricing.meal.${meal.kind}`),
              amount: t(
                meal.charge.kind === "room"
                  ? "pricing.simple.extras.perRoomAmount"
                  : "pricing.simple.extras.perAdultAmount",
                {
                  amount: money(
                    meal.charge.kind === "room" ? meal.charge.amountMinor : meal.charge.adultMinor,
                    room.currency,
                  ),
                },
              ),
            })}
        <button
          type="button"
          aria-label={t("pricing.simple.mealEdit")}
          disabled={disabled}
          onClick={onEditMeal}
          className={ui.stepLink}
        >
          {t("pricing.steps.options.edit")}
        </button>
      </p>
      {editing && (
        <SeasonWindow
          room={room}
          offer={offer}
          label={label}
          index={editing.index}
          disabled={disabled}
          prefill={
            editing.prefill && {
              name: editing.prefill.name,
              tier: editing.prefill.tier,
              values: baseAmounts(editing.prefill.seasons[0].price).map(([, minor]) =>
                decimalAmount(minor, scale),
              ),
            }
          }
          onChange={windowChange}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t("pricing.seasonTable.deleteTitle", { season: deleting.group.name })}
          message={t("pricing.seasonTable.deleteMessage")}
          confirmLabel={t("pricing.seasonTable.deleteConfirm")}
          cancelLabel={t("common.cancel")}
          variant="danger"
          onConfirm={() => {
            remove(deleting.group.seasons);
            setTyped((previous) => without(previous, deleting.group.key));
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </StepCard>
  );
}
