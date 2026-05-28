"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Booking,
  BookingAdditionalGuest,
  BookingAdditionalGuestPayload,
  BookingNote,
  bookingsService,
} from "@/services/bookings";
import { formatCurrency } from "@/lib/formatCurrency";

type GuestDraft = BookingAdditionalGuestPayload & { id?: string; position: number };

const primaryActionClass =
  "rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60";

type GuestRegistrationDraft = Pick<
  BookingAdditionalGuestPayload,
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "gender"
  | "nationality"
  | "dateOfBirth"
  | "passportNumber"
>;

function guestName(b: Booking) {
  return `${b.guestFirstName} ${b.guestLastName}`.trim();
}

function totalGuests(b: Booking) {
  return Math.max(1, b.numberOfGuests ?? b.adults + b.children);
}

function expectedAdditionalGuests(b: Booking) {
  return Math.max(0, totalGuests(b) - 1);
}

function totalRoomCapacity(b: Booking) {
  return Math.max(
    1,
    b.totalRoomCapacity ?? (b.roomMaxOccupancy || 1) * Math.max(1, b.numberOfRooms || 1),
  );
}

function additionalGuestCapacity(b: Booking) {
  return Math.max(0, totalRoomCapacity(b) - 1);
}

function roomUnit(b: Booking): string | null {
  if (b.assignedRooms?.length) {
    const numbers = b.assignedRooms.map((r) => r.roomNumber).filter(Boolean);
    return numbers.length ? numbers.join(", ") : null;
  }
  return b.roomNumber || null;
}

function shortDateRange(checkIn: string, checkOut: string) {
  const ci = new Date(`${checkIn}T12:00:00`);
  const co = new Date(`${checkOut}T12:00:00`);
  const mon = (d: Date) => d.toLocaleDateString("en-US", { month: "short" });
  if (ci.getMonth() === co.getMonth() && ci.getFullYear() === co.getFullYear()) {
    return `${ci.getDate()}–${co.getDate()} ${mon(ci)}`;
  }
  return `${ci.getDate()} ${mon(ci)} – ${co.getDate()} ${mon(co)}`;
}

function guestsLabel(b: Booking) {
  const parts: string[] = [];
  if (b.adults > 0) parts.push(`${b.adults} adult${b.adults === 1 ? "" : "s"}`);
  if (b.children > 0) parts.push(`${b.children} child${b.children === 1 ? "" : "ren"}`);
  return parts.join(", ") || `${totalGuests(b)} guest${totalGuests(b) === 1 ? "" : "s"}`;
}

function isPaid(b: Booking) {
  return ["captured", "paid", "refunded", "partially_refunded"].includes(b.paymentStatus || "");
}

function normalizeGuests(booking: Booking, guests: BookingAdditionalGuest[]): GuestDraft[] {
  const rows: GuestDraft[] = guests.map((g) => ({ ...g }));
  const expectedRows = Math.min(
    expectedAdditionalGuests(booking),
    additionalGuestCapacity(booking),
  );
  for (let idx = rows.length; idx < expectedRows; idx += 1) {
    rows.push({ position: idx + 1, roomPosition: rows[0]?.roomPosition ?? 0 });
  }
  return rows;
}

function bookerDraftFromBooking(booking: Booking): GuestRegistrationDraft {
  return {
    firstName: booking.guestFirstName || "",
    lastName: booking.guestLastName || "",
    email: booking.guestEmail || "",
    phone: booking.guestPhone || "",
    gender: booking.guestGender || "",
    nationality: booking.guestCountry || "",
    dateOfBirth: booking.guestDateOfBirth || null,
    passportNumber: booking.guestPassportNumber || "",
  };
}

function guestComplete(g: GuestRegistrationDraft) {
  return Boolean(
    g.firstName && g.lastName && g.gender && g.nationality && g.dateOfBirth && g.passportNumber,
  );
}

function guestHasData(g: GuestRegistrationDraft) {
  return Boolean(
    g.firstName ||
    g.lastName ||
    g.email ||
    g.phone ||
    g.gender ||
    g.nationality ||
    g.dateOfBirth ||
    g.passportNumber,
  );
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

function bookerDraftChanged(draft: GuestRegistrationDraft, b: Booking) {
  return (
    draft.firstName !== (b.guestFirstName || "") ||
    draft.lastName !== (b.guestLastName || "") ||
    draft.email !== (b.guestEmail || "") ||
    draft.phone !== (b.guestPhone || "") ||
    draft.gender !== (b.guestGender || "") ||
    draft.nationality !== (b.guestCountry || "") ||
    draft.dateOfBirth !== (b.guestDateOfBirth || null) ||
    draft.passportNumber !== (b.guestPassportNumber || "")
  );
}

function channelIsOta(channel: string | null | undefined) {
  return Boolean(channel && channel.toLowerCase() !== "direct");
}

function pendingFlags(booking: Booking, booker: GuestRegistrationDraft, guests: GuestDraft[]) {
  const flags: string[] = [];
  if (!guestComplete(booker)) flags.push("Booker ID");
  guests.forEach((guest, idx) => {
    if (!guestComplete(guest)) flags.push(`Guest ${idx + 2} ID`);
  });
  if (!isPaid(booking))
    flags.push(`Payment ${formatCurrency(booking.totalAmount, booking.currency)}`);
  if (!booking.assignedRooms?.length && !booking.roomId) flags.push("Room assignment");
  return flags;
}

export default function CheckInPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [booking, setBooking] = useState<Booking | null>(null);
  const [booker, setBooker] = useState<GuestRegistrationDraft | null>(null);
  const [guests, setGuests] = useState<GuestDraft[]>([]);
  const [notes, setNotes] = useState<BookingNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingGuest, setSavingGuest] = useState<string | null>(null);
  const [removingGuest, setRemovingGuest] = useState<string | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const [error, setError] = useState("");
  const [confirmationFlags, setConfirmationFlags] = useState<string[] | null>(null);
  const [actionLoading, setActionLoading] = useState<null | "markPaid" | "completeCheckIn">(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([bookingsService.get(id), bookingsService.listAdditionalGuests(id)])
      .then(async ([bookingRes, guestRes]) => {
        setBooking(bookingRes);
        setBooker(bookerDraftFromBooking(bookingRes));
        setGuests(normalizeGuests(bookingRes, guestRes.guests));
        try {
          const noteRes = await bookingsService.listNotes(id);
          setNotes(noteRes.notes);
        } catch {
          setNotes([]);
        }
      })
      .catch((err) => setError(err.message || "Could not load check-in"))
      .finally(() => setLoading(false));
  }, [id]);

  const flags = useMemo(
    () => (booking && booker ? pendingFlags(booking, booker, guests) : []),
    [booking, booker, guests],
  );
  const completedGuests =
    guests.filter(guestComplete).length + (booker && guestComplete(booker) ? 1 : 0);
  const ota = channelIsOta(booking?.channel);
  const maxGuests = booking ? totalRoomCapacity(booking) : 1;
  const remainingGuestSlots = booking ? Math.max(0, maxGuests - (guests.length + 1)) : 0;
  const overCapacityBy = booking ? Math.max(0, guests.length + 1 - maxGuests) : 0;
  const capacityReached = remainingGuestSlots === 0;

  const updateBooker = (patch: Partial<GuestRegistrationDraft>) => {
    setBooker((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateGuest = (index: number, patch: Partial<GuestDraft>) => {
    setGuests((prev) => prev.map((g, idx) => (idx === index ? { ...g, ...patch } : g)));
  };

  const addGuest = () => {
    if (capacityReached) return;
    setGuests((prev) => [
      ...prev,
      { position: prev.length + 1, roomPosition: prev[0]?.roomPosition ?? 0 },
    ]);
  };

  const removeGuest = async (index: number) => {
    if (!booking) return;
    const draft = guests[index];
    if (!draft) return;
    if (guestHasData(draft)) {
      const confirmed = window.confirm(
        `Remove Guest ${index + 2}? Their registration data will be deleted.`,
      );
      if (!confirmed) return;
    }
    setRemovingGuest(`guest-${index}`);
    setError("");
    try {
      if (draft.id) {
        await bookingsService.deleteAdditionalGuest(booking.id, draft.id);
      }
      setGuests((prev) =>
        prev
          .filter((_, idx) => idx !== index)
          .map((guest, idx) => ({ ...guest, position: guest.id ? guest.position : idx + 1 })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove guest");
    } finally {
      setRemovingGuest(null);
    }
  };

  const saveNote = async () => {
    if (!booking) return;
    const body = noteDraft.trim();
    if (!body) return;
    setSavingNote(true);
    setError("");
    try {
      const saved = await bookingsService.createNote(booking.id, body, "check-in");
      setNotes((prev) => [saved, ...prev]);
      setNoteDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save note");
    } finally {
      setSavingNote(false);
    }
  };

  const saveGuest = async (index: number) => {
    if (!booking) return;
    setSavingGuest(`guest-${index}`);
    setError("");
    try {
      const draft = guests[index];
      const payload: BookingAdditionalGuestPayload = {
        firstName: draft.firstName || "",
        lastName: draft.lastName || "",
        email: draft.email || "",
        phone: draft.phone || "",
        gender: draft.gender || "",
        nationality: draft.nationality || "",
        dateOfBirth: draft.dateOfBirth || null,
        passportNumber: draft.passportNumber || "",
        roomPosition: draft.roomPosition ?? 0,
      };
      const saved = draft.id
        ? await bookingsService.updateAdditionalGuest(booking.id, draft.id, payload)
        : await bookingsService.createAdditionalGuest(booking.id, payload);
      setGuests((prev) => prev.map((g, idx) => (idx === index ? { ...saved } : g)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save guest");
    } finally {
      setSavingGuest(null);
    }
  };

  const saveBooker = async () => {
    if (!booking || !booker) return;
    setSavingGuest("booker");
    setError("");
    try {
      const updated = await bookingsService.update(booking.id, {
        guestFirstName: booker.firstName || "",
        guestLastName: booker.lastName || "",
        guestEmail: booker.email || "",
        guestPhone: booker.phone || "",
        guestCountry: booker.nationality || "",
        guestGender: booker.gender || "",
        guestDateOfBirth: booker.dateOfBirth || null,
        guestPassportNumber: booker.passportNumber || "",
      });
      setBooking(updated);
      setBooker(bookerDraftFromBooking(updated));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save booker");
    } finally {
      setSavingGuest(null);
    }
  };

  const markPaid = async () => {
    if (!booking || actionLoading) return;
    setActionLoading("markPaid");
    setError("");
    try {
      setBooking(await bookingsService.markPaid(booking.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark payment as paid");
    } finally {
      setActionLoading(null);
    }
  };

  const completeCheckIn = async () => {
    if (!booking || !booker || actionLoading) return;
    const carriedFlags = [...flags];
    setActionLoading("completeCheckIn");
    setError("");
    try {
      // Flush any unsaved guest drafts that have data
      const flushResults = await Promise.allSettled(
        guests.map(async (draft, index) => {
          if (index >= additionalGuestCapacity(booking)) return draft;
          if (!guestHasData(draft)) return draft;
          const payload: BookingAdditionalGuestPayload = {
            firstName: draft.firstName || "",
            lastName: draft.lastName || "",
            email: draft.email || "",
            phone: draft.phone || "",
            gender: draft.gender || "",
            nationality: draft.nationality || "",
            dateOfBirth: draft.dateOfBirth || null,
            passportNumber: draft.passportNumber || "",
            roomPosition: draft.roomPosition ?? 0,
          };
          const saved = draft.id
            ? await bookingsService.updateAdditionalGuest(booking.id, draft.id, payload)
            : await bookingsService.createAdditionalGuest(booking.id, payload);
          return { ...draft, ...saved };
        }),
      );
      const flushedGuests = guests.map((draft, index) => {
        const result = flushResults[index];
        return result.status === "fulfilled" ? result.value : draft;
      });
      setGuests(flushedGuests);

      if (flushResults.some((result) => result.status === "rejected")) {
        throw new Error("Some guest drafts could not be saved. Please retry.");
      }

      if (bookerDraftChanged(booker, booking)) {
        const updated = await bookingsService.update(booking.id, {
          guestFirstName: booker.firstName || "",
          guestLastName: booker.lastName || "",
          guestEmail: booker.email || "",
          guestPhone: booker.phone || "",
          guestCountry: booker.nationality || "",
          guestGender: booker.gender || "",
          guestDateOfBirth: booker.dateOfBirth || null,
          guestPassportNumber: booker.passportNumber || "",
        });
        setBooking(updated);
        setBooker(bookerDraftFromBooking(updated));
      }
      const checkedIn = await bookingsService.completeCheckIn(booking.id, carriedFlags);
      setBooking(checkedIn);
      setConfirmationFlags(carriedFlags);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete check-in");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return <div className="p-4 md:p-6 text-sm text-gray-500">Loading check-in...</div>;
  }

  if (!booking || !booker) {
    return (
      <div className="p-4 md:p-6">
        <p className="text-sm text-red-600">{error || "Booking not found."}</p>
      </div>
    );
  }

  if (confirmationFlags) {
    return (
      <main className="mx-auto max-w-3xl p-4 md:p-6">
        <div className="rounded-2xl border border-green-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-green-700">Checked in</p>
          <h1 className="mt-2 text-2xl font-bold text-gray-950">{guestName(booking)}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {booking.bookingReference} is now marked Checked In.
          </p>
          {confirmationFlags.length > 0 && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-semibold text-amber-950">
                {confirmationFlags.length} item{confirmationFlags.length === 1 ? "" : "s"} still
                flagged on this booking
              </p>
              <ul className="mt-2 list-disc pl-5 text-sm text-amber-900">
                {confirmationFlags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href="/dashboard" className={primaryActionClass}>
              Back to dashboard
            </Link>
            <Link
              href={`/bookings/${booking.id}`}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700"
            >
              Open booking
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] overflow-x-hidden bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Link
              href="/dashboard"
              className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              aria-label="Back to dashboard"
            >
              ←
            </Link>
            <div className="min-w-0">
              <p className="text-sm text-gray-500">Dashboard / Check-in</p>
              <h1 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xl font-bold text-gray-950 md:text-3xl">
                Check in · {guestName(booking)}
                <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">
                  arriving today
                </span>
              </h1>
              {ota && (
                <div className="mt-1">
                  <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-700">
                    OTA fields locked
                  </span>
                </div>
              )}
            </div>
          </div>
        </header>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        {completedGuests < totalGuests(booking) && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            {totalGuests(booking) - completedGuests} of {totalGuests(booking)} guests missing
            registration details / passport / ID. Required for police registration. Check in now,
            complete later.
          </div>
        )}

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <Card title="Stay">
              <div className="grid gap-3 text-sm md:grid-cols-3">
                <Info
                  label="Room"
                  value={booking.roomName}
                  secondary={roomUnit(booking) ?? undefined}
                />
                <Info
                  label="Nights"
                  value={`${booking.nights} night${booking.nights === 1 ? "" : "s"}`}
                  secondary={shortDateRange(booking.checkIn, booking.checkOut)}
                />
                <Info label="Guests" value={guestsLabel(booking)} />
              </div>
            </Card>

            <Card
              title="Guest register"
              action={`${completedGuests} of ${guests.length + 1} complete`}
            >
              <div className="space-y-3">
                <div
                  className={`rounded-xl border p-3 text-sm ${
                    overCapacityBy > 0
                      ? "border-red-200 bg-red-50 text-red-800"
                      : capacityReached
                        ? "border-amber-200 bg-amber-50 text-amber-900"
                        : "border-blue-200 bg-blue-50 text-blue-900"
                  }`}
                >
                  {overCapacityBy > 0
                    ? `Over capacity by ${overCapacityBy} guest${overCapacityBy === 1 ? "" : "s"}. Room capacity reached (${maxGuests} guests maximum).`
                    : capacityReached
                      ? `Room capacity reached (${maxGuests} guests maximum).`
                      : `This booking allows ${remainingGuestSlots} additional guest${remainingGuestSlots === 1 ? "" : "s"}.`}
                </div>
                <GuestRegistrationCard
                  title={guestName(booking) || "Booker"}
                  badge="booker"
                  guest={booker}
                  complete={guestComplete(booker)}
                  ota={ota}
                  onChange={updateBooker}
                  onSave={saveBooker}
                  saving={savingGuest === "booker"}
                  saveLabel="Save booker"
                />

                {guests.map((guest, index) => {
                  const complete = guestComplete(guest);
                  return (
                    <GuestRegistrationCard
                      key={guest.id || `new-${index}`}
                      title={`Guest ${index + 2}`}
                      guest={guest}
                      complete={complete}
                      ota={ota}
                      onChange={(patch) => updateGuest(index, patch)}
                      onSave={() => saveGuest(index)}
                      saving={savingGuest === `guest-${index}`}
                      onRemove={() => removeGuest(index)}
                      removing={removingGuest === `guest-${index}`}
                    />
                  );
                })}

                <button
                  type="button"
                  onClick={addGuest}
                  disabled={capacityReached}
                  className="w-full rounded-xl border border-dashed border-gray-300 py-3 text-sm font-medium text-gray-500 hover:border-gray-400 hover:text-gray-700 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                >
                  {capacityReached
                    ? `Room capacity reached (${maxGuests} guests maximum).`
                    : "+ Add guest"}
                </button>
              </div>
            </Card>

            <Card title="Payment on arrival">
              <div
                className={`rounded-xl border p-4 ${isPaid(booking) ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}
              >
                <p
                  className={`font-semibold ${isPaid(booking) ? "text-green-800" : "text-amber-950"}`}
                >
                  {isPaid(booking)
                    ? booking.paymentMethod === "paypal"
                      ? "PayPal payment received"
                      : "Paid at property"
                    : booking.paymentMethod === "paypal"
                      ? `${formatCurrency(booking.totalAmount, booking.currency)} awaiting PayPal payment.`
                      : `${formatCurrency(booking.totalAmount, booking.currency)} due at property. Pay at property.`}
                </p>
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={markPaid}
                    disabled={actionLoading !== null}
                    className="rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    {actionLoading === "markPaid" ? "Marking..." : "Mark as paid"}
                  </button>
                </div>
              </div>
            </Card>

            <Card title="Notes">
              <div className="space-y-4">
                {notes.length > 0 && (
                  <div className="space-y-3">
                    {notes.map((note) => (
                      <div key={note.id} className="rounded-lg border border-gray-200 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                          <span className="font-medium text-gray-700">
                            {note.authorName || "Unknown"}
                          </span>
                          <span>{formatDateTime(note.createdAt)}</span>
                          {note.source === "check-in" && (
                            <span className="rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                              Check-in
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap text-sm text-gray-900">
                          {note.body}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="Add a note (visible on the reservation)."
                  rows={3}
                  className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-950 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
                <button
                  type="button"
                  onClick={saveNote}
                  disabled={savingNote || !noteDraft.trim()}
                  className={primaryActionClass}
                >
                  {savingNote ? "Saving..." : "Save note"}
                </button>
              </div>
            </Card>
          </div>

          <aside className="lg:sticky lg:top-6 lg:self-start">
            <Card title="Checklist">
              <div className="space-y-3">
                <ChecklistItem done={guestComplete(booker)} label="Booker ID" />
                {guests.map((guest, idx) => (
                  <ChecklistItem
                    key={guest.id || idx}
                    done={guestComplete(guest)}
                    label={`Guest ${idx + 2} ID`}
                  />
                ))}
                <ChecklistItem
                  done={isPaid(booking)}
                  label={`Payment ${formatCurrency(booking.totalAmount, booking.currency)}`}
                />
                <ChecklistItem
                  done={Boolean(booking.assignedRooms?.length || booking.roomId)}
                  label={`Room · ${booking.roomName}`}
                />
              </div>
              <button
                type="button"
                onClick={completeCheckIn}
                disabled={actionLoading !== null}
                className={`${primaryActionClass} mt-5 w-full py-3`}
              >
                {actionLoading === "completeCheckIn" ? "Completing..." : "Complete check-in"}
              </button>
              <p className="mt-3 text-center text-sm text-gray-500">
                {flags.length === 0
                  ? "Ready to check in"
                  : `${flags.length} item${flags.length === 1 ? "" : "s"} pending - check in anyway`}
              </p>
            </Card>
          </aside>
        </section>
      </div>
    </main>
  );
}

function GuestRegistrationCard({
  title,
  badge,
  guest,
  complete,
  ota,
  onChange,
  onSave,
  saving,
  onRemove,
  removing,
  saveLabel = "Save guest",
}: {
  title: string;
  badge?: string;
  guest: GuestRegistrationDraft;
  complete: boolean;
  ota: boolean;
  onChange: (patch: Partial<GuestRegistrationDraft>) => void;
  onSave: () => void;
  saving: boolean;
  onRemove?: () => void;
  removing?: boolean;
  saveLabel?: string;
}) {
  const contactLocked = (value: string | null | undefined) => ota && Boolean(value);

  return (
    <div
      className={`rounded-xl border p-4 ${
        complete ? "border-green-200 bg-green-50" : "border-amber-200 bg-white"
      }`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-gray-950">
            {complete ? "✓" : "!"} {title}{" "}
            {badge && (
              <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-xs text-green-700">
                {badge}
              </span>
            )}
          </p>
          <p className={`text-sm ${complete ? "text-green-700" : "text-amber-700"}`}>
            {complete ? "Registration complete" : "Missing passport / ID"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {ota && (
            <span className="text-right text-xs font-medium text-gray-500">
              Imported fields locked where supplied
            </span>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              disabled={removing}
              className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              {removing ? "Removing..." : "Remove"}
            </button>
          )}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label="First name"
          value={guest.firstName || ""}
          disabled={contactLocked(guest.firstName)}
          onChange={(v) => onChange({ firstName: v })}
        />
        <Field
          label="Last name"
          value={guest.lastName || ""}
          disabled={contactLocked(guest.lastName)}
          onChange={(v) => onChange({ lastName: v })}
        />
        <Field
          label="Email"
          type="email"
          value={guest.email || ""}
          disabled={contactLocked(guest.email)}
          onChange={(v) => onChange({ email: v })}
        />
        <Field
          label="Phone"
          type="tel"
          value={guest.phone || ""}
          disabled={contactLocked(guest.phone)}
          onChange={(v) => onChange({ phone: v })}
        />
        <SelectField
          label="Gender"
          value={guest.gender || ""}
          onChange={(v) => onChange({ gender: v })}
        />
        <Field
          label="Nationality"
          value={guest.nationality || ""}
          disabled={contactLocked(guest.nationality)}
          onChange={(v) => onChange({ nationality: v })}
        />
        <Field
          label="Date of birth"
          type="date"
          value={guest.dateOfBirth || ""}
          onChange={(v) => onChange({ dateOfBirth: v || null })}
        />
        <Field
          label="Passport / ID number"
          value={guest.passportNumber || ""}
          placeholder="needed for police report"
          onChange={(v) => onChange({ passportNumber: v })}
        />
      </div>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className={`${primaryActionClass} mt-3`}
      >
        {saving ? "Saving..." : saveLabel}
      </button>
    </div>
  );
}

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-950">{title}</h2>
        {action && (
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
            {action}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Info({ label, value, secondary }: { label: string; value: string; secondary?: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 font-semibold text-gray-950">{value}</p>
      {secondary && <p className="mt-0.5 text-xs text-gray-400">{secondary}</p>}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-600">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-10 w-full rounded-lg border border-gray-200 px-3 text-sm text-gray-950 disabled:bg-gray-100 disabled:text-gray-500"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-600">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-10 w-full rounded-lg border border-gray-200 px-3 text-sm text-gray-950"
      >
        <option value="">Select</option>
        <option value="female">Female</option>
        <option value="male">Male</option>
        <option value="non_binary">Non-binary</option>
        <option value="prefer_not_to_say">Prefer not to say</option>
      </select>
    </label>
  );
}

function ChecklistItem({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${done ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}
      >
        {done ? "✓" : "!"}
      </span>
      <span className="min-w-0 text-sm font-medium text-gray-800">{label}</span>
    </div>
  );
}
