"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useParams, useSearchParams } from "next/navigation";
import {
  Booking,
  BookingAdditionalGuest,
  BookingNote,
  CheckinStepResult,
  GuestRegistration,
  bookingsService,
} from "@/services/bookings";
import { calendarService } from "@/services/calendar";
import { CheckinChecklistStep, CheckinSettings, settingsService } from "@/services/settings";
import { formatCurrency } from "@/lib/formatCurrency";
import {
  bookingAmountDue,
  bookingSettlementLabel,
  expectedPaymentMethodLabel,
} from "@/components/bookings/BookingStaySummary";
import { useTranslation } from "@/lib/i18n";
import { localizedErrorText } from "@/lib/i18n/localizedErrorText";
import { localizeBuiltInCheckinStep } from "@/lib/settings/checklistCopy";
import { DEFAULT_CHECKIN_SETTINGS } from "@/lib/settings/checkinSettings";
import { bookingChannelLabel } from "@/lib/bookings/channelLabel";
import {
  expectedRegistrations,
  registrationGuests,
  registrationSummary,
  type RegistrationGuest,
} from "@/lib/checkin/registration";
import { checkinRooms, guestsByRoom, roomMoveOptions, type CheckinRoom } from "@/lib/checkin/rooms";
import { bookingArrivalTime, countLabel, stayRangeLabel } from "@/lib/checkin/labels";
import { formatPropertyDate, getPropertyToday } from "@/lib/dashboardBookings";
import {
  CheckinPhoneHeader,
  CheckinStepBar,
  type CheckinStepItem,
} from "@/components/checkin/CheckinStepBar";
import { CheckinBookingSummary } from "@/components/checkin/CheckinBookingSummary";
import { ArrivalStep } from "@/components/checkin/ArrivalStep";
import { RoomsGuestsStep } from "@/components/checkin/RoomsGuestsStep";
import type { GuestFormValues, GuestLockableField } from "@/components/checkin/GuestForm";
import { nationalityLabel } from "@vayada/locale-constants";
import {
  CheckinStepCard,
  checkinPrimaryButton,
  checkinSecondaryButton,
} from "@/components/checkin/CheckinStepCard";

const primaryActionClass =
  "rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60";

function guestName(b: Booking) {
  return `${b.guestFirstName} ${b.guestLastName}`.trim();
}

function isPaid(b: Booking) {
  if (b.amountStatus === "unverified") return false;
  if (b.depositRequired) return b.balanceAmount <= 0;
  return ["captured", "paid", "refunded", "partially_refunded"].includes(b.paymentStatus || "");
}

type MarkPaidOffer = "transfer" | "atProperty" | "cardRest";

/** The payment the hotel can record at the desk; the same cases the booking page offers. */
function markPaidOffer(b: Booking): MarkPaidOffer | null {
  if (b.amountStatus === "unverified") return null;
  // VAY-2205: a card deposit leaves the rest to pay at the hotel, also once the guest is in: check-in
  // moves the room assignments, the booking itself stays confirmed.
  if (
    b.paymentMethod === "card" &&
    b.paymentStatus === "partially_paid" &&
    ["confirmed", "checked_in", "in_house", "checked_out"].includes(b.status)
  )
    return "cardRest";
  if (b.status !== "confirmed" || b.paymentStatus !== "unpaid") return null;
  if (b.paymentMethod === "bank_transfer") return "transfer";
  if (b.paymentMethod === "pay_at_property") return "atProperty";
  return null;
}

function formatDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function channelIsOta(channel: string | null | undefined) {
  return Boolean(channel && channel.toLowerCase() !== "direct");
}

function customStepDone(step: CheckinChecklistStep, value: string | boolean | undefined) {
  if (step.type === "checkbox") return value === true;
  if (step.type === "amount") return Number(value || 0) > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function customStepValueForRecord(step: CheckinChecklistStep, value: string | boolean | undefined) {
  if (step.type === "checkbox") return value === true;
  if (step.type === "amount") return value ? Number(value) : 0;
  return typeof value === "string" ? value : "";
}

const STEP_KEYS = ["arrival", "rooms", "payment", "keys"] as const;

/** VAY-2373: the 4-step check-in, as approved in Paper (VAY-2372-2374 Check-in, p-16-0). Steps 1
 * and 2 are the new ones; 3 and 4 keep today's payment, notes and checklist until part 6. */
export default function CheckInPage() {
  const { locale, t } = useTranslation();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const searchParams = useSearchParams();
  const nextAfterCheckin = searchParams.get("next");
  const [booking, setBooking] = useState<Booking | null>(null);
  const [additionalGuests, setAdditionalGuests] = useState<BookingAdditionalGuest[]>([]);
  const [registrations, setRegistrations] = useState<GuestRegistration[]>([]);
  const [registrationsUnavailable, setRegistrationsUnavailable] = useState(false);
  const [canReadIdentity, setCanReadIdentity] = useState(false);
  const [settings, setSettings] = useState<CheckinSettings>(DEFAULT_CHECKIN_SETTINGS);
  const [notes, setNotes] = useState<BookingNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [requestRead, setRequestRead] = useState(false);
  const [movedFrom, setMovedFrom] = useState<Record<string, string>>({});
  const [confirmMarkPaid, setConfirmMarkPaid] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [error, setError] = useState("");
  const [confirmationFlags, setConfirmationFlags] = useState<string[] | null>(null);
  const [actionLoading, setActionLoading] = useState<null | "markPaid" | "completeCheckIn">(null);
  const [checklistSteps, setChecklistSteps] = useState<CheckinChecklistStep[]>([]);
  const [checklistValues, setChecklistValues] = useState<Record<string, string | boolean>>({});
  const [requiredWarning, setRequiredWarning] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      bookingsService.get(id),
      bookingsService.listAdditionalGuests(id),
      bookingsService.listGuestRegistrations(id).catch(() => null),
      // Settings → Check-in shapes every step; its defaults when it can't be read.
      settingsService
        .getCheckinSettings()
        .then((response) => response.settings)
        .catch(() => DEFAULT_CHECKIN_SETTINGS),
      settingsService.getCheckinChecklist().catch(() => ({ steps: [] })),
      bookingsService.listNotes(id).catch(() => ({ notes: [] })),
    ])
      .then(([bookingRes, guestRes, registrationRes, settingsRes, checklistRes, noteRes]) => {
        setBooking(bookingRes);
        setAdditionalGuests(guestRes.guests);
        setRegistrations(registrationRes?.guests ?? []);
        setRegistrationsUnavailable(!registrationRes);
        setCanReadIdentity(registrationRes?.canReadIdentity ?? false);
        setSettings(settingsRes);
        setChecklistSteps(checklistRes.steps || []);
        setNotes(noteRes.notes || []);
      })
      .catch((err) => setError(localizedErrorText(err, err.message || t("checkIn.loadError"), t)))
      .finally(() => setLoading(false));
  }, [id, t]);

  const pendingChecklistSteps = useMemo(
    () =>
      checklistSteps
        .filter((item) => item.required && !customStepDone(item, checklistValues[item.id]))
        .map((item) => ({
          stepId: item.id,
          label: localizeBuiltInCheckinStep(item, t).label,
        })),
    [checklistSteps, checklistValues, t],
  );
  const flags = useMemo(
    () => pendingChecklistSteps.map((flag) => flag.label),
    [pendingChecklistSteps],
  );

  const rooms = useMemo(() => (booking ? checkinRooms(booking) : []), [booking]);
  const guests = useMemo(
    () =>
      booking ? registrationGuests({ booking, additionalGuests, registrations, settings }) : [],
    [booking, additionalGuests, registrations, settings],
  );
  const placement = useMemo(() => guestsByRoom(guests, rooms), [guests, rooms]);
  const registration = registrationSummary(
    guests,
    booking ? expectedRegistrations(booking, settings) : 1,
  );

  const updateCustomValue = (stepId: string, value: string | boolean) => {
    setRequiredWarning(false);
    setChecklistValues((prev) => ({ ...prev, [stepId]: value }));
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
      setError(err instanceof Error ? err.message : t("checkIn.saveNoteError"));
    } finally {
      setSavingNote(false);
    }
  };

  /** The booker's name and contact come from the booking (only the nationality can be corrected);
   * other guests are saved to the guest list; then their registration, when staff may see IDs. */
  const saveGuest = async (guest: RegistrationGuest, values: GuestFormValues) => {
    if (!booking) return;
    let guestId = guest.guestId;
    if (guest.role === "booker") {
      if (values.nationality && values.nationality !== booking.guestCountry) {
        const correction = await bookingsService.correctPrimaryGuestNationality(
          booking.id,
          values.nationality,
        );
        setBooking((current) => (current ? { ...current, ...correction } : current));
      }
    } else {
      const payload = {
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: values.email.trim(),
        phone: values.phone.trim(),
        nationality: values.nationality,
      };
      const saved = guestId
        ? await bookingsService.updateAdditionalGuest(booking.id, guestId, payload)
        : await bookingsService.createAdditionalGuest(booking.id, payload);
      guestId = saved.id;
      setAdditionalGuests((current) =>
        current.some((entry) => entry.id === saved.id)
          ? current.map((entry) => (entry.id === saved.id ? saved : entry))
          : [...current, saved],
      );
    }
    if (!canReadIdentity || !guestId) return;
    const saved = await bookingsService.saveGuestRegistration(booking.id, guestId, {
      assignmentId: values.assignmentId,
      dateOfBirth: values.dateOfBirth || null,
      documentType: values.documentType || null,
      documentNumber: values.documentNumber.trim() || null,
      gender: values.gender || null,
      staffNotes: values.staffNotes.trim() || null,
    });
    setRegistrations((current) => [
      ...current.filter((entry) => entry.guestId !== saved.guestId),
      saved,
    ]);
  };

  const formInitial = (guest: RegistrationGuest): GuestFormValues => {
    const listed = additionalGuests.find((entry) => entry.id === guest.guestId);
    const booker = guest.role === "booker" && booking;
    const saved = guest.registration;
    const room = rooms.find((entry) =>
      (placement.get(entry.key) ?? []).some((placed) => placed.key === guest.key),
    );
    return {
      firstName: guest.firstName,
      lastName: guest.lastName,
      email: booker ? booking.guestEmail : (listed?.email ?? ""),
      phone: booker ? booking.guestPhone : (listed?.phone ?? ""),
      nationality: booker ? booking.guestCountry : (listed?.nationality ?? ""),
      dateOfBirth: saved?.dateOfBirth ?? "",
      documentType: saved?.documentType ?? "",
      documentNumber: saved?.documentNumber ?? "",
      gender: saved?.gender ?? "",
      staffNotes: saved?.staffNotes ?? "",
      assignmentId: saved?.assignmentId ?? room?.assignmentId ?? null,
    };
  };

  const ota = channelIsOta(booking?.channel);
  const lockedFields = (guest: RegistrationGuest) => {
    if (guest.role === "booker")
      return new Set<GuestLockableField>(["firstName", "lastName", "email", "phone"]);
    const listed = additionalGuests.find((entry) => entry.id === guest.guestId);
    const locked = new Set<GuestLockableField>();
    // An OTA import's values stay as supplied; empty ones can still be filled.
    if (ota && listed) {
      for (const name of ["firstName", "lastName", "email", "phone"] as const)
        if (listed[name]) locked.add(name);
      if (listed.nationality && nationalityLabel(listed.nationality)) locked.add("nationality");
    }
    return locked;
  };

  const loadRoomOptions = async (room: CheckinRoom) => {
    if (!booking) return [];
    const calendar = await calendarService.getCalendarData(room.checkIn, room.checkOut);
    return roomMoveOptions(room, booking, calendar);
  };

  const moveRoom = async (room: CheckinRoom, option: { roomId: string }) => {
    if (!booking) return;
    const updated = await bookingsService.moveRoom(
      booking.id,
      option.roomId,
      room.assignmentId ? { assignmentId: room.assignmentId } : { position: room.position },
      "preserve",
    );
    setBooking(updated);
    if (room.unit)
      setMovedFrom((current) => ({ ...current, [room.key]: current[room.key] ?? room.unit! }));
  };

  const markPaid = async () => {
    setConfirmMarkPaid(false);
    if (!booking || actionLoading) return;
    setActionLoading("markPaid");
    setError("");
    try {
      setBooking(await bookingsService.markPaid(booking.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkIn.markPaidError"));
    } finally {
      setActionLoading(null);
    }
  };

  const completeCheckIn = async () => {
    if (!booking || actionLoading) return;
    const carriedFlags = [...flags];
    if (pendingChecklistSteps.length > 0 && !requiredWarning) {
      setRequiredWarning(true);
      return;
    }
    setActionLoading("completeCheckIn");
    setError("");
    try {
      const completedAt = new Date().toISOString();
      const checklistResults: CheckinStepResult[] = checklistSteps.map((item) => {
        const value = checklistValues[item.id];
        const done = customStepDone(item, value);
        return {
          stepId: item.id,
          label: item.label,
          type: item.type,
          value: customStepValueForRecord(item, value),
          completedAt: done ? completedAt : null,
        };
      });
      const checkedIn = await bookingsService.completeCheckIn(
        booking.id,
        carriedFlags,
        checklistResults,
        pendingChecklistSteps,
      );
      setBooking(checkedIn);
      setConfirmationFlags(carriedFlags);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkIn.completeError"));
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return <div className="p-4 md:p-6 text-sm text-gray-500">{t("checkIn.loading")}</div>;
  }

  if (!booking) {
    return (
      <div className="p-4 md:p-6">
        <p className="text-sm text-red-600">{error || t("checkIn.bookingNotFound")}</p>
      </div>
    );
  }

  if (confirmationFlags) {
    return (
      <div className="max-w-3xl p-4 md:p-6">
        <div className="rounded-2xl border border-green-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-green-700">
            {t("dashboard.checkedIn")}
          </p>
          <h1 className="mt-2 text-2xl font-bold text-gray-950">{guestName(booking)}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {t("checkIn.completedReference", { reference: booking.bookingReference })}
          </p>
          {confirmationFlags.length > 0 && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-semibold text-amber-950">
                {t(
                  confirmationFlags.length === 1 ? "checkIn.flaggedItem" : "checkIn.flaggedItems",
                  { count: confirmationFlags.length },
                )}
              </p>
              <ul className="mt-2 list-disc pl-5 text-sm text-amber-900">
                {confirmationFlags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            {nextAfterCheckin === "checkout" ? (
              <Link href={`/check-out/${booking.id}`} className={primaryActionClass}>
                {t("checkIn.continueToCheckout")}
              </Link>
            ) : (
              <Link href="/dashboard" className={primaryActionClass}>
                {t("checkIn.backToDashboard")}
              </Link>
            )}
            <Link
              href={`/bookings/${booking.id}`}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700"
            >
              {t("checkIn.openBooking")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const paymentOffer = markPaidOffer(booking);
  const { due } = bookingAmountDue(booking);
  const request =
    settings.showSpecialRequest && booking.specialRequests.trim() ? booking.specialRequests : null;
  const arrivalReady = !request || !settings.confirmSpecialRequest || requestRead;
  const guestsReady = settings.allowIncompleteGuests || registration.incomplete.length === 0;
  const today = getPropertyToday();
  const arrivalLabel =
    booking.checkIn <= today
      ? t("dashboard.popup.arrivingToday", { time: bookingArrivalTime(booking) })
      : t("dashboard.popup.arrivesOn", {
          date: formatPropertyDate(booking.checkIn, { month: "short", day: "numeric" }, locale),
        });
  const registered = t("checkIn.flow.registered", {
    registered: registration.registered,
    total: registration.total,
  });
  const balance =
    booking.amountStatus === "unverified"
      ? t("dashboard.popup.amountUnverified")
      : due > 0
        ? t("dashboard.popup.amountDue", { amount: formatCurrency(due, booking.currency) })
        : t("dashboard.popup.nothingToPay");
  const checksDone = checklistSteps.filter((item) =>
    customStepDone(item, checklistValues[item.id]),
  ).length;
  const summaries = [
    !request
      ? t("checkIn.flow.arrival.noRequest")
      : !settings.confirmSpecialRequest
        ? t("checkIn.flow.arrival.requestShown")
        : requestRead
          ? t("checkIn.flow.arrival.requestDone")
          : t("checkIn.flow.arrival.requestOpen"),
    `${countLabel(t, "rooms", rooms.length)} · ${registered}`,
    balance,
    checklistSteps.length
      ? t("checkIn.flow.keys.checks", { done: checksDone, total: checklistSteps.length })
      : t("checkIn.ready"),
  ];
  const steps: CheckinStepItem[] = STEP_KEYS.map((key, index) => ({
    title: t(`checkIn.flow.${key}.title`),
    summary: summaries[index]!,
    state: index < step ? "done" : index === step ? "current" : "todo",
  }));
  // Forward only past a confirmed request, and past incomplete guests when the hotel allows it.
  const reachable = (index: number) =>
    index <= step || ((index < 1 || arrivalReady) && (index < 2 || guestsReady));
  const goTo = (index: number) => {
    if (!reachable(index)) return;
    setStep(index);
    window.scrollTo({ top: 0 });
  };
  const continueButton = (disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => goTo(step + 1)}
      className={checkinPrimaryButton}
    >
      {t("checkIn.flow.continue")}
    </button>
  );
  const unitList = new Intl.ListFormat(locale, { type: "conjunction" }).format(
    rooms.map((room) =>
      room.unit ? t("dashboard.popup.roomNumber", { number: room.unit }) : room.type,
    ),
  );

  return (
    <div className="overflow-x-clip p-4 md:p-6">
      <CheckinPhoneHeader
        name={guestName(booking)}
        arrival={arrivalLabel}
        steps={steps}
        backHref="/dashboard"
      />
      <div className="max-w-7xl space-y-5">
        <header className="hidden items-center gap-4 md:flex">
          <Link
            href="/dashboard"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
            aria-label={t("checkIn.flow.toDashboard")}
          >
            <ArrowLeftIcon className="h-5 w-5" aria-hidden="true" />
          </Link>
          <div className="min-w-0">
            <p className="text-sm text-gray-600">{t("checkIn.flow.breadcrumb")}</p>
            <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-3xl font-extrabold text-gray-900">
              {guestName(booking)}
              <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">
                {arrivalLabel}
              </span>
            </h1>
          </div>
        </header>
        <h1 className="sr-only md:hidden">{guestName(booking)}</h1>

        <CheckinStepBar steps={steps} onSelect={goTo} />

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}
        {registrationsUnavailable && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {t("dashboard.popup.registrationUnavailable")}
          </p>
        )}
        {confirmMarkPaid && paymentOffer && (
          <ConfirmDialog
            title={t("common.confirm")}
            message={
              paymentOffer === "cardRest"
                ? t("bookings.detail.confirmRestPaid", {
                    amount: formatCurrency(booking.balanceAmount, booking.currency, 2),
                  })
                : t("bookings.detail.confirmPaymentReceived", {
                    method:
                      paymentOffer === "transfer"
                        ? t("bookings.detail.bankTransferLower")
                        : t("bookings.detail.payAtHotelPaymentLower"),
                  })
            }
            confirmLabel={t("bookings.detail.markAsPaid")}
            cancelLabel={t("common.cancel")}
            onConfirm={() => void markPaid()}
            onCancel={() => setConfirmMarkPaid(false)}
          />
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          {step === 0 && (
            <CheckinStepCard
              step={1}
              total={4}
              title={steps[0]!.title}
              subtitle={t("checkIn.flow.arrival.subtitle")}
              hint={arrivalReady ? undefined : t("checkIn.flow.arrival.readFirst")}
              primary={continueButton(!arrivalReady)}
            >
              <ArrivalStep
                facts={[
                  {
                    label: t("checkIn.flow.arrival.arrival"),
                    value:
                      booking.checkIn <= today
                        ? t("checkIn.flow.arrival.todayAt", { time: bookingArrivalTime(booking) })
                        : formatPropertyDate(
                            booking.checkIn,
                            { weekday: "short", month: "short", day: "numeric" },
                            locale,
                          ),
                  },
                  {
                    label: t("checkIn.flow.arrival.stay"),
                    value: `${stayRangeLabel(locale, booking.checkIn, booking.checkOut)} · ${countLabel(t, "nights", booking.nights)}`,
                  },
                  {
                    label: t("checkIn.flow.arrival.guests"),
                    value: [
                      countLabel(t, "adults", booking.adults),
                      ...(booking.children ? [countLabel(t, "children", booking.children)] : []),
                      countLabel(t, "rooms", rooms.length),
                    ].join(" · "),
                  },
                  {
                    label: t("checkIn.flow.arrival.source"),
                    value: bookingChannelLabel(booking.channel, t),
                  },
                ]}
                request={request}
                confirmRequest={settings.confirmSpecialRequest}
                requestRead={requestRead}
                onRequestRead={setRequestRead}
              />
            </CheckinStepCard>
          )}

          {step === 1 && (
            <CheckinStepCard
              step={2}
              total={4}
              title={steps[1]!.title}
              subtitle={t(
                settings.allowIncompleteGuests
                  ? "checkIn.flow.rooms.subtitle"
                  : "checkIn.flow.rooms.subtitleStrict",
              )}
              onBack={() => goTo(0)}
              hint={
                registration.incomplete.length === 0
                  ? undefined
                  : t(
                      `checkIn.flow.rooms.${settings.allowIncompleteGuests ? "incompleteLater" : "incompleteBlocked"}${registration.incomplete.length === 1 ? "One" : "Many"}`,
                      { count: registration.incomplete.length },
                    )
              }
              primary={continueButton(!guestsReady)}
            >
              <RoomsGuestsStep
                rooms={rooms}
                guests={guests}
                placement={placement}
                settings={settings}
                canReadIdentity={canReadIdentity}
                movedFrom={movedFrom}
                formInitial={formInitial}
                lockedFields={lockedFields}
                onSaveGuest={saveGuest}
                loadRoomOptions={loadRoomOptions}
                onMoveRoom={moveRoom}
              />
            </CheckinStepCard>
          )}

          {step === 2 && (
            <CheckinStepCard
              step={3}
              total={4}
              title={steps[2]!.title}
              subtitle={t("checkIn.flow.payment.subtitle")}
              onBack={() => goTo(1)}
              primary={continueButton()}
            >
              <div className="space-y-3">
                {/* prettier-ignore */}
                <p className="text-sm text-gray-600">{t("checkIn.expectedMethod")}: <span className="font-semibold text-gray-900">{expectedPaymentMethodLabel(booking.expectedPaymentMethod, t)}</span></p>
                {booking.depositRequired && (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm">
                    <p className="font-semibold text-gray-900">
                      {t("checkIn.deposit", {
                        amount: formatCurrency(booking.depositAmount, booking.currency),
                      })}
                    </p>
                    <p className="text-xs text-gray-500">
                      {booking.paymentStatus === "captured"
                        ? t("bookings.balancePaid")
                        : t("bookings.statusPending")}{" "}
                      {t("checkIn.beforeArrival")}
                    </p>
                  </div>
                )}
                <div
                  className={`rounded-xl border p-4 ${isPaid(booking) ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}
                >
                  <p
                    className={`font-semibold ${isPaid(booking) ? "text-green-800" : "text-amber-950"}`}
                  >
                    {bookingSettlementLabel(booking, t)}
                  </p>
                  {paymentOffer && (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => setConfirmMarkPaid(true)}
                        disabled={actionLoading !== null}
                        className={primaryActionClass}
                      >
                        {actionLoading === "markPaid"
                          ? t("common.saving")
                          : paymentOffer === "cardRest"
                            ? t("bookings.detail.markRestPaid", {
                                amount: formatCurrency(booking.balanceAmount, booking.currency, 2),
                              })
                            : paymentOffer === "transfer"
                              ? t("bookings.detail.markBankTransferReceived")
                              : t("bookings.detail.markPayAtHotelReceived")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </CheckinStepCard>
          )}

          {step === 3 && (
            <CheckinStepCard
              step={4}
              total={4}
              title={steps[3]!.title}
              subtitle={t("checkIn.flow.keys.subtitle")}
              onBack={() => goTo(2)}
              hint={
                flags.length === 0
                  ? t("checkIn.ready")
                  : t(flags.length === 1 ? "checkIn.pendingItem" : "checkIn.pendingItems", {
                      count: flags.length,
                    })
              }
              primary={
                <button
                  type="button"
                  onClick={completeCheckIn}
                  disabled={actionLoading !== null}
                  className={checkinPrimaryButton}
                >
                  {actionLoading === "completeCheckIn"
                    ? t("checkIn.completing")
                    : t("checkIn.complete")}
                </button>
              }
            >
              <div className="space-y-6">
                <section className="space-y-3">
                  <h3 className="text-lg font-bold text-gray-900">{t("checkIn.checklist")}</h3>
                  {checklistSteps.length === 0 && (
                    <div className="rounded-lg border border-dashed border-gray-300 p-3 text-sm text-gray-500">
                      {t("checkIn.noSteps")}
                    </div>
                  )}
                  {checklistSteps.map((item) => (
                    <CustomChecklistItem
                      key={item.id}
                      step={item}
                      value={checklistValues[item.id]}
                      currency={booking.currency}
                      onChange={(value) => updateCustomValue(item.id, value)}
                    />
                  ))}
                  {requiredWarning && pendingChecklistSteps.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      {t(
                        pendingChecklistSteps.length === 1
                          ? "checkIn.requiredStepIncomplete"
                          : "checkIn.requiredStepsIncomplete",
                        { count: pendingChecklistSteps.length },
                      )}
                    </div>
                  )}
                </section>
                <section className="space-y-4">
                  <h3 className="text-lg font-bold text-gray-900">{t("checkIn.notes")}</h3>
                  {notes.map((note) => (
                    <div key={note.id} className="rounded-lg border border-gray-200 p-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <span className="font-medium text-gray-700">
                          {note.authorName || t("checkIn.unknown")}
                        </span>
                        <span>{formatDateTime(note.createdAt, locale)}</span>
                        {note.source === "check-in" && (
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                            {t("bookings.detail.checkIn")}
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 whitespace-pre-wrap text-sm text-gray-900">
                        {note.body}
                      </p>
                    </div>
                  ))}
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder={t("checkIn.notePlaceholder")}
                    rows={3}
                    className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-950 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  />
                  <button
                    type="button"
                    onClick={saveNote}
                    disabled={savingNote || !noteDraft.trim()}
                    className={checkinSecondaryButton}
                  >
                    {savingNote ? t("common.saving") : t("checkIn.saveNote")}
                  </button>
                </section>
              </div>
            </CheckinStepCard>
          )}

          <CheckinBookingSummary
            reference={booking.bookingReference}
            rows={[
              {
                label: t("checkIn.flow.summary.stay"),
                value: stayRangeLabel(locale, booking.checkIn, booking.checkOut),
              },
              { label: t("checkIn.flow.summary.rooms"), value: unitList },
              { label: t("checkIn.flow.summary.guests"), value: registered },
              { label: t("checkIn.flow.summary.balance"), value: balance },
              {
                label: t("checkIn.flow.summary.addons"),
                value: booking.addonNames.length
                  ? t("checkIn.flow.summary.addonsBooked", { count: booking.addonNames.length })
                  : t("checkIn.flow.summary.none"),
              },
            ]}
            booker={{
              name: guestName(booking),
              email: booking.guestEmail,
              phone: booking.guestPhone,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function CustomChecklistItem({
  step,
  value,
  currency,
  onChange,
}: {
  step: CheckinChecklistStep;
  value: string | boolean | undefined;
  currency: string;
  onChange: (value: string | boolean) => void;
}) {
  const { t } = useTranslation();
  const displayStep = localizeBuiltInCheckinStep(step, t);
  const done = customStepDone(step, value);
  const controlId = `checklist-${step.id}`;
  const labelId = `checklist-label-${step.id}`;
  const indicatorClass = done
    ? "bg-green-100 text-green-700"
    : step.required
      ? "bg-red-100 text-red-700"
      : "bg-gray-100 text-gray-500";

  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${indicatorClass}`}
        >
          {done ? "✓" : step.required ? "!" : "•"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span id={labelId} className="break-words text-sm font-medium text-gray-900">
              {displayStep.label}
            </span>
            {step.required && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                {t("common.required")}
              </span>
            )}
          </div>
          {displayStep.prompt && <p className="mt-1 text-xs text-gray-500">{displayStep.prompt}</p>}

          {step.type === "checkbox" && (
            <label className="mt-2 flex items-center gap-2 text-sm text-gray-600">
              <input
                id={controlId}
                type="checkbox"
                checked={value === true}
                onChange={(event) => onChange(event.target.checked)}
                aria-labelledby={`${labelId} ${controlId}-suffix`}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span id={`${controlId}-suffix`}>{t("checkIn.done")}</span>
            </label>
          )}

          {step.type === "text" && (
            <input
              id={controlId}
              value={typeof value === "string" ? value : ""}
              onChange={(event) => onChange(event.target.value)}
              placeholder={step.prompt || t("checkIn.addNote")}
              aria-labelledby={labelId}
              className="mt-2 h-10 w-full rounded-lg border border-gray-200 px-3 text-sm"
            />
          )}

          {step.type === "amount" && (
            <div className="mt-2 flex h-10 rounded-lg border border-gray-200 bg-white">
              <span className="flex items-center border-r border-gray-200 px-3 text-xs font-semibold text-gray-500">
                {currency}
              </span>
              <input
                id={controlId}
                type="number"
                min="0"
                step="0.01"
                value={typeof value === "string" ? value : ""}
                onChange={(event) => onChange(event.target.value)}
                placeholder="0.00"
                aria-labelledby={labelId}
                className="min-w-0 flex-1 rounded-r-lg px-3 text-sm outline-none"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
