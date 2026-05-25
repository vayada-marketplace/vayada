"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarRoomType,
  CalendarRoom,
  CreateAdminBookingPayload,
  calendarService,
} from "@/services/calendar";
import { formatCurrency } from "@/lib/formatCurrency";
import Modal from "@/components/Modal";

interface NewBookingModalProps {
  roomTypes: CalendarRoomType[];
  rooms: CalendarRoom[];
  onSubmit: (data: CreateAdminBookingPayload) => Promise<void>;
  onClose: () => void;
  initialRoomId?: string;
  initialCheckIn?: string;
  initialCheckOut?: string;
  connectedChannelKeys?: Set<string> | null;
}

const CHANNELS = [
  { value: "direct", label: "Direct" },
  { value: "airbnb", label: "Airbnb" },
  { value: "booking.com", label: "Booking.com" },
  { value: "expedia", label: "Expedia" },
  { value: "other", label: "Other" },
];

// Direct and Other are always offered regardless of channel-manager state.
const ALWAYS_SHOWN_CHANNELS = new Set(["direct", "other"]);

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

export default function NewBookingModal({
  roomTypes,
  rooms,
  onSubmit,
  onClose,
  initialRoomId,
  initialCheckIn,
  initialCheckOut,
  connectedChannelKeys,
}: NewBookingModalProps) {
  const visibleChannels = connectedChannelKeys
    ? CHANNELS.filter(
        (ch) => ALWAYS_SHOWN_CHANNELS.has(ch.value) || connectedChannelKeys.has(ch.value),
      )
    : CHANNELS;
  const initialRoom = (initialRoomId && rooms.find((r) => r.id === initialRoomId)) || rooms[0];
  const [roomId, setRoomId] = useState(initialRoom?.id || "");
  const [checkIn, setCheckIn] = useState(initialCheckIn || "");
  const [checkOut, setCheckOut] = useState(initialCheckOut || "");
  const [guestFirstName, setGuestFirstName] = useState("");
  const [guestLastName, setGuestLastName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [nightlyRate, setNightlyRate] = useState<string>("");
  // Booking-engine-resolved rate for the current room + check-in. Drives the
  // pre-fill and the placeholder so the user sees the same price the guest
  // would have been quoted (seasons / daily overrides / weekend surcharge).
  const [resolvedRate, setResolvedRate] = useState<number | null>(null);
  // Once the user types in the rate field we stop overwriting it from the
  // backend so date/room changes don't clobber a deliberate edit.
  const userEditedRate = useRef(false);
  const [channel, setChannel] = useState("direct");
  const [specialRequests, setSpecialRequests] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const selectedRoom = rooms.find((r) => r.id === roomId);
  const selectedRoomType = roomTypes.find((rt) => rt.id === selectedRoom?.roomTypeId);

  // Fetch the booking-engine resolved rate whenever the room type or check-in
  // date changes. Falls back silently to the room type's baseRate on failure.
  useEffect(() => {
    if (!selectedRoomType?.id || !checkIn) return;
    let cancelled = false;
    calendarService
      .getResolvedRate(selectedRoomType.id, checkIn)
      .then((res) => {
        if (cancelled) return;
        setResolvedRate(res.nightlyRate);
        if (!userEditedRate.current) {
          setNightlyRate(String(res.nightlyRate));
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Fall back to baseRate so the field is still useful if the API fails.
        const fallback = selectedRoomType.baseRate;
        setResolvedRate(fallback);
        if (!userEditedRate.current) {
          setNightlyRate(String(fallback));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRoomType?.id, checkIn]);

  const handleRoomChange = (newRoomId: string) => {
    setRoomId(newRoomId);
  };

  const handleCheckInChange = (newCheckIn: string) => {
    setCheckIn(newCheckIn);
    if (newCheckIn && (!checkOut || checkOut <= newCheckIn)) {
      setCheckOut(addOneDay(newCheckIn));
    }
  };

  // Group rooms by room type for the dropdown
  const roomsByType: Record<string, CalendarRoom[]> = {};
  for (const r of rooms) {
    if (!roomsByType[r.roomTypeId]) roomsByType[r.roomTypeId] = [];
    roomsByType[r.roomTypeId].push(r);
  }

  const nights = nightsBetween(checkIn, checkOut);
  const totalGuests = adults + children;
  const overOccupancy =
    selectedRoomType != null && totalGuests > selectedRoomType.maxOccupancy;
  const rateNum = nightlyRate ? parseFloat(nightlyRate) : null;
  const total = useMemo(() => {
    if (!rateNum || nights === 0) return null;
    return rateNum * nights;
  }, [rateNum, nights]);
  const rateMatchesResolved =
    resolvedRate !== null && rateNum !== null && Math.abs(rateNum - resolvedRate) < 0.005;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!checkIn || !checkOut) {
      setError("Please select both check-in and check-out dates");
      return;
    }
    if (checkOut <= checkIn) {
      setError("Check-out must be after check-in");
      return;
    }
    if (!guestFirstName.trim() || !guestLastName.trim()) {
      setError("Guest first and last name are required");
      return;
    }
    if (!guestEmail.trim()) {
      setError("Guest email is required");
      return;
    }
    if (!roomId) {
      setError("Please select a room");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        roomId,
        guestFirstName: guestFirstName.trim(),
        guestLastName: guestLastName.trim(),
        guestEmail: guestEmail.trim(),
        guestPhone: guestPhone.trim(),
        specialRequests: specialRequests.trim(),
        checkIn,
        checkOut,
        adults,
        children,
        nightlyRate: nightlyRate ? parseFloat(nightlyRate) : null,
        channel,
      });
    } catch (err: any) {
      setError(err?.message || "Failed to create booking");
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    "w-full h-11 px-3 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent";
  const labelCls = "block text-xs font-semibold text-gray-700 mb-1.5";
  const sectionTitleCls =
    "text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2";
  const required = <span className="text-red-500 font-normal">*</span>;

  return (
    <Modal
      onClose={onClose}
      maxWidth="lg"
      footer={
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-xs text-gray-600">
            {total !== null && selectedRoomType ? (
              <>
                <span className="text-gray-500">Total</span>{" "}
                <span className="font-semibold text-gray-900 text-sm">
                  {formatCurrency(total, selectedRoomType.currency)}
                </span>
                <span className="text-gray-400">
                  {" · "}
                  {nights} night{nights !== 1 ? "s" : ""}
                </span>
              </>
            ) : (
              <span className="text-gray-400">Total appears once dates & rate are set</span>
            )}
          </div>
          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-11 px-4 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="new-booking-form"
              disabled={submitting}
              className="h-11 px-4 text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Creating…" : "Create Booking"}
            </button>
          </div>
        </div>
      }
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-primary-50 text-primary-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            </span>
            <h2 className="text-lg font-bold text-gray-900 truncate">New Booking</h2>
          </div>
          <p className="text-xs text-gray-500">
            Manually create a reservation — for walk-ins, phone bookings, or owner stays.
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

      <form id="new-booking-form" onSubmit={handleSubmit} className="space-y-6">
        {/* Section: Stay */}
        <section>
          <h3 className={sectionTitleCls}>Stay</h3>

          <div className="mb-3">
            <label className={labelCls}>Room {required}</label>
            <select
              value={roomId}
              onChange={(e) => handleRoomChange(e.target.value)}
              className={inputCls}
              required
            >
              {roomTypes.map((rt) => {
                const typeRooms = roomsByType[rt.id] || [];
                if (typeRooms.length === 0) return null;
                return (
                  <optgroup key={rt.id} label={rt.name}>
                    {typeRooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        #{r.roomNumber} — {rt.name}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            {selectedRoomType && (
              <p className="mt-1.5 text-xs text-gray-500">
                {selectedRoomType.name} · sleeps up to {selectedRoomType.maxOccupancy} ·{" "}
                {formatCurrency(selectedRoomType.baseRate, selectedRoomType.currency)}/night base
              </p>
            )}
          </div>

          {/* Dates with nights indicator wedged between */}
          <div className="grid grid-cols-[1fr_auto_1fr] sm:grid-cols-[1fr_auto_1fr] gap-2 items-end">
            <div>
              <label className={labelCls}>Check-in {required}</label>
              <input
                type="date"
                value={checkIn}
                onChange={(e) => handleCheckInChange(e.target.value)}
                className={inputCls}
                required
              />
            </div>
            <div className="pb-1 flex flex-col items-center justify-end">
              <div
                className={`mb-0.5 inline-flex items-center justify-center min-w-[44px] h-7 px-2 rounded-full text-[11px] font-semibold ${
                  nights > 0
                    ? "bg-primary-100 text-primary-700"
                    : "bg-gray-100 text-gray-400"
                }`}
              >
                {nights > 0 ? `${nights} ${nights === 1 ? "night" : "nights"}` : "—"}
              </div>
              <svg
                className="w-3 h-3 text-gray-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M14 5l7 7m0 0l-7 7m7-7H3"
                />
              </svg>
            </div>
            <div>
              <label className={labelCls}>Check-out {required}</label>
              <input
                type="date"
                value={checkOut}
                onChange={(e) => setCheckOut(e.target.value)}
                className={inputCls}
                required
              />
            </div>
          </div>
        </section>

        {/* Section: Guest */}
        <section>
          <h3 className={sectionTitleCls}>Guest</h3>

          <div className="grid grid-cols-2 gap-2.5 mb-2.5">
            <div>
              <label className={labelCls}>First name {required}</label>
              <input
                type="text"
                value={guestFirstName}
                onChange={(e) => setGuestFirstName(e.target.value)}
                className={inputCls}
                required
              />
            </div>
            <div>
              <label className={labelCls}>Last name {required}</label>
              <input
                type="text"
                value={guestLastName}
                onChange={(e) => setGuestLastName(e.target.value)}
                className={inputCls}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-2.5">
            <div>
              <label className={labelCls}>Email {required}</label>
              <input
                type="email"
                value={guestEmail}
                onChange={(e) => setGuestEmail(e.target.value)}
                className={inputCls}
                placeholder="guest@example.com"
                required
              />
            </div>
            <div>
              <label className={labelCls}>Phone</label>
              <input
                type="tel"
                value={guestPhone}
                onChange={(e) => setGuestPhone(e.target.value)}
                placeholder="+62 ..."
                className={inputCls}
              />
            </div>
          </div>

          {/* Occupancy as compact steppers */}
          <div className="grid grid-cols-2 gap-2.5">
            <Stepper
              label="Adults"
              value={adults}
              min={1}
              max={selectedRoomType?.maxOccupancy || 10}
              onChange={setAdults}
              over={overOccupancy}
            />
            <Stepper
              label="Children"
              value={children}
              min={0}
              max={10}
              onChange={setChildren}
              over={overOccupancy}
            />
          </div>

          {overOccupancy && selectedRoomType && (
            <div className="mt-2 flex items-start gap-2 px-2.5 py-2 bg-amber-50 border border-amber-200 rounded-lg">
              <svg
                className="w-4 h-4 text-amber-500 shrink-0 mt-0.5"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
              <p className="text-xs text-amber-800 leading-snug">
                Max occupancy is {selectedRoomType.maxOccupancy} for this room type — you have{" "}
                {totalGuests} guests selected.
              </p>
            </div>
          )}
        </section>

        {/* Section: Pricing */}
        <section>
          <h3 className={sectionTitleCls}>Pricing & channel</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label className={labelCls}>
                Nightly rate{selectedRoomType ? ` (${selectedRoomType.currency})` : ""}
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={nightlyRate}
                onChange={(e) => {
                  userEditedRate.current = true;
                  setNightlyRate(e.target.value);
                }}
                placeholder={
                  resolvedRate !== null
                    ? String(resolvedRate)
                    : selectedRoomType
                      ? String(selectedRoomType.baseRate)
                      : ""
                }
                className={inputCls}
              />
              {resolvedRate !== null && selectedRoomType ? (
                <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-gray-500">
                    Booking-engine rate:{" "}
                    <span className="font-semibold text-gray-700">
                      {formatCurrency(resolvedRate, selectedRoomType.currency)}
                    </span>
                  </span>
                  {!rateMatchesResolved && rateNum !== null && (
                    <button
                      type="button"
                      onClick={() => {
                        userEditedRate.current = false;
                        setNightlyRate(String(resolvedRate));
                      }}
                      className="font-semibold text-primary-600 hover:text-primary-700"
                    >
                      Reset
                    </button>
                  )}
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-gray-500">
                  Leave blank to use the room type default
                </p>
              )}
            </div>
            <div>
              <label className={labelCls}>Channel</label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                className={inputCls}
              >
                {visibleChannels.map((ch) => (
                  <option key={ch.value} value={ch.value}>
                    {ch.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* Section: Notes */}
        <section>
          <h3 className={sectionTitleCls}>
            Special requests{" "}
            <span className="text-gray-400 font-normal normal-case tracking-normal">
              (optional)
            </span>
          </h3>
          <textarea
            value={specialRequests}
            onChange={(e) => setSpecialRequests(e.target.value)}
            rows={2}
            placeholder="e.g. Late check-in, extra crib, allergies…"
            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
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
      </form>
    </Modal>
  );
}

interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  over?: boolean;
}

function Stepper({ label, value, min, max, onChange, over }: StepperProps) {
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(Math.min(max, value + 1));
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-700 mb-1.5">{label}</label>
      <div
        className={`flex items-center h-11 rounded-lg border bg-white overflow-hidden ${
          over ? "border-amber-300" : "border-gray-300"
        }`}
      >
        <button
          type="button"
          onClick={dec}
          disabled={value <= min}
          aria-label={`Decrease ${label.toLowerCase()}`}
          className="h-11 w-11 flex items-center justify-center text-gray-500 hover:bg-gray-50 disabled:text-gray-300 disabled:hover:bg-transparent transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isNaN(n)) return;
            onChange(Math.max(min, Math.min(max, n)));
          }}
          className="flex-1 h-11 text-center text-sm font-semibold text-gray-900 border-0 bg-transparent focus:outline-none focus:ring-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <button
          type="button"
          onClick={inc}
          disabled={value >= max}
          aria-label={`Increase ${label.toLowerCase()}`}
          className="h-11 w-11 flex items-center justify-center text-gray-500 hover:bg-gray-50 disabled:text-gray-300 disabled:hover:bg-transparent transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
