"use client";

import Link from "next/link";
import { parseISO } from "date-fns";
import { addDays, money } from "@/components/pricing/stepPricing";
import { bookingChannelLabel } from "@/lib/bookings/channelLabel";
import { useTranslation } from "@/lib/i18n";
import type { CalendarBlock, CalendarBooking, CalendarRoom } from "@/services/calendar";
import CalendarPopover, {
  BLOCK_ICON,
  PLUS_ICON,
  PopoverAction,
  PopoverBadge,
  type PopoverAnchor,
} from "./CalendarPopover";
import { byPrice, type NightRate } from "./calendarPrices";

const nightsBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The popover of a free night or of a stay dragged across free nights (VAY-2411): the rates, the room's next booking,
 * the stay rules it breaks, and New Booking / Block Room for those nights. Prices are never edited here. */
export default function NightPopover({
  room,
  startDate,
  endDate,
  anchor,
  currency,
  pricesFailed,
  nightRates,
  names,
  bookings,
  blocks,
  lastDay,
  onNewBooking,
  onBlockRoom,
  onClose,
}: {
  room: CalendarRoom;
  startDate: string;
  /** The check-out day, after the last night. */
  endDate: string;
  anchor: PopoverAnchor;
  /** The published prices' currency; null while there are none. */
  currency: string | null;
  /** The prices could not be read (not "none published yet"). */
  pricesFailed: boolean;
  /** This room type's open rates per night, cheapest first. */
  nightRates: Record<string, NightRate[]> | undefined;
  names: Record<string, string>;
  bookings: readonly CalendarBooking[];
  blocks: readonly CalendarBlock[];
  /** The last night the calendar has loaded bookings for. */
  lastDay: string;
  onNewBooking?: () => void;
  onBlockRoom: () => void;
  onClose: () => void;
}) {
  const { locale, t } = useTranslation();
  const nights = nightsBetween(startDate, endDate);
  const single = nights === 1;
  const nightsLabel = (count: number) =>
    `${count} ${t(count === 1 ? "common.night" : "common.nights")}`;
  const day = (date: string, weekday = false) =>
    parseISO(date).toLocaleDateString(locale, {
      ...(weekday ? { weekday: "short" as const } : {}),
      month: "short",
      day: "numeric",
    });
  const price = (minor: string) => money(minor, currency ?? "");

  const dates = Array.from({ length: nights }, (_, i) => addDays(startDate, i));
  const first = nightRates?.[startDate] ?? [];
  const lowest = first[0];
  // The next booking or block after these nights, and the next guest to arrive.
  const nextTaken = [...bookings.map((b) => b.checkIn), ...blocks.map((bl) => bl.startDate)]
    .filter((start) => start >= endDate)
    .sort()[0];
  const nextArrival = bookings
    .filter((b) => b.checkIn >= endDate)
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn))[0];
  const gap = nextTaken ? nightsBetween(endDate, nextTaken) : 0;
  const minAfter = nightRates?.[endDate]?.[0]?.minNights ?? 1;

  // Each rate's total for the stay: its nightly prices added up, for the rates open every night. Shown even when the
  // stay breaks a rule, which the warnings below explain.
  const totals = single
    ? []
    : Object.keys(names)
        .flatMap((offerId) => {
          let total = BigInt(0);
          for (const date of dates) {
            const rate = nightRates?.[date]?.find((value) => value.offerId === offerId);
            if (!rate) return [];
            total += BigInt(rate.totalMinor);
          }
          return [{ offerId, totalMinor: total.toString() }];
        })
        .sort(byPrice);

  const warnings = [
    lowest && lowest.minNights > nights
      ? t("calendar.popover.minStayWarning", { nights: nightsLabel(lowest.minNights) })
      : null,
    lowest?.noArrival
      ? t("calendar.popover.noArrivalWarning", { date: day(startDate, true) })
      : null,
    !single && currency && dates.some((date) => !nightRates?.[date]?.length)
      ? t("calendar.popover.closedNightsWarning")
      : null,
    gap > 0 && (gap < 2 || gap < minAfter)
      ? t("calendar.popover.gapWarning", { nights: nightsLabel(gap) })
      : null,
  ].filter((warning): warning is string => warning !== null);

  const title = single
    ? day(startDate, true)
    : t("calendar.popover.nightsHeader", {
        from: day(startDate),
        to: day(endDate),
        nights: nightsLabel(nights),
      });
  const rateRow = (rate: { offerId: string; totalMinor: string }, index: number) => (
    <li key={rate.offerId} className="flex items-center justify-between gap-2 py-0.5">
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="truncate">{names[rate.offerId] ?? rate.offerId}</span>
        {index === 0 && (
          <span className="shrink-0 px-1.5 py-0.5 rounded bg-green-50 text-green-700 text-[11px] font-medium">
            {t("calendar.popover.lowest")}
          </span>
        )}
      </span>
      <span className="font-semibold text-gray-900 tabular-nums">{price(rate.totalMinor)}</span>
    </li>
  );

  return (
    <CalendarPopover
      anchor={anchor}
      label={`#${room.roomNumber} · ${title}`}
      eyebrow={`#${room.roomNumber}`}
      title={title}
      badge={<PopoverBadge tone="green">{t("calendar.popover.available")}</PopoverBadge>}
      onClose={onClose}
    >
      <div className="px-4 py-3 space-y-3 text-sm text-gray-700">
        <section>
          <div className="flex items-center justify-between gap-2 mb-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              {t(single ? "calendar.popover.pricePerNight" : "calendar.popover.lowestPerNight")}
            </h3>
            {single && lowest && (
              <span className="text-[11px] text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">
                {t("calendar.popover.season", {
                  name: lowest.season ?? t("calendar.popover.seasonStandard"),
                })}
              </span>
            )}
          </div>
          {!currency ? (
            <p className="text-gray-500">
              {t(pricesFailed ? "calendar.popover.pricesFailed" : "calendar.popover.noPrices")}
            </p>
          ) : single ? (
            first.length ? (
              <ul>{first.map(rateRow)}</ul>
            ) : (
              <p className="text-gray-500">{t("calendar.popover.notForSale")}</p>
            )
          ) : (
            <ul className="max-h-32 overflow-y-auto">
              {dates.map((date) => {
                const cheapest = nightRates?.[date]?.[0];
                return (
                  <li key={date} className="flex items-center justify-between gap-2 py-0.5">
                    <span>{day(date, true)}</span>
                    <span className="tabular-nums">
                      {cheapest ? price(cheapest.totalMinor) : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {currency && totals.length > 0 && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
              {t("calendar.popover.total")}
            </h3>
            <ul>{totals.map(rateRow)}</ul>
          </section>
        )}
        {single && lowest && (
          <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
            <span className="text-gray-500">{t("calendar.popover.minStay")}</span>
            <span className="font-semibold text-gray-900">{nightsLabel(lowest.minNights)}</span>
          </div>
        )}
        {warnings.length > 0 && (
          <ul className="space-y-1">
            {warnings.map((warning) => (
              <li
                key={warning}
                className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800"
              >
                {warning}
              </li>
            ))}
          </ul>
        )}
        {single && (
          <div className="space-y-1 text-[13px]">
            <p>
              <span aria-hidden="true" className="text-gray-400 mr-1.5">
                →
              </span>
              {nextTaken
                ? t("calendar.popover.freeUntil", {
                    date: day(nextTaken),
                    nights: nightsLabel(nightsBetween(startDate, nextTaken)),
                  })
                : t("calendar.popover.freeThrough", { date: day(lastDay) })}
            </p>
            {nextArrival && (
              <p>
                {t("calendar.popover.nextArrival", {
                  date: day(nextArrival.checkIn),
                  guest: `${nextArrival.guestFirstName} ${nextArrival.guestLastName}`.trim(),
                  channel: bookingChannelLabel(nextArrival.channel, t),
                })}
              </p>
            )}
            <p className="text-gray-500">{t("calendar.popover.dragHint")}</p>
          </div>
        )}
      </div>
      <div className="p-1 border-t border-gray-100">
        {onNewBooking && (
          <PopoverAction
            tone="primary"
            icon={PLUS_ICON}
            label={
              single
                ? t("calendar.newBooking").replace(/^\+\s*/, "")
                : t("calendar.popover.newBookingNights", { nights: nightsLabel(nights) })
            }
            onClick={onNewBooking}
          />
        )}
        <PopoverAction
          tone="red"
          icon={BLOCK_ICON}
          label={t("calendar.blockRoom")}
          onClick={onBlockRoom}
        />
      </div>
      {single && (
        <div className="px-4 py-2.5 border-t border-gray-100 text-right">
          <Link
            href={`/rooms/${room.roomTypeId}?tab=prices&date=${startDate}`}
            className="text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            {t("calendar.popover.editPrices")} →
          </Link>
        </div>
      )}
    </CalendarPopover>
  );
}
