"use client";

import { useState, useMemo } from "react";
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
import { CalendarBooking, CalendarBlock, CalendarRoomType } from "@/services/calendar";
import { getChannelBarColor } from "@/lib/constants/statusStyles";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

interface MobileCalendarProps {
  bookings: CalendarBooking[];
  blocks: CalendarBlock[];
  roomTypes: CalendarRoomType[];
  onSelectBooking: (id: string) => void;
  onNewBooking: () => void;
  onBlockRoom: (selectedDate: string) => void;
  onSelectBlock: (block: CalendarBlock) => void;
}

export default function MobileCalendar({
  bookings,
  blocks,
  roomTypes,
  onSelectBooking,
  onNewBooking,
  onBlockRoom,
  onSelectBlock,
}: MobileCalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });

  // Build array of calendar days
  const days = useMemo(() => {
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
          if (!map[key].find((x) => x.id === b.id)) {
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

  const selectedDayBookings = useMemo(() => {
    if (!selectedDate) return [];
    return bookingsByDay[format(selectedDate, "yyyy-MM-dd")] || [];
  }, [selectedDate, bookingsByDay]);

  const selectedDayBlocks = useMemo(() => {
    if (!selectedDate) return [];
    return blocksByDay[format(selectedDate, "yyyy-MM-dd")] || [];
  }, [selectedDate, blocksByDay]);

  const today = new Date();

  return (
    <div className="flex flex-col h-full">
      {/* Month header */}
      <div className="bg-white border-b border-gray-200 px-4 pt-3 pb-2">
        <div className="text-center text-[11px] text-gray-400 mb-1">
          {format(currentMonth, "yyyy")}
        </div>
        <div className="flex items-center justify-between">
          <button
            onClick={() => setCurrentMonth((m) => addMonths(m, -1))}
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
          <h2 className="text-[15px] font-bold text-gray-900">{format(currentMonth, "MMMM")}</h2>
          <button
            onClick={() => setCurrentMonth((m) => addMonths(m, 1))}
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
          {WEEKDAYS.map((d, i) => {
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
            const isSelected = selectedDate && isSameDay(day, selectedDate);
            const dow = day.getDay();
            const isWeekend = dow === 0 || dow === 6;
            const hasBookings = dayBookings.length > 0;
            const hasBlocks = (blocksByDay[key] || []).length > 0;

            // Get unique channel colors for dots
            const channels = Array.from(new Set(dayBookings.map((b) => b.channel)));

            const cellBgStyle =
              !isSelected && !isToday && isWeekend ? { backgroundColor: "#fafafa" } : undefined;

            return (
              <button
                key={key}
                onClick={() => setSelectedDate(day)}
                style={cellBgStyle}
                className={`relative flex flex-col items-center py-1.5 rounded-xl transition-colors ${
                  isSelected
                    ? "bg-primary-500 text-white"
                    : isCurrentMonth
                      ? "text-gray-900"
                      : "text-gray-300"
                }`}
              >
                {isToday && !isSelected ? (
                  <span
                    style={{ backgroundColor: "#2563eb" }}
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[13px] font-bold text-white"
                  >
                    {format(day, "d")}
                  </span>
                ) : (
                  <span className={`text-[13px] font-medium ${isSelected ? "font-bold" : ""}`}>
                    {format(day, "d")}
                  </span>
                )}
                {/* Booking dots (channel-colored) + a red dot when the day is blocked */}
                {(hasBookings || hasBlocks) && (
                  <div className="flex gap-0.5 mt-0.5">
                    {channels.slice(0, 3).map((ch) => (
                      <div
                        key={ch}
                        className={`w-1 h-1 rounded-full ${isSelected ? "bg-white/60" : getChannelBarColor(ch)}`}
                      />
                    ))}
                    {hasBlocks && (
                      <div
                        className={`w-1 h-1 rounded-full ${isSelected ? "bg-white/60" : "bg-red-500"}`}
                      />
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected day bookings */}
      <div className="flex-1 bg-gray-50 overflow-auto">
        <div className="px-3 py-2">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[12px] font-semibold text-gray-700">
              {selectedDate ? format(selectedDate, "EEEE, MMM d") : "Select a day"}
            </h3>
            <div className="flex items-center gap-1.5">
              {selectedDate && (
                <button
                  onClick={() => onBlockRoom(format(selectedDate, "yyyy-MM-dd"))}
                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-red-600 border border-red-200 bg-white rounded-lg hover:bg-red-50 transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                    />
                  </svg>
                  Block
                </button>
              )}
              <button
                onClick={onNewBooking}
                className="px-2.5 py-1 text-[11px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
              >
                + New
              </button>
            </div>
          </div>

          {selectedDayBookings.length === 0 && selectedDayBlocks.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
              <p className="text-[12px] text-gray-400">No bookings or blocks on this day</p>
            </div>
          ) : (
            <div className="space-y-2">
              {selectedDayBlocks.map((bl) => {
                const rt = roomTypes.find((r) => r.id === bl.roomTypeId);
                return (
                  <button
                    key={`block-${bl.id}`}
                    onClick={() => onSelectBlock(bl)}
                    className="w-full bg-red-50 rounded-lg border border-dashed border-red-200 p-3 text-left hover:bg-red-100 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-red-100 text-red-600 flex items-center justify-center shrink-0">
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                          />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold text-red-700 truncate">
                          {bl.reason || "Blocked"}
                        </div>
                        <div className="text-[11px] text-red-500">
                          {bl.startDate} → {bl.endDate}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="inline-flex px-1.5 py-0.5 rounded text-[9px] font-medium bg-red-100 text-red-700">
                          Blocked
                        </span>
                        <div className="text-[10px] text-red-400 mt-0.5 truncate max-w-[90px]">
                          {bl.roomId ? `#${bl.roomNumber ?? ""}` : rt?.name || ""}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
              {selectedDayBookings.map((b) => {
                const channelColor = getChannelBarColor(b.channel);
                return (
                  <button
                    key={b.id}
                    onClick={() => onSelectBooking(b.id)}
                    className="w-full bg-white rounded-lg border border-gray-200 p-3 text-left hover:border-gray-300 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`w-8 h-8 rounded-full ${channelColor} flex items-center justify-center text-white text-[10px] font-bold shrink-0`}
                      >
                        {b.guestFirstName.charAt(0)}
                        {b.guestLastName.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold text-gray-900 truncate">
                          {b.guestFirstName} {b.guestLastName}
                        </div>
                        <div className="text-[11px] text-gray-500">
                          {b.checkIn} → {b.checkOut}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span
                          className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-medium ${
                            b.status === "confirmed"
                              ? "bg-green-100 text-green-700"
                              : b.status === "pending"
                                ? "bg-yellow-100 text-yellow-700"
                                : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {b.status}
                        </span>
                        <div className="text-[10px] text-gray-400 mt-0.5 capitalize">
                          {b.channel}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
