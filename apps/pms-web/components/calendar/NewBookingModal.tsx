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

const MONTHS_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function parseLocalDate(iso: string): { day: string; month: string; year: string } | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return {
    day: String(d).padStart(2, "0"),
    month: MONTHS_SHORT[m - 1] ?? "",
    year: String(y).slice(2),
  };
}

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
  const overOccupancy = selectedRoomType != null && totalGuests > selectedRoomType.maxOccupancy;
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

  const ci = parseLocalDate(checkIn);
  const co = parseLocalDate(checkOut);

  return (
    <Modal
      onClose={onClose}
      maxWidth="lg"
      bleedBody
      bleedFooter
      footer={
        <div className="px-5 sm:px-8 py-4 bg-ivory bg-grain border-t border-hairline">
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[10px] font-medium tracking-[0.2em] uppercase text-ash mb-0.5">
                Folio total
              </div>
              {total !== null && selectedRoomType ? (
                <>
                  <div className="font-display text-[28px] sm:text-[32px] leading-none text-ink numerals">
                    {formatCurrency(total, selectedRoomType.currency)}
                  </div>
                  <div className="mt-1 text-[10px] tracking-[0.16em] uppercase text-ash numerals">
                    {nights} {nights === 1 ? "night" : "nights"} ·{" "}
                    {formatCurrency(rateNum ?? 0, selectedRoomType.currency)}/nt
                  </div>
                </>
              ) : (
                <div className="font-display italic text-ash text-[15px] leading-none">
                  Set dates &amp; rate to total
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
                form="new-booking-form"
                disabled={submitting}
                className="h-11 px-5 text-[13px] font-semibold uppercase tracking-[0.14em] rounded-[2px] border border-ink bg-ink text-ivory hover:bg-[#2a2520] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? "Filing…" : "Create reservation"}
              </button>
            </div>
          </div>
        </div>
      }
    >
      <form
        id="new-booking-form"
        onSubmit={handleSubmit}
        className="bg-bone bg-grain font-sans text-ink min-h-full"
      >
        {/* Close — sits in the bleed area */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 w-9 h-9 rounded-full text-ash hover:text-ink hover:bg-hairline/50 flex items-center justify-center transition-colors z-10"
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path strokeLinecap="round" d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>

        <div className="px-6 sm:px-8 pt-9 pb-7">
          {/* Eyebrow */}
          <div className="flex items-baseline justify-between mb-5">
            <div className="text-[10px] font-medium tracking-[0.22em] uppercase text-clay">
              New reservation
            </div>
            <div className="text-[10px] tracking-[0.18em] uppercase text-ash numerals">
              File · {new Date().toISOString().slice(0, 10)}
            </div>
          </div>

          {/* Display headline */}
          <h2 className="font-display text-[36px] sm:text-[44px] leading-[0.95] tracking-[-0.01em] text-ink">
            Book a stay
          </h2>
          <p className="font-display italic text-[16px] text-ash mt-1.5 leading-snug">
            on behalf of a guest.
          </p>

          {/* Section 01 — Stay */}
          <Section index="01" label="Stay" />

          <div className="mb-5">
            <FieldLabel>Room</FieldLabel>
            <div className="relative">
              <select
                value={roomId}
                onChange={(e) => handleRoomChange(e.target.value)}
                className="w-full h-11 pl-0 pr-8 appearance-none bg-transparent border-0 border-b border-ink/80 text-[15px] text-ink focus:outline-none focus:border-clay transition-colors font-medium"
                required
              >
                {roomTypes.map((rt) => {
                  const typeRooms = roomsByType[rt.id] || [];
                  if (typeRooms.length === 0) return null;
                  return (
                    <optgroup key={rt.id} label={rt.name}>
                      {typeRooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          Room {r.roomNumber} — {rt.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
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
            {selectedRoomType && (
              <div className="mt-2 flex items-baseline gap-2 text-[11px] text-ash numerals">
                <span>Sleeps {selectedRoomType.maxOccupancy}</span>
                <span className="w-1 h-1 rounded-full bg-hairline" />
                <span>
                  From{" "}
                  <span className="text-ink font-medium">
                    {formatCurrency(selectedRoomType.baseRate, selectedRoomType.currency)}
                  </span>{" "}
                  / night
                </span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-3 sm:gap-4">
            <DateField
              label="Check-in"
              value={checkIn}
              parsed={ci}
              onChange={handleCheckInChange}
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
                <path
                  d="M64 1l6 3-6 3"
                  strokeWidth={1}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <DateField label="Check-out" value={checkOut} parsed={co} onChange={setCheckOut} />
          </div>

          {/* Section 02 — Guest */}
          <Section index="02" label="Guest" />

          <div className="grid grid-cols-2 gap-x-5 gap-y-5">
            <UnderlineInput
              label="First name"
              value={guestFirstName}
              onChange={setGuestFirstName}
              required
            />
            <UnderlineInput
              label="Last name"
              value={guestLastName}
              onChange={setGuestLastName}
              required
            />
            <UnderlineInput
              label="Email"
              type="email"
              value={guestEmail}
              onChange={setGuestEmail}
              placeholder="guest@example.com"
              required
            />
            <UnderlineInput
              label="Phone"
              type="tel"
              value={guestPhone}
              onChange={setGuestPhone}
              placeholder="+62 …"
            />
          </div>

          <div className="mt-6 grid grid-cols-2 gap-px bg-hairline border border-hairline">
            <OccupancyStepper
              label="Adults"
              value={adults}
              min={1}
              max={selectedRoomType?.maxOccupancy || 10}
              onChange={setAdults}
              over={overOccupancy}
            />
            <OccupancyStepper
              label="Children"
              value={children}
              min={0}
              max={10}
              onChange={setChildren}
              over={overOccupancy}
            />
          </div>
          {overOccupancy && selectedRoomType && (
            <div className="mt-3 flex items-baseline gap-3 border-l-2 border-clay pl-3 py-1">
              <span className="text-[10px] tracking-[0.18em] uppercase text-clay font-semibold">
                Note
              </span>
              <p className="text-[12px] text-ink leading-snug">
                Max occupancy is {selectedRoomType.maxOccupancy} for this room type — you have{" "}
                {totalGuests} guests selected.
              </p>
            </div>
          )}

          {/* Section 03 — Rate & channel */}
          <Section index="03" label="Rate & channel" />

          <div className="grid grid-cols-1 sm:grid-cols-[1.4fr_1fr] gap-5">
            <div>
              <FieldLabel>
                Nightly rate
                {selectedRoomType ? (
                  <span className="ml-1.5 text-ash/70 numerals">({selectedRoomType.currency})</span>
                ) : null}
              </FieldLabel>
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
                className="w-full h-11 px-0 bg-transparent border-0 border-b border-ink/80 font-display text-[24px] sm:text-[28px] text-ink numerals placeholder:text-ash/40 focus:outline-none focus:border-clay transition-colors"
              />
              {resolvedRate !== null && selectedRoomType ? (
                <div className="mt-2 flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-ash numerals">
                    Engine quote{" "}
                    <span className="text-ink font-medium">
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
                      className="text-[10px] font-semibold tracking-[0.16em] uppercase text-ink hover:text-clay underline-offset-4 hover:underline transition-colors"
                    >
                      Reset
                    </button>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-ash font-display italic">
                  Leave blank for the room type default.
                </p>
              )}
            </div>

            <div>
              <FieldLabel>Channel</FieldLabel>
              <div className="relative">
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  className="w-full h-11 pl-0 pr-8 appearance-none bg-transparent border-0 border-b border-ink/80 text-[15px] text-ink focus:outline-none focus:border-clay transition-colors font-medium"
                >
                  {visibleChannels.map((ch) => (
                    <option key={ch.value} value={ch.value}>
                      {ch.label}
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
          </div>

          {/* Section 04 — Notes */}
          <Section index="04" label="Notes" meta={<span className="text-ash">optional</span>} />
          <textarea
            value={specialRequests}
            onChange={(e) => setSpecialRequests(e.target.value)}
            rows={2}
            placeholder="Late check-in, extra crib, allergies…"
            className="w-full px-0 py-2 bg-transparent border-0 border-b border-ink/80 text-[14px] text-ink placeholder:text-ash/60 placeholder:font-display placeholder:italic focus:outline-none focus:border-clay transition-colors resize-none leading-relaxed"
          />

          {error && (
            <div className="mt-6 flex items-baseline gap-3 border-l-2 border-clay pl-3 py-1">
              <span className="text-[10px] tracking-[0.18em] uppercase text-clay font-semibold">
                Err
              </span>
              <p className="text-[13px] text-ink leading-snug">{error}</p>
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
    <div className="mt-9 mb-4 first:mt-10">
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

function UnderlineInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full h-11 px-0 bg-transparent border-0 border-b border-ink/80 text-[15px] text-ink placeholder:text-ash/60 placeholder:font-display placeholder:italic focus:outline-none focus:border-clay transition-colors"
      />
    </div>
  );
}

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
                ’{parsed.year}
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

function OccupancyStepper({
  label,
  value,
  min,
  max,
  onChange,
  over,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  over?: boolean;
}) {
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(Math.min(max, value + 1));
  return (
    <div className={`bg-ivory ${over ? "ring-1 ring-clay/40" : ""}`}>
      <div className="flex items-baseline justify-between px-3.5 pt-3 pb-1">
        <span className="text-[10px] font-medium tracking-[0.2em] uppercase text-ash">{label}</span>
        <span className="text-[9px] tracking-[0.16em] uppercase text-ash numerals">max {max}</span>
      </div>
      <div className="flex items-center justify-between px-2 pb-2">
        <button
          type="button"
          onClick={dec}
          disabled={value <= min}
          aria-label={`Decrease ${label.toLowerCase()}`}
          className="h-10 w-10 flex items-center justify-center text-ink disabled:text-hairline hover:text-clay disabled:hover:text-hairline transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M2 6h8" strokeLinecap="round" />
          </svg>
        </button>
        <span className="font-display text-[32px] leading-none numerals text-ink min-w-[24px] text-center">
          {value}
        </span>
        <button
          type="button"
          onClick={inc}
          disabled={value >= max}
          aria-label={`Increase ${label.toLowerCase()}`}
          className="h-10 w-10 flex items-center justify-center text-ink disabled:text-hairline hover:text-clay disabled:hover:text-hairline transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M6 2v8M2 6h8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
