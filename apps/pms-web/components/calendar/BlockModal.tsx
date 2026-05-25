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
      setError("Please select at least one room to block");
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

  const inputCls =
    "w-full h-11 px-3 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent";
  const labelCls = "block text-xs font-semibold text-gray-700 mb-1.5";

  return (
    <Modal
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-11 px-4 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="block-rooms-form"
            disabled={submitting || selectedRoomIds.length === 0}
            className={`h-11 px-4 text-sm font-semibold text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              confirmOverlap && overlappingBookings.length > 0
                ? "bg-amber-600 hover:bg-amber-700"
                : "bg-primary-600 hover:bg-primary-700"
            }`}
          >
            {submitting
              ? "Blocking…"
              : confirmOverlap && overlappingBookings.length > 0
                ? "Block anyway"
                : selectedRoomIds.length > 1
                  ? `Block ${selectedRoomIds.length} rooms`
                  : "Block room"}
          </button>
        </div>
      }
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-red-50 text-red-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728A9 9 0 015.636 5.636"
                />
              </svg>
            </span>
            <h2 className="text-lg font-bold text-gray-900 truncate">Block Rooms</h2>
          </div>
          <p className="text-xs text-gray-500">
            Make rooms unavailable for new bookings — for maintenance, owner stays, or holds.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 -mt-1 -mr-1 w-9 h-9 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 flex items-center justify-center transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <form id="block-rooms-form" onSubmit={handleSubmit} className="space-y-5">
        {/* Section: Dates */}
        <section>
          <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Dates
          </h3>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className={labelCls}>Start</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => handleStartDateChange(e.target.value)}
                className={inputCls}
                required
              />
            </div>
            <div>
              <label className={labelCls}>End</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={inputCls}
                required
              />
            </div>
          </div>
          {nights > 0 && (
            <p className="text-xs text-gray-500 mt-2">
              {nights} night{nights !== 1 ? "s" : ""} blocked
            </p>
          )}
        </section>

        {/* Section: Rooms */}
        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
              Rooms
            </h3>
            <span className="text-xs text-gray-500">
              {selectedRoomIds.length} of {roomsForType.length} selected
            </span>
          </div>

          <div className="mb-2">
            <label className={labelCls}>Room Type</label>
            <select
              value={roomTypeId}
              onChange={(e) => handleRoomTypeChange(e.target.value)}
              className={inputCls}
            >
              {roomTypes.map((rt) => (
                <option key={rt.id} value={rt.id}>
                  {rt.name} ({rt.totalRooms} rooms)
                </option>
              ))}
            </select>
          </div>

          {roomsForType.length === 0 ? (
            <p className="text-xs text-gray-500 px-3 py-3 bg-gray-50 border border-dashed border-gray-200 rounded-lg text-center">
              No rooms configured for this room type.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between mb-1.5">
                <label className={`${labelCls} mb-0`}>Rooms to block</label>
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs font-semibold text-primary-600 hover:text-primary-700 px-2 py-1 -mr-2 rounded hover:bg-primary-50 transition-colors"
                >
                  {allSelected ? "Clear all" : "Select all"}
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-56 overflow-y-auto -mx-1 px-1 py-1">
                {roomsForType.map((r) => {
                  const checked = selectedRoomIds.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => toggleRoom(r.id)}
                      aria-pressed={checked}
                      className={`relative min-h-[44px] flex flex-col items-start justify-center px-3 py-2 rounded-lg border-2 text-left transition-all ${
                        checked
                          ? "bg-primary-50 border-primary-500 shadow-sm"
                          : "bg-white border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      <span
                        className={`text-sm font-semibold leading-tight ${
                          checked ? "text-primary-900" : "text-gray-900"
                        }`}
                      >
                        #{r.roomNumber}
                      </span>
                      {r.floor && (
                        <span
                          className={`text-[11px] leading-tight ${
                            checked ? "text-primary-700" : "text-gray-500"
                          }`}
                        >
                          Floor {r.floor}
                        </span>
                      )}
                      {checked && (
                        <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-primary-600 text-white flex items-center justify-center">
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={3}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {/* Section: Reason */}
        <section>
          <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Reason <span className="text-gray-400 font-normal normal-case tracking-normal">(optional)</span>
          </h3>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Maintenance, Renovation, Owner stay"
            className={inputCls}
          />
        </section>

        {error && (
          <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg">
            <svg
              className="w-4 h-4 text-red-500 shrink-0 mt-0.5"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {confirmOverlap && overlappingBookings.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-amber-100/70 border-b border-amber-200">
              <svg
                className="w-4 h-4 text-amber-600 shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
              <p className="text-sm font-semibold text-amber-900">
                Overlaps {overlappingBookings.length} existing booking
                {overlappingBookings.length !== 1 ? "s" : ""}
              </p>
            </div>
            <ul className="divide-y divide-amber-200">
              {overlappingBookings.slice(0, 5).map((b) => (
                <li
                  key={`${b.id}-${b.roomId}`}
                  className="px-3 py-2 text-xs text-amber-900 flex items-center justify-between gap-2"
                >
                  <span className="truncate font-medium">
                    {b.guestFirstName} {b.guestLastName}
                    {b.roomNumber ? ` · #${b.roomNumber}` : ""}
                  </span>
                  <span className="shrink-0 text-amber-700 tabular-nums">
                    {b.checkIn} → {b.checkOut}
                  </span>
                </li>
              ))}
              {overlappingBookings.length > 5 && (
                <li className="px-3 py-1.5 text-xs text-amber-700 italic">
                  +{overlappingBookings.length - 5} more
                </li>
              )}
            </ul>
            <p className="px-3 py-2 text-xs text-amber-800 border-t border-amber-200 bg-amber-100/40">
              Press <span className="font-semibold">Block anyway</span> to override.
            </p>
          </div>
        )}
      </form>
    </Modal>
  );
}
