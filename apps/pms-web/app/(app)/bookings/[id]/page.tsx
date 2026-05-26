"use client";

import { useState, useEffect, useCallback, use, useMemo, useRef } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  XCircleIcon,
  EllipsisHorizontalIcon,
  HomeModernIcon,
  PencilSquareIcon,
  ArrowsRightLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  TrashIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import {
  bookingsService,
  Booking,
  BookingChangeRequest,
  BookingNote,
  BookingAdditionalGuest,
  BookingAdditionalGuestPayload,
  CancellationPolicy,
} from "@/services/bookings";
import { individualRoomsService, Room } from "@/services/rooms";
import ConfirmDialog from "@/components/ConfirmDialog";
import Modal from "@/components/Modal";
import { formatCurrency } from "@/lib/formatCurrency";
import {
  BOOKING_STATUS_STYLES,
  PAYMENT_STATUS_STYLES,
  getPaymentStatusLabel,
  getChannelLabel,
  normalizeChannelKey,
} from "@/lib/constants/statusStyles";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Deterministic colored dot per roomTypeId — palette per room category
 * (ticket §2 "Room type icon (color per room/category)"). Same input
 * always returns the same color so the calendar / list / detail page
 * stay visually aligned even without a server-side palette. */
const ROOM_TYPE_PALETTE = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-purple-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-indigo-500",
  "bg-orange-500",
];
function roomTypeColor(roomTypeId: string | null | undefined): string {
  if (!roomTypeId) return "bg-gray-400";
  let hash = 0;
  for (let i = 0; i < roomTypeId.length; i++) {
    hash = (hash * 31 + roomTypeId.charCodeAt(i)) >>> 0;
  }
  return ROOM_TYPE_PALETTE[hash % ROOM_TYPE_PALETTE.length];
}

function formatDateLong(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function totalGuestsLabel(adults: number, children: number): string {
  const parts: string[] = [];
  parts.push(`${adults} adult${adults !== 1 ? "s" : ""}`);
  if (children > 0) {
    parts.push(`${children} child${children !== 1 ? "ren" : ""}`);
  }
  return parts.join(", ");
}

function CountdownTimer({ deadline }: { deadline: string }) {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    const update = () => {
      const diff = new Date(deadline).getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft("Expired");
        return;
      }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setTimeLeft(`${hours}h ${minutes}m remaining`);
    };
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, [deadline]);

  const isUrgent = new Date(deadline).getTime() - Date.now() < 4 * 60 * 60 * 1000;
  return (
    <span className={`text-sm font-medium ${isUrgent ? "text-red-600" : "text-amber-600"}`}>
      {timeLeft}
    </span>
  );
}

// ─── Header bar with overflow menu ───────────────────────────────────

function OverflowMenu({
  onPrint,
  onResendConfirmation,
  onExport,
}: {
  onPrint: () => void;
  onResendConfirmation: () => void;
  onExport: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        aria-label="More actions"
      >
        <EllipsisHorizontalIcon className="w-5 h-5" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-10 py-1">
          <button
            onClick={() => {
              setOpen(false);
              onPrint();
            }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Print
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onResendConfirmation();
            }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Resend confirmation email
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onExport();
            }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Export as JSON
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Cancellation policy panel ───────────────────────────────────────

interface CancellationPanelProps {
  checkIn: string;
  rateType: string;
  numberOfRooms: number;
  nightlyRate: number;
  currency: string;
  policy: CancellationPolicy | null;
}

function CancellationPolicyPanel({
  checkIn,
  rateType,
  numberOfRooms,
  nightlyRate,
  currency,
  policy,
}: CancellationPanelProps) {
  // Free window cutoff = check-in - freeCancellationDays.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const checkInDate = new Date(checkIn + "T00:00:00");
  const freeDays = policy?.freeCancellationDays ?? 0;
  const cutoff = new Date(checkInDate);
  cutoff.setDate(cutoff.getDate() - freeDays);

  const inFreeWindow = freeDays > 0 && today.getTime() < cutoff.getTime();
  // Non-refundable plan: no free window at all.
  const nonRefundable = freeDays <= 0;

  // Per-room charge after window. Default: first night of each room.
  const partialPct = policy?.partialRefundPct ?? 0;
  const perRoomCharge = nightlyRate;
  const totalCharge = perRoomCharge * numberOfRooms;
  // Effective refund percent inside the post-window region.
  const refundPctLabel =
    partialPct > 0
      ? `${partialPct}% refund`
      : `1 night/room · ${formatCurrency(totalCharge, currency)}`;

  const todayLabel = today.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const cutoffLabel = cutoff.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
        Cancellation policy · {rateType} rate
      </div>
      <div className="divide-y divide-gray-100">
        {!nonRefundable && (
          <div className="px-4 py-3 flex items-start justify-between gap-3">
            <div className="text-sm">
              <p className="font-medium text-gray-900">Free cancellation</p>
              <p className="text-gray-500 text-xs">
                Until {cutoffLabel} · {freeDays} day{freeDays !== 1 ? "s" : ""} before check-in
              </p>
            </div>
            <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
              No charge
            </span>
          </div>
        )}
        <div className="px-4 py-3 flex items-start justify-between gap-3">
          <div className="text-sm">
            <p className="font-medium text-gray-900">
              {nonRefundable ? "Non-refundable" : "After free window"}
            </p>
            <p className="text-gray-500 text-xs">
              {nonRefundable
                ? "Cancellation charges apply for the full stay."
                : `After ${cutoffLabel} · Within ${freeDays} day${freeDays !== 1 ? "s" : ""} of check-in`}
            </p>
          </div>
          <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">
            {refundPctLabel}
          </span>
        </div>
      </div>
      <div
        className={`px-4 py-2.5 text-xs font-medium ${
          inFreeWindow ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-800"
        }`}
      >
        Today is {todayLabel} —{" "}
        {inFreeWindow
          ? "within the free cancellation window. No charge applies."
          : nonRefundable
            ? "cancellation will incur the full charge."
            : `${refundPctLabel} applies.`}
      </div>
    </div>
  );
}

// ─── Additional guest expandable row ─────────────────────────────────

interface RoomOption {
  position: number;
  label: string;
}

interface GuestRowProps {
  guest: BookingAdditionalGuest;
  position: number;
  total: number;
  roomOptions: RoomOption[];
  onSave: (patch: BookingAdditionalGuestPayload) => Promise<void>;
  onDelete: () => Promise<void>;
}

function AdditionalGuestRow({
  guest,
  position,
  total,
  roomOptions,
  onSave,
  onDelete,
}: GuestRowProps) {
  const [open, setOpen] = useState(!guest.firstName && !guest.lastName);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    firstName: guest.firstName,
    lastName: guest.lastName,
    gender: guest.gender,
    nationality: guest.nationality,
    dateOfBirth: guest.dateOfBirth ?? "",
    email: guest.email,
    phone: guest.phone,
    passportNumber: guest.passportNumber,
    // Empty string in the dropdown represents "unassigned"; we translate
    // to null on save so the backend clears the row.
    roomPosition: guest.roomPosition == null ? "" : String(guest.roomPosition),
  });

  const initials =
    guest.firstName || guest.lastName
      ? `${(guest.firstName[0] || "").toUpperCase()}${(guest.lastName[0] || "").toUpperCase()}`
      : "?";
  const displayName =
    [guest.firstName, guest.lastName].filter(Boolean).join(" ") || "Unnamed guest";

  const roomBadge =
    guest.roomPosition == null
      ? null
      : roomOptions.find((r) => r.position === guest.roomPosition)?.label ||
        `Room ${guest.roomPosition + 1}`;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        firstName: form.firstName,
        lastName: form.lastName,
        gender: form.gender,
        nationality: form.nationality,
        dateOfBirth: form.dateOfBirth || null,
        email: form.email,
        phone: form.phone,
        passportNumber: form.passportNumber,
        roomPosition: form.roomPosition === "" ? null : Number(form.roomPosition),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-xs font-semibold text-gray-600">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{displayName}</p>
          <p className="text-xs text-gray-500">
            Guest {position} of {total}
            {roomBadge && (
              <>
                {" · "}
                <span className="text-gray-700">{roomBadge}</span>
              </>
            )}
          </p>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
          aria-label="Delete guest"
        >
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>
      {open && (
        <div className="px-4 py-4 border-t border-gray-100 bg-gray-50">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field
              label="First name"
              value={form.firstName}
              onChange={(v) => setForm({ ...form, firstName: v })}
            />
            <Field
              label="Last name"
              value={form.lastName}
              onChange={(v) => setForm({ ...form, lastName: v })}
            />
            <SelectField
              label="Gender"
              value={form.gender}
              onChange={(v) => setForm({ ...form, gender: v })}
              options={[
                { value: "", label: "—" },
                { value: "female", label: "Female" },
                { value: "male", label: "Male" },
                { value: "other", label: "Other" },
                { value: "prefer_not_to_say", label: "Prefer not to say" },
              ]}
            />
            <Field
              label="Nationality"
              value={form.nationality}
              onChange={(v) => setForm({ ...form, nationality: v })}
            />
            <Field
              label="Date of birth"
              type="date"
              value={form.dateOfBirth}
              onChange={(v) => setForm({ ...form, dateOfBirth: v })}
            />
            <Field
              label="Email (optional)"
              type="email"
              value={form.email}
              onChange={(v) => setForm({ ...form, email: v })}
            />
            <Field
              label="Phone (optional)"
              type="tel"
              value={form.phone}
              onChange={(v) => setForm({ ...form, phone: v })}
            />
            <Field
              label="Passport / ID (optional)"
              value={form.passportNumber}
              onChange={(v) => setForm({ ...form, passportNumber: v })}
            />
            {roomOptions.length > 1 && (
              <SelectField
                label="Room"
                value={form.roomPosition}
                onChange={(v) => setForm({ ...form, roomPosition: v })}
                options={[
                  { value: "", label: "Unassigned" },
                  ...roomOptions.map((r) => ({
                    value: String(r.position),
                    label: r.label,
                  })),
                ]}
              />
            )}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-black disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // 16px text size prevents iOS Safari from auto-zooming on focus.
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent bg-white"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ─── Move-room modal ─────────────────────────────────────────────────

interface MoveRoomModalProps {
  fromRoomNumber: string | null;
  candidates: Room[];
  onClose: () => void;
  onMove: (toRoomId: string) => Promise<void>;
}

function MoveRoomModal({ fromRoomNumber, candidates, onClose, onMove }: MoveRoomModalProps) {
  const [toRoomId, setToRoomId] = useState(candidates[0]?.id || "");
  const [moving, setMoving] = useState(false);
  const [err, setErr] = useState("");

  const handleMove = async () => {
    if (!toRoomId) return;
    setMoving(true);
    setErr("");
    try {
      await onMove(toRoomId);
      onClose();
    } catch (e) {
      setErr(errMessage(e, "Failed to move room"));
      setMoving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">
        Move {fromRoomNumber ? `Room ${fromRoomNumber}` : "this room"}
      </h3>
      <p className="text-sm text-gray-600 mb-4">
        Pick another room of the same type to reassign this segment to. Other rooms on this booking
        are excluded; rooms already occupied for these dates are excluded by the backend.
      </p>
      {candidates.length === 0 ? (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4">
          No other rooms of this type exist in your inventory.
        </p>
      ) : (
        <SelectField
          label="Destination room"
          value={toRoomId}
          onChange={setToRoomId}
          options={candidates.map((r) => ({
            value: r.id,
            label: `Room ${r.roomNumber}${r.floor ? ` · Floor ${r.floor}` : ""}`,
          }))}
        />
      )}
      {err && (
        <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {err}
        </p>
      )}
      <div className="flex justify-end gap-3 mt-4">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={handleMove}
          disabled={!toRoomId || moving || candidates.length === 0}
          className="px-4 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-black rounded-lg disabled:opacity-50"
        >
          {moving ? "Moving…" : "Move room"}
        </button>
      </div>
    </Modal>
  );
}

// ─── Per-room "assign guests" modal (per-room Modify) ────────────────

interface AssignGuestsModalProps {
  roomLabel: string;
  roomPosition: number;
  guests: BookingAdditionalGuest[];
  onClose: () => void;
  onSave: (assignments: Record<string, number | null>) => Promise<void>;
}

function AssignGuestsModal({
  roomLabel,
  roomPosition,
  guests,
  onClose,
  onSave,
}: AssignGuestsModalProps) {
  // Track which guest IDs the user has toggled into this room. Seed from
  // current state so editing then cancelling is a true no-op.
  const [assigned, setAssigned] = useState<Set<string>>(
    () => new Set(guests.filter((g) => g.roomPosition === roomPosition).map((g) => g.id)),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const toggle = (guestId: string) =>
    setAssigned((prev) => {
      const next = new Set(prev);
      if (next.has(guestId)) next.delete(guestId);
      else next.add(guestId);
      return next;
    });

  const handleSave = async () => {
    setSaving(true);
    setErr("");
    try {
      // Build a minimal diff: only patch guests whose membership in
      // `assigned` actually changed from their current state.
      const changes: Record<string, number | null> = {};
      for (const g of guests) {
        const wantsIn = assigned.has(g.id);
        const isIn = g.roomPosition === roomPosition;
        if (wantsIn && !isIn) changes[g.id] = roomPosition;
        else if (!wantsIn && isIn) changes[g.id] = null;
      }
      await onSave(changes);
      onClose();
    } catch (e) {
      setErr(errMessage(e, "Failed to update assignments"));
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">Guests in {roomLabel}</h3>
      <p className="text-sm text-gray-600 mb-4">
        Check the guests staying in this room. Unchecked guests are moved to other rooms or
        unassigned. The booker is always in the primary room and isn&apos;t listed here.
      </p>
      {guests.length === 0 ? (
        <p className="text-sm text-gray-500 mb-4">
          No additional guests have been added yet. Add them from the Additional guests card first.
        </p>
      ) : (
        <div className="space-y-2 mb-4 max-h-72 overflow-y-auto">
          {guests.map((g) => {
            const name =
              [g.firstName, g.lastName].filter(Boolean).join(" ") || `Guest ${g.position}`;
            const elsewhere =
              g.roomPosition != null && g.roomPosition !== roomPosition
                ? ` · currently Room ${g.roomPosition + 1}`
                : "";
            return (
              <label
                key={g.id}
                className="flex items-center gap-3 px-3 py-2 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={assigned.has(g.id)}
                  onChange={() => toggle(g.id)}
                  className="h-4 w-4 accent-gray-900"
                />
                <span className="flex-1 text-sm text-gray-900">{name}</span>
                <span className="text-xs text-gray-500">{elsewhere}</span>
              </label>
            );
          })}
        </div>
      )}
      {err && (
        <p className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {err}
        </p>
      )}
      <div className="flex justify-end gap-3">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || guests.length === 0}
          className="px-4 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-black rounded-lg disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save assignments"}
        </button>
      </div>
    </Modal>
  );
}

// ─── Page ────────────────────────────────────────────────────────────

export default function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [policy, setPolicy] = useState<CancellationPolicy | null>(null);
  const [notes, setNotes] = useState<BookingNote[]>([]);
  const [guests, setGuests] = useState<BookingAdditionalGuest[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState("");
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    variant?: "danger" | "default";
    confirmLabel?: string;
    onConfirm: () => void;
  } | null>(null);
  const [changeRequest, setChangeRequest] = useState<BookingChangeRequest | null>(null);
  const [decideOpen, setDecideOpen] = useState<"approve" | "decline" | null>(null);
  const [declineReason, setDeclineReason] = useState("");
  const [decidingChange, setDecidingChange] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [noteDraftOpen, setNoteDraftOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [allRooms, setAllRooms] = useState<Room[]>([]);
  const [moveTarget, setMoveTarget] = useState<{
    fromRoomId: string | null;
    fromRoomNumber: string | null;
  } | null>(null);
  const [assignTarget, setAssignTarget] = useState<{
    position: number;
    label: string;
  } | null>(null);
  const [bookerEditing, setBookerEditing] = useState(false);
  const [bookerSaving, setBookerSaving] = useState(false);
  const [bookerForm, setBookerForm] = useState({
    guestFirstName: "",
    guestLastName: "",
    guestGender: "",
    guestCountry: "",
    guestDateOfBirth: "",
    guestEmail: "",
    guestPhone: "",
    guestPassportNumber: "",
    specialRequests: "",
  });

  const loadAll = useCallback(async () => {
    try {
      const b = await bookingsService.get(id);
      setBooking(b);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
    Promise.all([
      bookingsService.getChangeRequest(id).then(setChangeRequest).catch(console.error),
      bookingsService
        .listNotes(id)
        .then((r) => setNotes(r.notes))
        .catch(console.error),
      bookingsService
        .listAdditionalGuests(id)
        .then((r) => setGuests(r.guests))
        .catch(console.error),
      bookingsService
        .getPaymentSettings()
        .then((r) => setPolicy(r.cancellationPolicy))
        .catch(console.error),
      individualRoomsService.list().then(setAllRooms).catch(console.error),
    ]);
  }, [id]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const doAction = useCallback(async (action: () => Promise<Booking>, errorMsg: string) => {
    setUpdating(true);
    setError("");
    try {
      const updated = await action();
      setBooking(updated);
    } catch (err) {
      setError(errMessage(err, errorMsg));
    } finally {
      setUpdating(false);
    }
  }, []);

  const handleAccept = () => {
    setConfirmDialog({
      message: "Are you sure you want to accept this booking? Payment will be captured.",
      confirmLabel: "Accept",
      onConfirm: () => {
        setConfirmDialog(null);
        doAction(() => bookingsService.acceptBooking(id), "Failed to accept booking");
      },
    });
  };

  const handleReject = () => {
    setRejectReason("");
    setRejectOpen(true);
  };

  const confirmReject = () => {
    setRejectOpen(false);
    doAction(
      () => bookingsService.rejectBooking(id, rejectReason.trim() || undefined),
      "Failed to reject booking",
    );
  };

  const handleApproveChange = async () => {
    setDecidingChange(true);
    setError("");
    try {
      const cr = await bookingsService.approveChangeRequest(id);
      setChangeRequest(cr);
      const refreshed = await bookingsService.get(id);
      setBooking(refreshed);
      setDecideOpen(null);
    } catch (err) {
      setError(errMessage(err, "Failed to approve change request"));
    } finally {
      setDecidingChange(false);
    }
  };

  const handleDeclineChange = async () => {
    setDecidingChange(true);
    setError("");
    try {
      const cr = await bookingsService.declineChangeRequest(id, declineReason.trim() || undefined);
      setChangeRequest(cr);
      setDecideOpen(null);
    } catch (err) {
      setError(errMessage(err, "Failed to decline change request"));
    } finally {
      setDecidingChange(false);
    }
  };

  const handleConfirmFromPending = () => {
    setConfirmDialog({
      message: "Are you sure you want to confirm this booking?",
      confirmLabel: "Confirm",
      onConfirm: () => {
        setConfirmDialog(null);
        doAction(() => bookingsService.updateStatus(id, "confirmed"), "Failed to confirm booking");
      },
    });
  };

  const handleSaveNote = async () => {
    const body = noteDraft.trim();
    if (!body) return;
    try {
      const note = await bookingsService.createNote(id, body);
      setNotes((prev) => [note, ...prev]);
      setNoteDraft("");
      setNoteDraftOpen(false);
    } catch (err) {
      setError(errMessage(err, "Failed to save note"));
    }
  };

  const handleDeleteNote = (noteId: string) => {
    setConfirmDialog({
      message: "Delete this note?",
      variant: "danger",
      confirmLabel: "Delete",
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await bookingsService.deleteNote(id, noteId);
          setNotes((prev) => prev.filter((n) => n.id !== noteId));
        } catch (err) {
          setError(errMessage(err, "Failed to delete note"));
        }
      },
    });
  };

  const handleAddGuest = async () => {
    setError("");
    try {
      const guest = await bookingsService.createAdditionalGuest(id, {});
      setGuests((prev) => [...prev, guest]);
    } catch (err) {
      setError(errMessage(err, "Failed to add guest"));
    }
  };

  const handleSaveGuest = async (guestId: string, patch: BookingAdditionalGuestPayload) => {
    try {
      const updated = await bookingsService.updateAdditionalGuest(id, guestId, patch);
      setGuests((prev) => prev.map((g) => (g.id === guestId ? updated : g)));
    } catch (err) {
      setError(errMessage(err, "Failed to save guest"));
    }
  };

  const handleDeleteGuest = async (guestId: string) => {
    setConfirmDialog({
      message: "Delete this guest?",
      variant: "danger",
      confirmLabel: "Delete",
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await bookingsService.deleteAdditionalGuest(id, guestId);
          setGuests((prev) => prev.filter((g) => g.id !== guestId));
        } catch (err) {
          setError(errMessage(err, "Failed to delete guest"));
        }
      },
    });
  };

  const handleEditBooker = () => {
    if (!booking) return;
    setBookerForm({
      guestFirstName: booking.guestFirstName,
      guestLastName: booking.guestLastName,
      guestGender: booking.guestGender,
      guestCountry: booking.guestCountry,
      guestDateOfBirth: booking.guestDateOfBirth ?? "",
      guestEmail: booking.guestEmail,
      guestPhone: booking.guestPhone,
      guestPassportNumber: booking.guestPassportNumber,
      specialRequests: booking.specialRequests,
    });
    setBookerEditing(true);
  };

  const handleSaveBooker = async () => {
    setBookerSaving(true);
    try {
      const updated = await bookingsService.update(id, {
        guestFirstName: bookerForm.guestFirstName,
        guestLastName: bookerForm.guestLastName,
        guestGender: bookerForm.guestGender,
        guestCountry: bookerForm.guestCountry,
        guestDateOfBirth: bookerForm.guestDateOfBirth || null,
        guestEmail: bookerForm.guestEmail,
        guestPhone: bookerForm.guestPhone,
        guestPassportNumber: bookerForm.guestPassportNumber,
        specialRequests: bookerForm.specialRequests,
      });
      setBooking(updated);
      setBookerEditing(false);
    } catch (err) {
      setError(errMessage(err, "Failed to save booker information"));
    } finally {
      setBookerSaving(false);
    }
  };

  const handleMoveRoom = async (fromRoomId: string | null, toRoomId: string) => {
    // The backend can move the primary or any extra; primary is identified
    // by omitting from_room_id. Pass it through unconditionally if we have it
    // so multi-room cases are unambiguous.
    const updated = await bookingsService.moveRoom(id, toRoomId, fromRoomId || undefined);
    setBooking(updated);
  };

  const handleAssignGuests = async (changes: Record<string, number | null>) => {
    // Issue PATCH calls in parallel; build a fresh list from the updated
    // rows so the UI doesn't go through a stale render.
    const updatedGuests = await Promise.all(
      Object.entries(changes).map(([guestId, roomPosition]) =>
        bookingsService.updateAdditionalGuest(id, guestId, { roomPosition }),
      ),
    );
    setGuests((prev) => {
      const byId = new Map(updatedGuests.map((g) => [g.id, g]));
      return prev.map((g) => byId.get(g.id) || g);
    });
  };

  const handleCancelBooking = async () => {
    if (!booking || booking.status !== "confirmed") {
      setCancelOpen(false);
      return;
    }
    const reason = cancelReason.trim();
    if (!reason) return;
    setCancelling(true);
    setError("");
    try {
      const updated = await bookingsService.cancelWithReason(id, reason);
      setBooking(updated);
      // Refresh notes — the cancel records a reason note server-side.
      const r = await bookingsService.listNotes(id);
      setNotes(r.notes);
      setCancelOpen(false);
      setCancelReason("");
    } catch (err) {
      setError(errMessage(err, "Failed to cancel booking"));
    } finally {
      setCancelling(false);
    }
  };

  // ── Pricing math (ticket §2: must reconcile) ───────────────────────
  const pricingBreakdown = useMemo(() => {
    if (!booking) return null;
    const roomsCost = booking.nightlyRate * booking.nights * booking.numberOfRooms;
    const addonsCost = booking.addonTotal || 0;
    const computed = roomsCost + addonsCost;
    const mismatch = Math.abs(computed - booking.totalAmount) > 0.01;
    return { roomsCost, addonsCost, computed, mismatch };
  }, [booking]);

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="p-6">
        <p className="text-gray-500">Booking not found.</p>
      </div>
    );
  }

  const isPending = booking.status === "pending";
  const canCancelBooking = booking.status === "confirmed";
  // VAY-404: treat 'declined' (host rejected) the same as cancelled/expired
  // for read-only/disabled UI affordances — the booking is terminal.
  const isCancelled =
    booking.status === "cancelled" || booking.status === "declined" || booking.status === "expired";
  const hasDeadline = isPending && booking.hostResponseDeadline;
  const totalParty = booking.adults + booking.children;
  const additionalCapacity = Math.max(0, totalParty - 1);

  // Build the per-room rows: bookings have numberOfRooms physical slots; the
  // assignedRooms list says which physical rooms map to which slot. If we
  // don't have an assignedRoom for every slot (e.g. an unassigned multi-room
  // booking), pad with an "unassigned" placeholder so the count matches.
  const roomRows = Array.from({ length: Math.max(1, booking.numberOfRooms) }, (_, idx) => {
    const assigned = booking.assignedRooms.find((a) => a.position === idx);
    return {
      position: idx,
      roomId: assigned?.roomId ?? null,
      roomNumber: assigned?.roomNumber ?? null,
    };
  });

  // Per-room guest count: explicit additional-guest assignments only, plus
  // the booker who lives implicitly in the primary room (position 0).
  // Unassigned additional guests don't count anywhere yet and are surfaced
  // on the Additional guests card header instead.
  const perRoomAssigned = roomRows.map(
    (_, idx) => guests.filter((g) => g.roomPosition === idx).length + (idx === 0 ? 1 : 0),
  );
  const unassignedGuests = guests.filter((g) => g.roomPosition == null).length;

  // Room-picker options for the per-guest dropdown + AssignGuestsModal label.
  const roomOptions: RoomOption[] = roomRows.map((row, idx) => ({
    position: idx,
    label: row.roomNumber ? `Room ${row.roomNumber}` : `Room slot ${idx + 1}`,
  }));

  // Candidates for Move: same room type, exclude rooms already on this booking.
  const ownRoomIds = new Set(
    booking.assignedRooms.map((r) => r.roomId).filter((rid): rid is string => !!rid),
  );
  const moveCandidates = allRooms.filter(
    (r) => r.roomTypeId === booking.roomTypeId && !ownRoomIds.has(r.id),
  );

  const channelKey = normalizeChannelKey(booking.channel);
  const channelLabel = getChannelLabel(booking.channel);
  const rateType = "Flexible"; // current bookings always use the hotel's default rate plan.

  // Add-ons rendered with quantity-suffix from addonQuantities.
  const addonRows = booking.addonIds.map((addonId, idx) => {
    const qty = booking.addonQuantities[addonId];
    const name = booking.addonNames?.[idx] || addonId;
    return { addonId, name, qty };
  });

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      {/* 1. Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/bookings" className="text-gray-400 hover:text-gray-600 -ml-1 p-1">
          <ArrowLeftIcon className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-gray-900">Booking {booking.bookingReference}</h1>
        <span
          className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${BOOKING_STATUS_STYLES[booking.status] || "bg-gray-100 text-gray-600"}`}
        >
          {booking.status}
        </span>
        <div className="ml-auto">
          <OverflowMenu
            onPrint={() => window.print()}
            onResendConfirmation={() =>
              setConfirmDialog({
                message:
                  "Resend the booking confirmation email to the guest? (Not yet implemented — placeholder.)",
                confirmLabel: "OK",
                onConfirm: () => setConfirmDialog(null),
              })
            }
            onExport={() => {
              const blob = new Blob([JSON.stringify(booking, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${booking.bookingReference}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          />
        </div>
      </div>

      {/* Pending-deadline + change-request banners (carried over) */}
      {hasDeadline && (
        <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-amber-800">Action Required</p>
            <p className="text-xs text-amber-600">
              This booking will auto-expire if not responded to in time.
            </p>
          </div>
          <CountdownTimer deadline={booking.hostResponseDeadline!} />
        </div>
      )}

      {booking.guestWithdrawn && (
        <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
          The guest withdrew this booking request.
        </div>
      )}

      {changeRequest && changeRequest.status === "pending" && (
        <div className="mb-4 p-5 bg-blue-50 border border-blue-200 rounded-xl">
          <div className="mb-3">
            <p className="text-sm font-semibold text-blue-900">Change Request Pending</p>
            <p className="text-xs text-blue-700">
              The guest has requested an edit to this booking. Approve to apply the new details, or
              decline to keep the booking as-is.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm mb-4">
            <div>
              <p className="text-blue-900 font-medium">Current</p>
              <p className="text-blue-800">
                {changeRequest.oldCheckIn} → {changeRequest.oldCheckOut}
              </p>
              <p className="text-blue-800">
                Total: {formatCurrency(changeRequest.oldTotal, changeRequest.currency)}
              </p>
            </div>
            <div>
              <p className="text-blue-900 font-medium">Requested</p>
              <p className="text-blue-800">
                {changeRequest.requestedCheckIn} → {changeRequest.requestedCheckOut}
              </p>
              <p className="text-blue-800">
                Total: {formatCurrency(changeRequest.newTotal, changeRequest.currency)}
              </p>
              {changeRequest.requestedAddonNames.length > 0 && (
                <p className="text-blue-800 mt-1">
                  Add-ons: {changeRequest.requestedAddonNames.join(", ")}
                </p>
              )}
            </div>
          </div>
          <div className="text-sm text-blue-900 font-medium mb-4">
            Price difference:{" "}
            {changeRequest.priceDifference === 0
              ? "No change"
              : changeRequest.priceDifference > 0
                ? `+${formatCurrency(changeRequest.priceDifference, changeRequest.currency)} (guest must pay)`
                : `${formatCurrency(changeRequest.priceDifference, changeRequest.currency)} (refund where applicable)`}
          </div>
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={() => setDecideOpen("approve")}
              disabled={decidingChange}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              <CheckCircleIcon className="w-4 h-4" />
              Approve Change
            </button>
            <button
              onClick={() => {
                setDeclineReason("");
                setDecideOpen("decline");
              }}
              disabled={decidingChange}
              className="inline-flex items-center gap-1.5 px-4 py-2 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              <XCircleIcon className="w-4 h-4" />
              Decline Change
            </button>
          </div>
        </div>
      )}

      {changeRequest && changeRequest.status !== "pending" && (
        <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
          Last change request was{" "}
          <span className="font-medium text-gray-800">{changeRequest.status}</span>
          {changeRequest.decidedAt && <> on {formatDateTime(changeRequest.decidedAt)}</>}
          {changeRequest.declineReason && (
            <span className="block mt-1 text-xs text-gray-500">
              Reason: {changeRequest.declineReason}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {/* 2. Stay details */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3 mb-5">
            <h2 className="text-sm font-semibold text-gray-900">Stay details</h2>
            {/* Booking-level Modify (dates / guest count for whole booking) */}
            <button
              disabled
              title="Use the guest's change-request flow to modify dates or add-ons"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 bg-gray-50 border border-gray-200 rounded-lg cursor-not-allowed"
            >
              <PencilSquareIcon className="w-4 h-4" />
              Modify
            </button>
          </div>

          {/* Summary row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-6">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">Check-in</p>
              <p className="font-semibold text-gray-900">{formatDateLong(booking.checkIn)}</p>
              <p className="text-xs text-gray-500">from 15:00</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">Check-out</p>
              <p className="font-semibold text-gray-900">{formatDateLong(booking.checkOut)}</p>
              <p className="text-xs text-gray-500">by 12:00</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">Duration</p>
              <p className="font-semibold text-gray-900">
                {booking.nights} night{booking.nights !== 1 ? "s" : ""}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">Total guests</p>
              <p className="font-semibold text-gray-900">
                {totalGuestsLabel(booking.adults, booking.children)}
              </p>
            </div>
          </div>

          {/* ROOMS sub-section */}
          <div className="mb-6">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Rooms ({roomRows.length})
            </p>
            <div className="space-y-2">
              {roomRows.map((row, idx) => (
                <div
                  key={row.position}
                  className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg"
                >
                  <div
                    className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-white ${roomTypeColor(booking.roomTypeId)}`}
                    aria-hidden
                  >
                    <HomeModernIcon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{booking.roomName}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {row.roomNumber ? `Room ${row.roomNumber}` : "Unassigned"} ·{" "}
                      {perRoomAssigned[idx]} guest{perRoomAssigned[idx] !== 1 ? "s" : ""}
                      {idx === 0 && " (incl. booker)"}
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      setAssignTarget({
                        position: idx,
                        label: row.roomNumber ? `Room ${row.roomNumber}` : `Room slot ${idx + 1}`,
                      })
                    }
                    disabled={isCancelled}
                    title="Assign which additional guests are staying in this room"
                    className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <PencilSquareIcon className="w-3.5 h-3.5" />
                    Modify
                  </button>
                  <button
                    onClick={() =>
                      setMoveTarget({
                        fromRoomId: row.roomId,
                        fromRoomNumber: row.roomNumber,
                      })
                    }
                    disabled={isCancelled || moveCandidates.length === 0}
                    title={
                      moveCandidates.length === 0
                        ? "No other rooms of this type available"
                        : "Reassign this segment to another physical room"
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ArrowsRightLeftIcon className="w-3.5 h-3.5" />
                    Move
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Pricing sub-section */}
          <div className="mb-6">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Pricing
            </p>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between text-gray-700">
                <span>
                  {roomRows.length} room{roomRows.length !== 1 ? "s" : ""} × {booking.nights} night
                  {booking.nights !== 1 ? "s" : ""} ×{" "}
                  {formatCurrency(booking.nightlyRate, booking.currency)}
                </span>
                <span className="font-medium text-gray-900">
                  {formatCurrency(pricingBreakdown?.roomsCost ?? 0, booking.currency)}
                </span>
              </div>
              {(pricingBreakdown?.addonsCost ?? 0) > 0 && (
                <div className="flex justify-between text-gray-700">
                  <span>Add-ons</span>
                  <span className="font-medium text-gray-900">
                    {formatCurrency(pricingBreakdown!.addonsCost, booking.currency)}
                  </span>
                </div>
              )}
              <div className="flex justify-between pt-2 mt-1 border-t border-gray-100">
                <span className="font-semibold text-gray-900">Total</span>
                <span className="font-bold text-gray-900">
                  {formatCurrency(booking.totalAmount, booking.currency)}
                </span>
              </div>
              {pricingBreakdown?.mismatch && (
                <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                  Charged total {formatCurrency(booking.totalAmount, booking.currency)} doesn&apos;t
                  match the line-item math (
                  {formatCurrency(pricingBreakdown.computed, booking.currency)}). May reflect a
                  promo, discount, or rate-override.
                </p>
              )}
              {booking.platformFeeAmount != null && booking.platformFeeAmount > 0 && (
                <div className="flex justify-between text-xs text-gray-500 pt-1">
                  <span>Platform fee</span>
                  <span>-{formatCurrency(booking.platformFeeAmount, booking.currency)}</span>
                </div>
              )}
              {booking.propertyPayoutAmount != null &&
                booking.propertyPayoutAmount !== booking.totalAmount && (
                  <div className="flex justify-between text-sm pt-2 border-t border-gray-100">
                    <span className="font-medium text-gray-700">Property payout</span>
                    <span className="font-bold text-green-700">
                      {formatCurrency(booking.propertyPayoutAmount, booking.currency)}
                    </span>
                  </div>
                )}
            </div>
          </div>

          {/* Payment sub-section */}
          <div className="mb-6">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Payment
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-xs text-gray-500">Method</p>
                <p className="font-medium text-gray-900">
                  {booking.paymentMethod === "card"
                    ? "Card"
                    : booking.paymentMethod === "pay_at_property"
                      ? "Pay at property"
                      : booking.paymentMethod || "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Status</p>
                {booking.paymentStatus ? (
                  <span
                    className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${PAYMENT_STATUS_STYLES[booking.paymentStatus] || "bg-gray-100 text-gray-600"}`}
                  >
                    {getPaymentStatusLabel(booking.paymentStatus)}
                  </span>
                ) : (
                  <p className="text-gray-400">—</p>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-500">Rate plan</p>
                <p className="font-medium text-gray-900">{rateType}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Source</p>
                <p className="font-medium text-gray-900">{channelLabel}</p>
                {channelKey !== "direct" && (
                  <p className="text-xs text-gray-500">Channel-managed</p>
                )}
              </div>
            </div>
          </div>

          {/* Add-ons sub-section (only if any) */}
          {addonRows.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Add-ons
              </p>
              <div className="space-y-1.5 text-sm">
                {addonRows.map((row) => (
                  <div key={row.addonId} className="flex justify-between text-gray-700">
                    <span>{row.name}</span>
                    {row.qty && <span className="text-gray-500">{row.qty} × stay</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 3. Guest information · booker */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Guest information · booker</h2>
            {!bookerEditing && (
              <button
                onClick={handleEditBooker}
                className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                aria-label="Edit booker information"
              >
                <PencilSquareIcon className="w-4 h-4" />
              </button>
            )}
          </div>
          {bookerEditing ? (
            <div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field
                  label="First name"
                  value={bookerForm.guestFirstName}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestFirstName: v })}
                />
                <Field
                  label="Last name"
                  value={bookerForm.guestLastName}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestLastName: v })}
                />
                <SelectField
                  label="Gender"
                  value={bookerForm.guestGender}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestGender: v })}
                  options={[
                    { value: "", label: "—" },
                    { value: "female", label: "Female" },
                    { value: "male", label: "Male" },
                    { value: "other", label: "Other" },
                    { value: "prefer_not_to_say", label: "Prefer not to say" },
                  ]}
                />
                <Field
                  label="Nationality"
                  value={bookerForm.guestCountry}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestCountry: v })}
                />
                <Field
                  label="Date of birth"
                  type="date"
                  value={bookerForm.guestDateOfBirth}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestDateOfBirth: v })}
                />
                <Field
                  label="Email"
                  type="email"
                  value={bookerForm.guestEmail}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestEmail: v })}
                />
                <Field
                  label="Phone (optional)"
                  type="tel"
                  value={bookerForm.guestPhone}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestPhone: v })}
                />
                <Field
                  label="Passport / ID (optional)"
                  value={bookerForm.guestPassportNumber}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestPassportNumber: v })}
                />
                <div className="md:col-span-2">
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-600 mb-1">
                      Special requests
                    </span>
                    <textarea
                      value={bookerForm.specialRequests}
                      onChange={(e) =>
                        setBookerForm({ ...bookerForm, specialRequests: e.target.value })
                      }
                      rows={3}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent resize-none"
                    />
                  </label>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setBookerEditing(false)}
                  className="px-3 py-1.5 text-xs font-medium text-gray-700 rounded-lg hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveBooker}
                  disabled={bookerSaving}
                  className="px-4 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-black disabled:opacity-50"
                >
                  {bookerSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-gray-500">Name</p>
                  <p className="font-medium text-gray-900">
                    {booking.guestFirstName} {booking.guestLastName}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Email</p>
                  <p className="font-medium text-gray-900 break-words">{booking.guestEmail}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Phone</p>
                  <p className="font-medium text-gray-900">{booking.guestPhone || "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Nationality</p>
                  <p className="font-medium text-gray-900">{booking.guestCountry || "—"}</p>
                </div>
                {booking.guestGender && (
                  <div>
                    <p className="text-xs text-gray-500">Gender</p>
                    <p className="font-medium text-gray-900 capitalize">
                      {booking.guestGender === "prefer_not_to_say"
                        ? "Prefer not to say"
                        : booking.guestGender}
                    </p>
                  </div>
                )}
                {booking.guestDateOfBirth && (
                  <div>
                    <p className="text-xs text-gray-500">Date of birth</p>
                    <p className="font-medium text-gray-900">
                      {formatDateLong(booking.guestDateOfBirth)}
                    </p>
                  </div>
                )}
                {booking.guestPassportNumber && (
                  <div>
                    <p className="text-xs text-gray-500">Passport / ID</p>
                    <p className="font-medium text-gray-900">{booking.guestPassportNumber}</p>
                  </div>
                )}
              </div>
              {(booking.specialRequests || booking.estimatedArrivalTime) && (
                <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  {booking.specialRequests && (
                    <div>
                      <p className="text-xs text-gray-500">Special requests</p>
                      <p className="text-gray-900 whitespace-pre-wrap">{booking.specialRequests}</p>
                    </div>
                  )}
                  {booking.estimatedArrivalTime && (
                    <div>
                      <p className="text-xs text-gray-500">Estimated arrival time</p>
                      <p className="font-medium text-gray-900">{booking.estimatedArrivalTime}</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* 4. Additional guests */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Additional guests</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {totalParty} {totalParty === 1 ? "guest" : "guests"} booked · {guests.length} of{" "}
                {additionalCapacity} added
                {roomRows.length > 1 && unassignedGuests > 0 && (
                  <> · {unassignedGuests} not yet assigned to a room</>
                )}
              </p>
            </div>
            <button
              onClick={handleAddGuest}
              disabled={guests.length >= additionalCapacity || channelKey !== "direct"}
              title={
                channelKey !== "direct"
                  ? "Channel-managed bookings carry limited guest PII"
                  : guests.length >= additionalCapacity
                    ? "All booked guests have been added"
                    : ""
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-900 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <PlusIcon className="w-4 h-4" />
              Add guest
            </button>
          </div>
          {guests.length === 0 ? (
            <p className="text-sm text-gray-500">No additional guests added yet.</p>
          ) : (
            <div className="space-y-2">
              {guests.map((g, idx) => (
                <AdditionalGuestRow
                  key={g.id}
                  guest={g}
                  position={idx + 1}
                  total={additionalCapacity}
                  roomOptions={roomOptions}
                  onSave={(patch) => handleSaveGuest(g.id, patch)}
                  onDelete={() => handleDeleteGuest(g.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* 5. Internal notes */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Internal notes</h2>
            <button
              onClick={() => setNoteDraftOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-900 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              <PlusIcon className="w-4 h-4" />
              Add note
            </button>
          </div>
          {noteDraftOpen && (
            <div className="mb-4">
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Notes are only visible to your team — never shown to the guest."
                rows={3}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent resize-none"
              />
              <div className="flex justify-end gap-2 mt-2">
                <button
                  onClick={() => {
                    setNoteDraft("");
                    setNoteDraftOpen(false);
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-gray-700 rounded-lg hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveNote}
                  disabled={!noteDraft.trim()}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-gray-900 rounded-lg hover:bg-black disabled:opacity-50"
                >
                  Save note
                </button>
              </div>
            </div>
          )}
          {notes.length === 0 ? (
            <p className="text-sm text-gray-500">No notes yet.</p>
          ) : (
            <div className="space-y-3">
              {notes.map((n) => (
                <div key={n.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-xs text-gray-500">
                      <span className="font-medium text-gray-700">{n.authorName || "Unknown"}</span>{" "}
                      · {formatDateTime(n.createdAt)}
                    </div>
                    <button
                      onClick={() => handleDeleteNote(n.id)}
                      className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
                      aria-label="Delete note"
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p className="mt-1.5 text-sm text-gray-900 whitespace-pre-wrap">{n.body}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pending-booking accept/reject — kept above the cancel card so the
            most urgent action stays visible without scrolling further. */}
        {isPending && booking.hostResponseDeadline && (
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={handleAccept}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              <CheckCircleIcon className="w-4 h-4" />
              Accept booking
            </button>
            <button
              onClick={handleReject}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              <XCircleIcon className="w-4 h-4" />
              Reject booking
            </button>
          </div>
        )}
        {isPending && !booking.hostResponseDeadline && (
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={handleConfirmFromPending}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              <CheckCircleIcon className="w-4 h-4" />
              Confirm booking
            </button>
          </div>
        )}

        {/* 6. Cancel booking (confirmed bookings only) */}
        {canCancelBooking && (
          <div className="bg-white border border-gray-200 rounded-xl p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-1">Cancel booking</h2>
            <p className="text-sm text-gray-600 mb-4">
              <span className="font-semibold">
                Cancels all {roomRows.length} {roomRows.length === 1 ? "room" : "rooms"} in this
                booking.
              </span>{" "}
              A reason is required.
            </p>

            <div className="mb-4">
              <CancellationPolicyPanel
                checkIn={booking.checkIn}
                rateType={rateType}
                numberOfRooms={roomRows.length}
                nightlyRate={booking.nightlyRate}
                currency={booking.currency}
                policy={policy}
              />
            </div>

            <button
              onClick={() => {
                setCancelReason("");
                setCancelOpen(true);
              }}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-4 py-2 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              <XCircleIcon className="w-4 h-4" />
              Cancel this booking
            </button>
          </div>
        )}
      </div>

      {/* Modals */}
      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          variant={confirmDialog.variant}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {decideOpen === "approve" && changeRequest && (
        <Modal onClose={() => setDecideOpen(null)}>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Approve change request?</h3>
          <p className="text-sm text-gray-600 mb-4">
            The booking will be updated to use the requested dates and add-ons.
            {changeRequest.priceDifference > 0 && (
              <>
                {" "}
                The guest will be asked to pay the{" "}
                {formatCurrency(changeRequest.priceDifference, changeRequest.currency)} difference.
              </>
            )}
            {changeRequest.priceDifference < 0 && (
              <>
                {" "}
                The total will decrease by{" "}
                {formatCurrency(Math.abs(changeRequest.priceDifference), changeRequest.currency)} —
                handle any refund manually.
              </>
            )}
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDecideOpen(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={handleApproveChange}
              disabled={decidingChange}
              className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg disabled:opacity-50"
            >
              {decidingChange ? "Approving…" : "Approve"}
            </button>
          </div>
        </Modal>
      )}

      {decideOpen === "decline" && (
        <Modal onClose={() => setDecideOpen(null)}>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Decline change request</h3>
          <p className="text-sm text-gray-600 mb-4">
            The booking will stay as-is. The guest will receive an email with your reason.
          </p>
          <textarea
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder="Reason (optional — will be included in the guest's email)"
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent mb-4 resize-none"
          />
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDecideOpen(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={handleDeclineChange}
              disabled={decidingChange}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
            >
              {decidingChange ? "Declining…" : "Decline"}
            </button>
          </div>
        </Modal>
      )}

      {rejectOpen && (
        <Modal onClose={() => setRejectOpen(false)}>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Reject booking</h3>
          <p className="text-sm text-gray-600 mb-4">
            Are you sure you want to reject this booking? The payment hold will be released.
          </p>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection (optional — will be included in the guest's email)"
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent mb-4 resize-none"
          />
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setRejectOpen(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={confirmReject}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg"
            >
              Reject
            </button>
          </div>
        </Modal>
      )}

      {cancelOpen && canCancelBooking && (
        <Modal onClose={() => setCancelOpen(false)}>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Cancel this booking?</h3>
          <p className="text-sm text-gray-600 mb-4">
            This cancels all {roomRows.length} {roomRows.length === 1 ? "room" : "rooms"} in the
            booking and emails the guest. The reason is recorded as an internal note.
          </p>
          <textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Cancellation reason (required)"
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent mb-4 resize-none"
          />
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setCancelOpen(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              Keep booking
            </button>
            <button
              onClick={handleCancelBooking}
              disabled={!cancelReason.trim() || cancelling}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
            >
              {cancelling ? "Cancelling…" : "Cancel booking"}
            </button>
          </div>
        </Modal>
      )}

      {moveTarget && (
        <MoveRoomModal
          fromRoomNumber={moveTarget.fromRoomNumber}
          candidates={moveCandidates}
          onClose={() => setMoveTarget(null)}
          onMove={(toRoomId) => handleMoveRoom(moveTarget.fromRoomId, toRoomId)}
        />
      )}

      {assignTarget && (
        <AssignGuestsModal
          roomLabel={assignTarget.label}
          roomPosition={assignTarget.position}
          guests={guests}
          onClose={() => setAssignTarget(null)}
          onSave={handleAssignGuests}
        />
      )}
    </div>
  );
}
