"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  addMonths,
  isSameMonth,
  isSameDay,
  parseISO,
  isWithinInterval,
} from "date-fns";
import {
  CalendarBooking,
  CalendarBlock,
  CalendarRoom,
  CalendarRoomType,
} from "@/services/calendar";
import { money } from "@/components/pricing/stepPricing";
import { getChannelBarColor } from "@/lib/constants/statusStyles";
import { AWAITING_PAYMENT_BADGE_CLASS, formatPaymentDeadline } from "@/lib/awaitingPayment";
import { useTranslation } from "@/lib/i18n";
import { groupRoomsByType } from "@/lib/roomOrdering";
import { byPrice, cellPrice, nightTaken, type NightRate } from "./calendarPrices";

export const calendarLaneTop = (index: number) => index * 36 + 6;

interface MobileCalendarProps {
  currentMonth: Date;
  bookings: CalendarBooking[];
  blocks: CalendarBlock[];
  roomTypes: CalendarRoomType[];
  /** Every room in the calendar's order: a tapped day lists them all with their status and price (VAY-2470). */
  rooms: CalendarRoom[];
  /** The blocks holding a room, as the timeline draws them (legacy count blocks fill a type's first rooms). */
  blocksForRoom: (room: CalendarRoom) => CalendarBlock[];
  /** Each room type's open rates per night, cheapest first, from the published prices. */
  nightRates: Record<string, Record<string, NightRate[]>>;
  /** The published prices' currency; null while there are none. */
  currency: string | null;
  loading?: boolean;
  loadError?: boolean;
  onMonthChange: (month: Date) => void;
  onSelectBooking: (booking: CalendarBooking) => void;
  // Both dates are yyyy-MM-dd. endDate is the exclusive checkout (last selected
  // day + 1), matching desktop drag-select semantics.
  onNewBooking: (startDate?: string, endDate?: string) => void;
  onBlockRoom: (startDate: string, endDate: string) => void;
  onSelectBlock: (block: CalendarBlock) => void;
  /** A free room tapped, for its nights from startDate up to the check-out endDate (both yyyy-MM-dd). */
  onSelectRoom: (room: CalendarRoom, startDate: string, endDate: string) => void;
  writeActionsAvailable?: boolean;
  manualBookingAvailable?: boolean;
  /** The hotel's time zone, for payment deadlines (VAY-2348). */
  hotelTimeZone?: string | null;
}

export default function MobileCalendar({
  currentMonth,
  bookings,
  blocks,
  roomTypes,
  rooms,
  blocksForRoom,
  nightRates,
  currency,
  loading = false,
  loadError = false,
  onMonthChange,
  onSelectBooking,
  onNewBooking,
  onBlockRoom,
  onSelectBlock,
  onSelectRoom,
  writeActionsAvailable = true,
  manualBookingAvailable = writeActionsAvailable,
  hotelTimeZone = null,
}: MobileCalendarProps) {
  const { locale, t } = useTranslation();
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) =>
        new Date(2024, 0, index + 1).toLocaleDateString(locale, { weekday: "short" }),
      ),
    [locale],
  );
  // Selection model: tap a day to single-select it (so the user can browse
  // that day's bookings/blocks); drag from one day onto another to form a
  // range. The drag mirrors desktop's pointer drag-to-select. While the
  // user is mid-drag, `drag` holds the live anchor + current day so we can
  // paint the in-progress range without committing to selection state yet.
  const [selectionStart, setSelectionStart] = useState<Date | null>(new Date());
  const [selectionEnd, setSelectionEnd] = useState<Date | null>(new Date());
  const [drag, setDrag] = useState<{ start: Date; current: Date; moved: boolean } | null>(null);
  const dragRef = useRef<typeof drag>(null);
  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);
  // Tracks the (clientX, clientY) where the pointer first went down. Used to
  // distinguish a tap from a drag — only past a small movement threshold do
  // we start treating the gesture as a range select.
  const downPosRef = useRef<{ x: number; y: number } | null>(null);

  const clearRange = () => {
    if (selectionStart) setSelectionEnd(selectionStart);
  };

  // Pointer-drag handlers wired to each day button. Single tap (no movement
  // past threshold) commits the tapped day; a drag onto another day commits
  // the range (auto-sorted).
  const DRAG_THRESHOLD = 8;
  const handleDayPointerDown = (e: React.PointerEvent<HTMLButtonElement>, day: Date) => {
    if (e.button !== undefined && e.button !== 0) return;
    downPosRef.current = { x: e.clientX, y: e.clientY };
    setDrag({ start: day, current: day, moved: false });
    // Capture so subsequent move events keep coming to us even when the
    // finger / pointer leaves this exact button.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore — capture is best-effort, some environments don't support it
    }
  };

  useEffect(() => {
    if (!drag) return;
    const findDayUnderPointer = (clientX: number, clientY: number): Date | null => {
      const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      if (!el) return null;
      const cell = el.closest("[data-day]") as HTMLElement | null;
      if (!cell) return null;
      const iso = cell.getAttribute("data-day");
      if (!iso) return null;
      return parseISO(iso);
    };
    const onMove = (ev: PointerEvent) => {
      const down = downPosRef.current;
      const d = dragRef.current;
      if (!d) return;
      const dist = down
        ? Math.hypot(ev.clientX - down.x, ev.clientY - down.y)
        : Number.POSITIVE_INFINITY;
      const moved = d.moved || dist > DRAG_THRESHOLD;
      const dayAt = findDayUnderPointer(ev.clientX, ev.clientY);
      const nextCurrent = dayAt ?? d.current;
      if (moved && ev.cancelable) ev.preventDefault();
      if (moved === d.moved && nextCurrent.getTime() === d.current.getTime()) {
        return;
      }
      setDrag({ start: d.start, current: nextCurrent, moved });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      downPosRef.current = null;
      if (!d) return;
      if (!d.moved) {
        setSelectionStart(d.start);
        setSelectionEnd(d.start);
        return;
      }
      const a = d.start;
      const b = d.current;
      if (a <= b) {
        setSelectionStart(a);
        setSelectionEnd(b);
      } else {
        setSelectionStart(b);
        setSelectionEnd(a);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build array of calendar days
  const days = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const calStart = startOfWeek(monthStart, { weekStartsOn: 1 });
    const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
    const result: Date[] = [];
    let day = calStart;
    while (day <= calEnd) {
      result.push(day);
      day = addDays(day, 1);
    }
    return result;
  }, [currentMonth]);

  // Map each day to its bookings
  const bookingsByDay = useMemo(() => {
    const map: Record<string, CalendarBooking[]> = {};
    for (const b of bookings) {
      const start = parseISO(b.checkIn);
      const end = addDays(parseISO(b.checkOut), -1); // checkOut is departure day
      for (const day of days) {
        if (isWithinInterval(day, { start, end })) {
          const key = format(day, "yyyy-MM-dd");
          if (!map[key]) map[key] = [];
          if (!map[key].find((x) => x.id === b.id && x.roomPosition === b.roomPosition)) {
            map[key].push(b);
          }
        }
      }
    }
    return map;
  }, [bookings, days]);

  // Map each day to its blocks. A block's endDate is exclusive (checkout-style,
  // same convention as bookings) so the last occupied day is endDate - 1.
  const blocksByDay = useMemo(() => {
    const map: Record<string, CalendarBlock[]> = {};
    for (const bl of blocks) {
      const start = parseISO(bl.startDate);
      const end = addDays(parseISO(bl.endDate), -1);
      if (end < start) continue;
      for (const day of days) {
        if (isWithinInterval(day, { start, end })) {
          const key = format(day, "yyyy-MM-dd");
          if (!map[key]) map[key] = [];
          if (!map[key].find((x) => x.id === bl.id)) {
            map[key].push(bl);
          }
        }
      }
    }
    return map;
  }, [blocks, days]);

  // While dragging past the threshold, derive everything below from the live
  // preview range so the header, nights count, and bookings/blocks list all
  // update in real time. After release `dragPreview` is null and these fall
  // back to the committed selection.
  const headerStart = drag?.moved
    ? drag.start <= drag.current
      ? drag.start
      : drag.current
    : selectionStart;
  const headerEnd = drag?.moved
    ? drag.start <= drag.current
      ? drag.current
      : drag.start
    : selectionEnd;

  // The (preview or committed) nights, so the room list shows what's free while picking dates for a booking/block.
  const rangeDays = useMemo(() => {
    if (!headerStart || !headerEnd) return [] as Date[];
    const result: Date[] = [];
    let d = headerStart;
    while (d <= headerEnd) {
      result.push(d);
      d = addDays(d, 1);
    }
    return result;
  }, [headerStart, headerEnd]);

  // VAY-2470: every room for the (preview or committed) nights, as the timeline shows them: who holds it, or what it
  // costs. A stay ends on its check-out day, so a guest leaving on the first day doesn't hold the room.
  const listStart = headerStart ? format(headerStart, "yyyy-MM-dd") : null;
  const listEnd = headerEnd ? format(addDays(headerEnd, 1), "yyyy-MM-dd") : null;
  const nightKeys = useMemo(() => rangeDays.map((d) => format(d, "yyyy-MM-dd")), [rangeDays]);
  const holds = (start: string, end: string) =>
    listStart !== null && listEnd !== null && start < listEnd && end > listStart;
  const bookingsByRoomId = useMemo(() => {
    const map = new Map<string, CalendarBooking[]>();
    for (const b of bookings) {
      if (!b.roomId) continue;
      const list = map.get(b.roomId);
      if (list) list.push(b);
      else map.set(b.roomId, [b]);
    }
    return map;
  }, [bookings]);
  // Under each date, the cheapest rate among the rooms free that night, as the timeline prices its free nights. Hidden
  // while a month loads, so no night looks free before its bookings arrive.
  const dayPrices = useMemo(() => {
    const prices: Record<string, string> = {};
    if (!currency || loading || loadError) return prices;
    const stays = new Map(
      rooms.map((room) => [
        room.id,
        [
          ...(bookingsByRoomId.get(room.id) ?? []).map((b) => ({
            start: b.checkIn,
            end: b.checkOut,
          })),
          ...blocksForRoom(room).map((bl) => ({ start: bl.startDate, end: bl.endDate })),
        ],
      ]),
    );
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      let best: NightRate | undefined;
      for (const room of rooms) {
        const lowest = nightRates[room.roomTypeId]?.[key]?.[0];
        if (!lowest || nightTaken(stays.get(room.id) ?? [], key)) continue;
        if (!best || byPrice(lowest, best) < 0) best = lowest;
      }
      if (best) prices[key] = cellPrice(best.totalMinor, currency, locale);
    }
    return prices;
  }, [
    currency,
    loading,
    loadError,
    rooms,
    bookingsByRoomId,
    blocksForRoom,
    nightRates,
    days,
    locale,
  ]);
  const roomGroups = groupRoomsByType(rooms).map(({ roomTypeId, rooms: typed }) => ({
    roomTypeId,
    name: roomTypes.find((type) => type.id === roomTypeId)?.name ?? typed[0]?.roomTypeName ?? "",
    rooms: typed.map((room) => ({
      room,
      bookings: (bookingsByRoomId.get(room.id) ?? [])
        .filter((b) => holds(b.checkIn, b.checkOut))
        .sort((a, b) => a.checkIn.localeCompare(b.checkIn)),
      blocks: blocksForRoom(room).filter((bl) => holds(bl.startDate, bl.endDate)),
    })),
  }));
  const unassignedHere = bookings.filter((b) => !b.roomId && holds(b.checkIn, b.checkOut));

  /** A free room's price for the chosen nights, in minor units: the cheapest rate for one night, else the cheapest
   * stay total among the rates open every night (as the stay popover adds them up). Null when no rate is open;
   * undefined without published prices. */
  const freePrice = (roomTypeId: string): string | null | undefined => {
    if (!currency || nightKeys.length === 0) return undefined;
    const rates = nightRates[roomTypeId];
    if (nightKeys.length === 1) return rates?.[nightKeys[0]!]?.[0]?.totalMinor ?? null;
    const totals = (rates?.[nightKeys[0]!] ?? []).flatMap(({ offerId }) => {
      let total = BigInt(0);
      for (const key of nightKeys) {
        const rate = rates?.[key]?.find((value) => value.offerId === offerId);
        if (!rate) return [];
        total += BigInt(rate.totalMinor);
      }
      return [{ totalMinor: total.toString() }];
    });
    return totals.sort(byPrice)[0]?.totalMinor ?? null;
  };
  const shortDay = (date: string) =>
    parseISO(date).toLocaleDateString(locale, { month: "short", day: "numeric" });

  const isRangeSelection = !!headerStart && !!headerEnd && !isSameDay(headerStart, headerEnd);
  const nights = rangeDays.length; // 1 for single-day selection, N for an N-day range

  // Calendar grid uses the same preview-or-committed bounds so the painted
  // range, the header, and the bookings/blocks list never disagree.
  const previewStart = headerStart;
  const previewEnd = headerEnd;

  // Both dates yyyy-MM-dd. endDate is exclusive checkout (last selected day +
  // 1) to match desktop drag-select semantics.
  const rangeStartStr = selectionStart ? format(selectionStart, "yyyy-MM-dd") : null;
  const rangeEndStr = selectionEnd ? format(addDays(selectionEnd, 1), "yyyy-MM-dd") : null;

  const today = new Date();

  return (
    <div className="flex flex-col h-full">
      {/* Month header */}
      <div className="bg-white border-b border-gray-200 px-4 pt-3 pb-2">
        <div className="text-center text-[11px] text-gray-400 mb-1">
          {currentMonth.toLocaleDateString(locale, { year: "numeric" })}
        </div>
        <div className="flex items-center justify-between">
          <button
            type="button"
            aria-label={t("calendar.prevMonth")}
            onClick={() => onMonthChange(addMonths(currentMonth, -1))}
            className="p-1.5 text-gray-500 hover:text-gray-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <h2 className="text-[15px] font-bold text-gray-900">
            {currentMonth.toLocaleDateString(locale, { month: "long" })}
          </h2>
          <button
            type="button"
            aria-label={t("calendar.nextMonth")}
            onClick={() => onMonthChange(addMonths(currentMonth, 1))}
            className="p-1.5 text-gray-500 hover:text-gray-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="bg-white px-3 py-2">
        {/* Weekday headers */}
        <div className="grid grid-cols-7 mb-1">
          {weekdays.map((d, i) => {
            const isWeekendCol = i >= 5;
            return (
              <div
                key={d}
                style={isWeekendCol ? { backgroundColor: "#fafafa" } : undefined}
                className="text-center text-[10px] font-medium text-gray-400 py-1 rounded"
              >
                {d}
              </div>
            );
          })}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {days.map((day) => {
            const key = format(day, "yyyy-MM-dd");
            const dayBookings = bookingsByDay[key] || [];
            const isCurrentMonth = isSameMonth(day, currentMonth);
            const isToday = isSameDay(day, today);
            const isRangeStart = !!previewStart && isSameDay(day, previewStart);
            const isRangeEnd = !!previewEnd && isSameDay(day, previewEnd);
            const isWithinRange =
              !!previewStart && !!previewEnd && day >= previewStart && day <= previewEnd;
            const isMiddle = isWithinRange && !isRangeStart && !isRangeEnd;
            const isEndpoint = isRangeStart || isRangeEnd;
            const dow = day.getDay();
            const isWeekend = dow === 0 || dow === 6;
            const hasBookings = dayBookings.length > 0;
            const hasBlocks = (blocksByDay[key] || []).length > 0;

            // Get unique channel colors for dots
            const channels = Array.from(new Set(dayBookings.map((b) => b.channel)));

            const cellBgStyle =
              !isWithinRange && !isToday && isWeekend ? { backgroundColor: "#fafafa" } : undefined;

            // Range visual: rounded pill ends + flat middle, with the same
            // primary fill on endpoints and a lighter tint inside the range.
            // Single-day selection keeps the original rounded pill look.
            let rangeClass = "";
            if (isRangeStart && isRangeEnd) {
              rangeClass = "bg-primary-500 text-white rounded-xl";
            } else if (isRangeStart) {
              rangeClass = "bg-primary-500 text-white rounded-l-xl";
            } else if (isRangeEnd) {
              rangeClass = "bg-primary-500 text-white rounded-r-xl";
            } else if (isMiddle) {
              rangeClass = "bg-primary-100 text-primary-700";
            } else if (isCurrentMonth) {
              rangeClass = "text-gray-900 rounded-xl";
            } else {
              rangeClass = "text-gray-300 rounded-xl";
            }

            return (
              <button
                key={key}
                data-day={key}
                onPointerDown={(e) => handleDayPointerDown(e, day)}
                style={{ ...cellBgStyle, touchAction: "none" }}
                className={`relative flex flex-col items-center py-1.5 transition-colors select-none ${rangeClass}`}
              >
                {isToday && !isWithinRange ? (
                  <span
                    style={{ backgroundColor: "#2563eb" }}
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[13px] font-bold text-white"
                  >
                    {format(day, "d")}
                  </span>
                ) : (
                  <span className={`text-[13px] font-medium ${isEndpoint ? "font-bold" : ""}`}>
                    {format(day, "d")}
                  </span>
                )}
                {dayPrices[key] && (
                  <span
                    data-price
                    className={`mt-0.5 text-[9px] leading-none tabular-nums ${
                      isEndpoint
                        ? "text-white/90"
                        : isMiddle
                          ? "text-primary-700"
                          : isCurrentMonth
                            ? "text-gray-500"
                            : "text-gray-300"
                    }`}
                  >
                    {dayPrices[key]}
                  </span>
                )}
                {/* Booking dots (channel-colored) + a red dot when the day is blocked */}
                {(hasBookings || hasBlocks) && (
                  <div className="flex gap-0.5 mt-0.5">
                    {channels.slice(0, 3).map((ch) => (
                      <div
                        key={ch}
                        className={`w-1 h-1 rounded-full ${isEndpoint ? "bg-white/60" : getChannelBarColor(ch)}`}
                      />
                    ))}
                    {hasBlocks && (
                      <div
                        className={`w-1 h-1 rounded-full ${isEndpoint ? "bg-white/60" : "bg-red-500"}`}
                      />
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-center text-[10px] text-gray-400">
          {drag?.moved
            ? t("calendar.mobile.releaseRange")
            : isRangeSelection
              ? t("calendar.mobile.changeRange")
              : t("calendar.mobile.selectRange")}
        </p>
      </div>

      {/* Selected day / range bookings */}
      <div className="flex-1 bg-gray-50 overflow-auto">
        <div className="px-3 py-2">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="min-w-0 flex-1">
              <h3 className="text-[12px] font-semibold text-gray-700 truncate">
                {!headerStart || !headerEnd
                  ? t("calendar.selectDay")
                  : isRangeSelection
                    ? `${headerStart.toLocaleDateString(locale, {
                        month: "short",
                        day: "numeric",
                      })} – ${headerEnd.toLocaleDateString(locale, {
                        month: "short",
                        day: "numeric",
                      })} · ${nights} ${t(nights === 1 ? "common.night" : "common.nights")}`
                    : headerStart.toLocaleDateString(locale, {
                        weekday: "long",
                        month: "short",
                        day: "numeric",
                      })}
              </h3>
              {isRangeSelection && (
                <button
                  onClick={clearRange}
                  className="text-[10px] text-gray-400 hover:text-gray-600 underline"
                >
                  {t("calendar.mobile.clearRange")}
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {rangeStartStr && rangeEndStr && (
                <button
                  type="button"
                  onClick={() => onBlockRoom(rangeStartStr, rangeEndStr)}
                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-red-600 border border-red-200 bg-white rounded-lg hover:bg-red-50 transition-colors disabled:cursor-not-allowed disabled:text-gray-400 disabled:border-gray-200"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                    />
                  </svg>
                  {t("calendar.mobile.block")}
                </button>
              )}
              <button
                type="button"
                disabled={!manualBookingAvailable}
                title={!manualBookingAvailable ? t("calendar.manualBookingUnavailable") : undefined}
                onClick={() => onNewBooking(rangeStartStr ?? undefined, rangeEndStr ?? undefined)}
                className="px-2.5 py-1 text-[11px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {t("calendar.newShort")}
              </button>
            </div>
          </div>

          {loading ? (
            <div
              className="bg-white rounded-lg border border-gray-200 p-6 text-center"
              aria-live="polite"
            >
              <p className="text-[12px] text-gray-400">{t("calendar.mobile.loading")}</p>
            </div>
          ) : loadError ? (
            <div className="bg-white rounded-lg border border-red-200 p-6 text-center" role="alert">
              <p className="text-[12px] text-red-600">{t("calendar.mobile.loadError")}</p>
            </div>
          ) : roomGroups.length === 0 && unassignedHere.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
              <p className="text-[12px] text-gray-400">
                {isRangeSelection ? t("calendar.mobile.emptyRange") : t("calendar.mobile.emptyDay")}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {roomGroups.map((group) => (
                <section key={group.roomTypeId} className="space-y-1.5">
                  <h4 className="px-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                    {group.name}
                  </h4>
                  {group.rooms.map(({ room, bookings: held, blocks: closed }) => {
                    const label = `#${room.roomNumber}`;
                    if (held.length === 0 && closed.length === 0) {
                      const price = freePrice(room.roomTypeId);
                      return (
                        <button
                          key={room.id}
                          type="button"
                          onClick={() =>
                            listStart && listEnd && onSelectRoom(room, listStart, listEnd)
                          }
                          className={`${ROW_CLASS} border-gray-200 bg-white hover:border-gray-300`}
                        >
                          <span
                            aria-hidden="true"
                            className="w-1 self-stretch rounded-full bg-green-500"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-semibold text-gray-900">
                              {label}
                            </span>
                            <span className="block text-[11px] font-medium text-green-700">
                              {t("calendar.popover.available")}
                            </span>
                          </span>
                          {price && currency && (
                            <span className="shrink-0 text-right">
                              <span className="block text-[13px] font-semibold tabular-nums text-gray-900">
                                {money(price, currency)}
                              </span>
                              <span className="block text-[10px] text-gray-500">
                                {nightKeys.length === 1
                                  ? t("calendar.mobile.perNight")
                                  : t("calendar.popover.total")}
                              </span>
                            </span>
                          )}
                          {CHEVRON}
                        </button>
                      );
                    }
                    return (
                      <div key={room.id} className="space-y-1.5">
                        {closed.map((bl) => (
                          <button
                            key={`block-${bl.id}`}
                            type="button"
                            onClick={() => onSelectBlock(bl)}
                            className={`${ROW_CLASS} border-dashed ${
                              bl.protected
                                ? "border-gray-300 bg-white hover:bg-gray-50"
                                : "border-red-200 bg-red-50 hover:bg-red-100"
                            }`}
                          >
                            <span
                              aria-hidden="true"
                              className={`w-1 self-stretch rounded-full ${bl.protected ? "bg-gray-400" : "bg-red-500"}`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-semibold text-gray-900">
                                {label}
                              </span>
                              <span
                                className={`block truncate text-[11px] ${bl.protected ? "text-gray-600" : "text-red-700"}`}
                              >
                                {bl.protected
                                  ? bl.sourceSummary || t("rooms.linkedInventory")
                                  : bl.reason || t("calendar.blocked")}
                              </span>
                            </span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                bl.protected
                                  ? "bg-gray-100 text-gray-700"
                                  : "bg-red-100 text-red-700"
                              }`}
                            >
                              {bl.protected ? t("rooms.linked") : t("calendar.blocked")}
                            </span>
                            {CHEVRON}
                          </button>
                        ))}
                        {held.map((b) => (
                          <BookingRow
                            key={`${b.id}:${b.roomPosition}`}
                            booking={b}
                            title={label}
                            shortDay={shortDay}
                            onSelect={onSelectBooking}
                            hotelTimeZone={hotelTimeZone}
                          />
                        ))}
                      </div>
                    );
                  })}
                </section>
              ))}
              {unassignedHere.length > 0 && (
                <section className="space-y-1.5">
                  <h4 className="px-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                    {t("calendar.unassigned")}
                  </h4>
                  {unassignedHere.map((b) => (
                    <BookingRow
                      key={`${b.id}:${b.roomPosition}`}
                      booking={b}
                      title={b.roomName}
                      shortDay={shortDay}
                      onSelect={onSelectBooking}
                      hotelTimeZone={hotelTimeZone}
                    />
                  ))}
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const ROW_CLASS =
  "w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors";

const CHEVRON = (
  <svg
    aria-hidden="true"
    className="w-4 h-4 shrink-0 text-gray-300"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
  </svg>
);

/** A booking in the phone's room list: the room (or room type while unassigned), the guest and the stay. */
function BookingRow({
  booking: b,
  title,
  shortDay,
  onSelect,
  hotelTimeZone,
}: {
  booking: CalendarBooking;
  title: string;
  shortDay: (date: string) => string;
  onSelect: (booking: CalendarBooking) => void;
  hotelTimeZone: string | null;
}) {
  const { locale, t } = useTranslation();
  // VAY-2348: held for a bank transfer: amber, with the payment deadline.
  const awaiting = b.status === "awaiting_payment";
  return (
    <button
      type="button"
      onClick={() => onSelect(b)}
      className={`${ROW_CLASS} ${
        awaiting
          ? "border-amber-200 bg-amber-50 hover:border-amber-300"
          : "border-gray-200 bg-white hover:border-gray-300"
      }`}
    >
      <span
        aria-hidden="true"
        className={`w-1 self-stretch rounded-full ${awaiting ? "bg-amber-600" : getChannelBarColor(b.channel)}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-gray-900">{title}</span>
        <span className="block truncate text-[11px] text-gray-600">
          {`${b.guestFirstName} ${b.guestLastName}`.trim()} · {shortDay(b.checkIn)} →{" "}
          {shortDay(b.checkOut)}
        </span>
        {awaiting && b.paymentDeadlineAt && (
          <span className="block text-[11px] font-semibold text-amber-800">
            {t("bookings.payBy", {
              date: formatPaymentDeadline(b.paymentDeadlineAt, locale, hotelTimeZone),
            })}
          </span>
        )}
      </span>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
          awaiting ? `border ${AWAITING_PAYMENT_BADGE_CLASS}` : "bg-primary-50 text-primary-700"
        }`}
      >
        {awaiting ? t("bookings.statusAwaitingPayment") : t("calendar.mobile.booked")}
      </span>
      {CHEVRON}
    </button>
  );
}
