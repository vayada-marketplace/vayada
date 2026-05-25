"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarBooking, CalendarRoom, CalendarRoomType } from "@/services/calendar";
import Modal from "@/components/Modal";

// Returns the YYYY-MM-DD string one day after the given YYYY-MM-DD string.
// Parsed as local date so DST / timezone doesn't shift the result.
function addOneDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return "";
  const next = new Date(y, m - 1, d + 1);
  const yyyy = next.getFullYear();
  const mm = String(next.getMonth() + 1).padStart(2, "0");
  const dd = String(next.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nightsBetween(start: string, end: string): number {
  if (!start || !end || end <= start) return 0;
  const [ys, ms, ds] = start.split("-").map(Number);
  const [ye, me, de] = end.split("-").map(Number);
  if (!ys || !ms || !ds || !ye || !me || !de) return 0;
  const a = new Date(ys, ms - 1, ds).getTime();
  const b = new Date(ye, me - 1, de).getTime();
  return Math.round((b - a) / 86_400_000);
}

const MONTHS_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function parseLocalDate(iso: string): { day: string; month: string; year: string } | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return {
    day: String(d).padStart(2, "0"),
    month: MONTHS_SHORT[m - 1] ?? "",
    year: String(y),
  };
}

interface BlockModalProps {
  roomTypes: CalendarRoomType[];
  rooms: CalendarRoom[];
  bookings: CalendarBooking[];
  onSubmit: (data: {
    roomTypeId: string;
    roomIds: string[];
    startDate: string;
    endDate: string;
    reason: string;
  }) => Promise<void>;
  onClose: () => void;
  initialRoomTypeId?: string;
  initialRoomId?: string;
  initialStartDate?: string;
  initialEndDate?: string;
}

export default function BlockModal({
  roomTypes,
  rooms,
  bookings,
  onSubmit,
  onClose,
  initialRoomTypeId,
  initialRoomId,
  initialStartDate,
  initialEndDate,
}: BlockModalProps) {
  const [roomTypeId, setRoomTypeId] = useState(initialRoomTypeId || roomTypes[0]?.id || "");
  const [startDate, setStartDate] = useState(initialStartDate || "");
  const [endDate, setEndDate] = useState(initialEndDate || "");
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>(
    initialRoomId ? [initialRoomId] : [],
  );
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [confirmOverlap, setConfirmOverlap] = useState(false);

  const roomsForType = useMemo(
    () => rooms.filter((r) => r.roomTypeId === roomTypeId),
    [rooms, roomTypeId],
  );

  // Bookings assigned to a selected room whose stay overlaps the block range.
  // Both ranges are half-open [start, end): they overlap iff start < otherEnd
  // && otherStart < end. ISO YYYY-MM-DD strings compare correctly as strings.
  const overlappingBookings = useMemo(() => {
    if (!startDate || !endDate || selectedRoomIds.length === 0) return [];
    return bookings.filter(
      (b) =>
        b.roomId != null &&
        selectedRoomIds.includes(b.roomId) &&
        b.checkIn < endDate &&
        b.checkOut > startDate,
    );
  }, [bookings, startDate, endDate, selectedRoomIds]);

  // Re-arm the warning whenever the range or room selection changes, so a user
  // who edits the dates after seeing it can't skip a fresh overlap.
  useEffect(() => {
    setConfirmOverlap(false);
  }, [startDate, endDate, selectedRoomIds]);

  const allSelected = roomsForType.length > 0 && selectedRoomIds.length === roomsForType.length;
  const nights = nightsBetween(startDate, endDate);
  const roomNights = nights * selectedRoomIds.length;

  const toggleRoom = (id: string) => {
    setSelectedRoomIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleAll = () => {
    setSelectedRoomIds(allSelected ? [] : roomsForType.map((r) => r.id));
  };

  const handleRoomTypeChange = (newId: string) => {
    setRoomTypeId(newId);
    setSelectedRoomIds([]);
  };

  const handleStartDateChange = (newStart: string) => {
    setStartDate(newStart);
    if (newStart && (!endDate || endDate <= newStart)) {
      setEndDate(addOneDay(newStart));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!startDate || !endDate) {
      setError("Please select both start and end dates");
      return;
    }
    if (endDate <= startDate) {
      setError("End date must be after start date");
      return;
    }
    if (selectedRoomIds.length === 0) {
      setError("Please select at least one room to hold");
      return;
    }
    // Don't silently block over a booking — make the user confirm once.
    if (overlappingBookings.length > 0 && !confirmOverlap) {
      setConfirmOverlap(true);
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({ roomTypeId, roomIds: selectedRoomIds, startDate, endDate, reason });
    } catch (err: any) {
      setError(err?.message || "Failed to create block");
    } finally {
      setSubmitting(false);
    }
  };

  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  const overrideMode = confirmOverlap && overlappingBookings.length > 0;

  return (
    <Modal
      onClose={onClose}
      bleedBody
      bleedFooter
      footer={
        <div className="px-5 sm:px-8 py-4 bg-ivory bg-grain border-t border-hairline">
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[10px] font-medium tracking-[0.18em] uppercase text-ash mb-0.5">
                Total hold
              </div>
              {nights > 0 && selectedRoomIds.length > 0 ? (
                <div className="numerals text-ink leading-none">
                  <span className="font-display text-[28px] sm:text-[32px] leading-none">
                    {roomNights}
                  </span>
                  <span className="ml-1.5 text-[11px] uppercase tracking-[0.16em] text-ash">
                    room-night{roomNights !== 1 ? "s" : ""}
                  </span>
                </div>
              ) : (
                <div className="font-display italic text-ash text-[15px] leading-none">
                  Awaiting dates &amp; rooms
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="h-11 px-4 text-[13px] font-medium text-ash hover:text-ink transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                form="block-rooms-form"
                disabled={submitting || selectedRoomIds.length === 0}
                className={`h-11 px-5 text-[13px] font-semibold uppercase tracking-[0.14em] rounded-[2px] border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  overrideMode
                    ? "bg-clay text-ivory border-clay hover:bg-[#9d3a23]"
                    : "bg-ink text-ivory border-ink hover:bg-[#2a2520]"
                }`}
              >
                {submitting ? "Holding…" : overrideMode ? "Override & hold" : "Hold rooms"}
              </button>
            </div>
          </div>
        </div>
      }
    >
      {/* Bone surface fills the entire body region. */}
      <form
        id="block-rooms-form"
        onSubmit={handleSubmit}
        className="bg-bone bg-grain font-sans text-ink min-h-full"
      >
        {/* Close — sits in the bleed area, intentionally small. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 w-9 h-9 rounded-full text-ash hover:text-ink hover:bg-hairline/50 flex items-center justify-center transition-colors z-10"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>

        <div className="px-6 sm:px-8 pt-9 pb-7">
          {/* Eyebrow + step indicator */}
          <div className="flex items-baseline justify-between mb-5">
            <div className="text-[10px] font-medium tracking-[0.22em] uppercase text-clay">
              Stay hold
            </div>
            <div className="text-[10px] tracking-[0.18em] uppercase text-ash numerals">
              File · {new Date().toISOString().slice(0, 10)}
            </div>
          </div>

          {/* Display headline */}
          <h2 className="font-display text-[36px] sm:text-[44px] leading-[0.95] tracking-[-0.01em] text-ink">
            Hold these rooms
          </h2>
          <p className="font-display italic text-[16px] text-ash mt-1.5 leading-snug">
            off the booking calendar.
          </p>

          {/* Section 01 — Period */}
          <Section index="01" label="Period" />
          <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-3 sm:gap-4">
            <DateField
              label="From"
              value={startDate}
              parsed={start}
              onChange={handleStartDateChange}
            />
            <div className="flex flex-col items-center justify-center px-1 pt-5">
              <div className="text-[10px] tracking-[0.2em] uppercase text-ash numerals mb-1">
                {nights > 0 ? `${nights} ${nights === 1 ? "nt" : "nts"}` : "—"}
              </div>
              <svg
                className="w-12 sm:w-16 text-hairline"
                viewBox="0 0 80 8"
                fill="none"
                stroke="currentColor"
              >
                <path d="M0 4h70" strokeWidth={1} />
                <path d="M64 1l6 3-6 3" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <DateField
              label="To"
              value={endDate}
              parsed={end}
              onChange={setEndDate}
            />
          </div>

          {/* Section 02 — Rooms */}
          <Section
            index="02"
            label="Rooms"
            meta={
              roomsForType.length > 0 ? (
                <span className="numerals">
                  <span className="text-ink font-medium">{selectedRoomIds.length}</span>
                  <span className="text-ash"> of {roomsForType.length}</span>
                </span>
              ) : null
            }
          />

          <div className="mb-4">
            <FieldLabel>Room type</FieldLabel>
            <div className="relative">
              <select
                value={roomTypeId}
                onChange={(e) => handleRoomTypeChange(e.target.value)}
                className="w-full h-11 pl-0 pr-8 appearance-none bg-transparent border-0 border-b border-ink/80 text-[15px] text-ink focus:outline-none focus:border-clay transition-colors font-medium"
              >
                {roomTypes.map((rt) => (
                  <option key={rt.id} value={rt.id}>
                    {rt.name} · {rt.totalRooms} rooms
                  </option>
                ))}
              </select>
              <svg
                className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3 text-ash pointer-events-none"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path d="M2 4l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>

          {roomsForType.length === 0 ? (
            <p className="font-display italic text-[14px] text-ash py-6 text-center border-y border-hairline">
              No rooms configured for this room type.
            </p>
          ) : (
            <>
              <div className="flex items-baseline justify-between mb-2.5">
                <FieldLabel className="mb-0">Select rooms to hold</FieldLabel>
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-[10px] font-semibold tracking-[0.16em] uppercase text-ink hover:text-clay transition-colors underline-offset-4 hover:underline"
                >
                  {allSelected ? "Clear" : "Select all"}
                </button>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-px bg-hairline border border-hairline max-h-[260px] overflow-y-auto">
                {roomsForType.map((r) => {
                  const checked = selectedRoomIds.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => toggleRoom(r.id)}
                      aria-pressed={checked}
                      className={`relative min-h-[68px] flex flex-col items-start justify-center px-3 py-2 text-left transition-colors ${
                        checked
                          ? "bg-ink text-ivory bg-hatch-ink"
                          : "bg-ivory text-ink hover:bg-bone"
                      }`}
                    >
                      <span
                        className={`font-display text-[22px] leading-none numerals ${
                          checked ? "text-ivory" : "text-ink"
                        }`}
                      >
                        {r.roomNumber}
                      </span>
                      <span
                        className={`text-[9px] tracking-[0.16em] uppercase mt-1 numerals ${
                          checked ? "text-ivory/70" : "text-ash"
                        }`}
                      >
                        {r.floor ? `FL ${r.floor}` : "Room"}
                      </span>
                      {checked && (
                        <span className="absolute top-1.5 right-2 text-[9px] tracking-[0.18em] uppercase text-ivory/80">
                          Held
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* Section 03 — Reason */}
          <Section
            index="03"
            label="Reason"
            meta={<span className="text-ash">optional</span>}
          />
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Maintenance · Renovation · Owner stay"
            className="w-full h-11 px-0 bg-transparent border-0 border-b border-ink/80 text-[15px] text-ink placeholder:text-ash/60 placeholder:font-display placeholder:italic focus:outline-none focus:border-clay transition-colors"
          />

          {/* Inline messages */}
          {error && (
            <div className="mt-6 flex items-baseline gap-3 border-l-2 border-clay pl-3 py-1">
              <span className="text-[10px] tracking-[0.18em] uppercase text-clay font-semibold">
                Err
              </span>
              <p className="text-[13px] text-ink leading-snug">{error}</p>
            </div>
          )}

          {overrideMode && (
            <div className="mt-6 border border-hairline bg-clay/[0.04] bg-hatch-clay">
              <div className="flex items-baseline justify-between border-b border-hairline px-4 py-2.5">
                <div className="text-[10px] font-semibold tracking-[0.22em] uppercase text-clay">
                  Conflict
                </div>
                <div className="text-[11px] text-ash numerals">
                  {overlappingBookings.length} reservation
                  {overlappingBookings.length !== 1 ? "s" : ""}
                </div>
              </div>
              <ul className="divide-y divide-hairline">
                {overlappingBookings.slice(0, 5).map((b) => {
                  const ci = parseLocalDate(b.checkIn);
                  const co = parseLocalDate(b.checkOut);
                  return (
                    <li
                      key={`${b.id}-${b.roomId}`}
                      className="px-4 py-2.5 flex items-baseline justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="font-display text-[15px] text-ink truncate">
                          {b.guestFirstName} {b.guestLastName}
                        </div>
                        <div className="text-[10px] tracking-[0.16em] uppercase text-ash numerals">
                          {b.roomNumber ? `Room ${b.roomNumber}` : "Unassigned"}
                        </div>
                      </div>
                      <div className="text-[11px] text-ash numerals tabular-nums shrink-0 text-right">
                        {ci ? `${ci.day} ${ci.month}` : b.checkIn}
                        <span className="mx-1.5 text-hairline">→</span>
                        {co ? `${co.day} ${co.month}` : b.checkOut}
                      </div>
                    </li>
                  );
                })}
                {overlappingBookings.length > 5 && (
                  <li className="px-4 py-2 text-[11px] italic font-display text-ash">
                    +{overlappingBookings.length - 5} more
                  </li>
                )}
              </ul>
              <p className="px-4 py-2.5 text-[11px] text-ash border-t border-hairline">
                Hold will sit over these reservations. Press{" "}
                <span className="font-semibold text-clay">Override &amp; hold</span> to proceed.
              </p>
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}

/* ─────────────── Local primitives ─────────────── */

function Section({
  index,
  label,
  meta,
}: {
  index: string;
  label: string;
  meta?: React.ReactNode;
}) {
  return (
    <div className="mt-8 mb-4 first:mt-10">
      <div className="flex items-baseline gap-3">
        <span className="font-display text-[13px] numerals text-clay">{index}</span>
        <span className="text-[10px] font-semibold tracking-[0.24em] uppercase text-ink">
          {label}
        </span>
        <span className="flex-1 h-px bg-hairline translate-y-[-2px]" />
        {meta && <span className="text-[11px] text-ash">{meta}</span>}
      </div>
    </div>
  );
}

function FieldLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label
      className={`block text-[10px] font-medium tracking-[0.2em] uppercase text-ash mb-2 ${className}`}
    >
      {children}
    </label>
  );
}

/* A field that displays a date as a typographic block (large serif day,
   small caps month + year) while a transparent native <input type="date">
   sits stretched on top so click/tap still opens the OS date picker. */
function DateField({
  label,
  value,
  parsed,
  onChange,
}: {
  label: string;
  value: string;
  parsed: { day: string; month: string; year: string } | null;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="relative h-[88px] bg-ivory border border-ink/80 px-3.5 py-2.5 flex flex-col justify-between hover:border-clay focus-within:border-clay transition-colors">
        {parsed ? (
          <>
            <span className="font-display text-[44px] sm:text-[52px] leading-none numerals text-ink">
              {parsed.day}
            </span>
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] font-semibold tracking-[0.2em] uppercase text-ink numerals">
                {parsed.month}
              </span>
              <span className="text-[10px] tracking-[0.16em] uppercase text-ash numerals">
                {parsed.year}
              </span>
            </div>
          </>
        ) : (
          <>
            <span className="font-display italic text-[30px] sm:text-[36px] leading-none text-ash">
              Select
            </span>
            <span className="text-[10px] tracking-[0.2em] uppercase text-ash">Pick a date</span>
          </>
        )}
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="date-overlay"
          required
          aria-label={label}
        />
      </div>
    </div>
  );
}
