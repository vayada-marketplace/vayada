"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Booking,
  BookingAdditionalGuest,
  BookingAdditionalGuestPayload,
  bookingsService,
} from "@/services/bookings";
import { formatCurrency } from "@/lib/formatCurrency";

type GuestDraft = BookingAdditionalGuestPayload & { id?: string; position: number };

function guestName(b: Booking) {
  return `${b.guestFirstName} ${b.guestLastName}`.trim();
}

function totalGuests(b: Booking) {
  return Math.max(1, b.numberOfGuests ?? b.adults + b.children);
}

function expectedAdditionalGuests(b: Booking) {
  return Math.max(0, totalGuests(b) - 1);
}

function roomLabel(b: Booking) {
  if (b.assignedRooms?.length) {
    return b.assignedRooms
      .map((r) => (r.roomNumber ? `${b.roomName} ${r.roomNumber}` : b.roomName))
      .join(", ");
  }
  return b.roomNumber ? `${b.roomName} ${b.roomNumber}` : b.roomName;
}

function formatDate(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function isPaid(b: Booking) {
  return ["captured", "paid", "refunded", "partially_refunded"].includes(b.paymentStatus || "");
}

function normalizeGuests(booking: Booking, guests: BookingAdditionalGuest[]): GuestDraft[] {
  const rows: GuestDraft[] = guests.map((g) => ({ ...g }));
  for (let idx = rows.length; idx < expectedAdditionalGuests(booking); idx += 1) {
    rows.push({ position: idx + 1, roomPosition: rows[0]?.roomPosition ?? 0 });
  }
  return rows;
}

function guestComplete(g: GuestDraft) {
  return Boolean(
    g.firstName && g.lastName && g.gender && g.nationality && g.dateOfBirth && g.passportNumber,
  );
}

function channelIsOta(channel: string | null | undefined) {
  return Boolean(channel && channel.toLowerCase() !== "direct");
}

function pendingFlags(booking: Booking, guests: GuestDraft[]) {
  const flags: string[] = [];
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
  const [guests, setGuests] = useState<GuestDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingGuest, setSavingGuest] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [confirmationFlags, setConfirmationFlags] = useState<string[] | null>(null);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [chargeAmount, setChargeAmount] = useState("");
  const [actionLoading, setActionLoading] = useState<
    null | "markPaid" | "addCharge" | "completeCheckIn"
  >(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([bookingsService.get(id), bookingsService.listAdditionalGuests(id)])
      .then(([bookingRes, guestRes]) => {
        setBooking(bookingRes);
        setGuests(normalizeGuests(bookingRes, guestRes.guests));
      })
      .catch((err) => setError(err.message || "Could not load check-in"))
      .finally(() => setLoading(false));
  }, [id]);

  const flags = useMemo(() => (booking ? pendingFlags(booking, guests) : []), [booking, guests]);
  const completedGuests = guests.filter(guestComplete).length + 1;
  const ota = channelIsOta(booking?.channel);

  const updateGuest = (index: number, patch: Partial<GuestDraft>) => {
    setGuests((prev) => prev.map((g, idx) => (idx === index ? { ...g, ...patch } : g)));
  };

  const saveGuest = async (index: number) => {
    if (!booking) return;
    setSavingGuest(index);
    setError("");
    try {
      const draft = guests[index];
      const payload: BookingAdditionalGuestPayload = {
        firstName: draft.firstName || "",
        lastName: draft.lastName || "",
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

  const addCharge = async () => {
    if (!booking || actionLoading) return;
    const amount = Number(chargeAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    setActionLoading("addCharge");
    setError("");
    try {
      setBooking(await bookingsService.addArrivalCharge(booking.id, amount, "Arrival charge"));
      setChargeAmount("");
      setChargeOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add arrival charge");
    } finally {
      setActionLoading(null);
    }
  };

  const completeCheckIn = async () => {
    if (!booking || actionLoading) return;
    const carriedFlags = [...flags];
    setActionLoading("completeCheckIn");
    setError("");
    try {
      const updated = await bookingsService.completeCheckIn(booking.id, carriedFlags);
      setBooking(updated);
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

  if (!booking) {
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
            <Link
              href="/dashboard"
              className="rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white"
            >
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
              <h1 className="truncate text-2xl font-bold text-gray-950 md:text-3xl">
                Check in · {guestName(booking)}
              </h1>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">
                  arriving today
                </span>
                {ota && (
                  <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-700">
                    OTA fields locked
                  </span>
                )}
              </div>
            </div>
          </div>
        </header>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        {guests.some((g) => !guestComplete(g)) && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            {guests.filter((g) => !guestComplete(g)).length} of {totalGuests(booking)} guests
            missing passport / ID. Required for police registration. Check in now, complete later.
          </div>
        )}

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <Card title="Stay">
              <div className="grid gap-3 text-sm md:grid-cols-3">
                <Info label="Room" value={roomLabel(booking)} />
                <Info
                  label="Nights"
                  value={`${booking.nights} · ${formatDate(booking.checkIn)} - ${formatDate(booking.checkOut)}`}
                />
                <Info
                  label="Guests"
                  value={`${totalGuests(booking)} guest${totalGuests(booking) === 1 ? "" : "s"}`}
                />
              </div>
            </Card>

            <Card
              title="Guest register"
              action={`${completedGuests} of ${totalGuests(booking)} complete`}
            >
              <div className="space-y-3">
                <div className="rounded-xl border border-green-200 bg-green-50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-gray-950">
                        ✓ {guestName(booking)}{" "}
                        <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-xs text-green-700">
                          booker
                        </span>
                      </p>
                      <p className="mt-1 text-sm text-gray-600">
                        {booking.guestCountry || "Nationality on file"} · reservation profile
                      </p>
                    </div>
                    <Link
                      href={`/bookings/${booking.id}`}
                      className="text-sm font-semibold text-blue-600"
                    >
                      Edit
                    </Link>
                  </div>
                </div>

                {guests.map((guest, index) => {
                  const complete = guestComplete(guest);
                  return (
                    <div
                      key={guest.id || `new-${index}`}
                      className={`rounded-xl border p-4 ${complete ? "border-green-200 bg-green-50" : "border-amber-200 bg-white"}`}
                    >
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold text-gray-950">
                            {complete ? "✓" : "!"} Guest {index + 2}
                          </p>
                          <p
                            className={`text-sm ${complete ? "text-green-700" : "text-amber-700"}`}
                          >
                            {complete ? "Registration complete" : "Missing passport / ID"}
                          </p>
                        </div>
                        {ota && (
                          <span className="text-xs font-medium text-gray-500">
                            Imported fields locked where supplied
                          </span>
                        )}
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <Field
                          label="First name"
                          value={guest.firstName || ""}
                          disabled={ota && Boolean(guest.firstName)}
                          onChange={(v) => updateGuest(index, { firstName: v })}
                        />
                        <Field
                          label="Last name"
                          value={guest.lastName || ""}
                          disabled={ota && Boolean(guest.lastName)}
                          onChange={(v) => updateGuest(index, { lastName: v })}
                        />
                        <SelectField
                          label="Gender"
                          value={guest.gender || ""}
                          onChange={(v) => updateGuest(index, { gender: v })}
                        />
                        <Field
                          label="Nationality"
                          value={guest.nationality || ""}
                          disabled={ota && Boolean(guest.nationality)}
                          onChange={(v) => updateGuest(index, { nationality: v })}
                        />
                        <Field
                          label="Date of birth"
                          type="date"
                          value={guest.dateOfBirth || ""}
                          onChange={(v) => updateGuest(index, { dateOfBirth: v || null })}
                        />
                        <Field
                          label="Passport / ID number"
                          value={guest.passportNumber || ""}
                          placeholder="needed for police report"
                          onChange={(v) => updateGuest(index, { passportNumber: v })}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => saveGuest(index)}
                        disabled={savingGuest === index}
                        className="mt-3 rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                      >
                        {savingGuest === index ? "Saving..." : "Save guest"}
                      </button>
                    </div>
                  );
                })}
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
                    ? "Paid at property"
                    : `${formatCurrency(booking.totalAmount, booking.currency)} due at property. Pay at property.`}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={markPaid}
                    disabled={actionLoading !== null}
                    className="rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    {actionLoading === "markPaid" ? "Marking..." : "Mark as paid"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setChargeOpen((v) => !v)}
                    className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700"
                  >
                    Add arrival charge
                  </button>
                </div>
                {chargeOpen && (
                  <div className="mt-3 flex gap-2">
                    <label htmlFor="arrival-charge-amount" className="sr-only">
                      Arrival charge amount
                    </label>
                    <input
                      id="arrival-charge-amount"
                      value={chargeAmount}
                      onChange={(e) => setChargeAmount(e.target.value)}
                      inputMode="decimal"
                      placeholder="Amount"
                      className="h-10 min-w-0 flex-1 rounded-lg border border-gray-200 px-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={addCharge}
                      disabled={actionLoading !== null}
                      className="rounded-lg bg-gray-950 px-4 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {actionLoading === "addCharge" ? "Adding..." : "Add"}
                    </button>
                  </div>
                )}
              </div>
            </Card>
          </div>

          <aside className="lg:sticky lg:top-6 lg:self-start">
            <Card title="Checklist">
              <div className="space-y-3">
                <ChecklistItem done label="Booker registered" />
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
                  label={`Room · ${roomLabel(booking)}`}
                />
              </div>
              <button
                type="button"
                onClick={completeCheckIn}
                disabled={actionLoading !== null}
                className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
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

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 font-semibold text-gray-950">{value}</p>
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
