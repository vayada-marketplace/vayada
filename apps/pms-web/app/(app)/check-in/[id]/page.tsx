"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { useParams, useSearchParams } from "next/navigation";
import {
  Booking,
  BookingAddon,
  BookingAdditionalGuest,
  BookingAdditionalGuestPayload,
  CheckinStepResult,
  GuestRegistration,
  HIDDEN_GUEST_CONTACT,
  ReservationGuestProfile,
  bookingsService,
} from "@/services/bookings";
import { calendarService } from "@/services/calendar";
import { CheckinChecklistStep, CheckinSettings, settingsService } from "@/services/settings";
import { arrivalTimesService } from "@/services/settings/arrivalTimes";
import { formatCurrency } from "@/lib/formatCurrency";
import { bookingAmountDue } from "@/components/bookings/BookingStaySummary";
import { useTranslation } from "@/lib/i18n";
import { localizedErrorText } from "@/lib/i18n/localizedErrorText";
import { localizeBuiltInCheckinStep } from "@/lib/settings/checklistCopy";
import { DEFAULT_CHECKIN_SETTINGS } from "@/lib/settings/checkinSettings";
import { bookingChannelLabel } from "@/lib/bookings/channelLabel";
import { guestProfileEdit, withBookerEdit } from "@/lib/bookings/guestProfileEdit";
import {
  expectedRegistrations,
  registrationGuests,
  registrationSummary,
  type RegistrationGuest,
} from "@/lib/checkin/registration";
import { checkinRooms, guestsByRoom, roomMoveOptions, type CheckinRoom } from "@/lib/checkin/rooms";
import { guestChanges } from "@/lib/checkin/guestAutosave";
import {
  bookingArrivalTime,
  countLabel,
  guestDisplayName,
  stayRangeLabel,
} from "@/lib/checkin/labels";
import { addonOffer } from "@/lib/checkin/addons";
import {
  deskChargeChanges,
  deskPayableBalance,
  settlementMethodFor,
  type DeskAddon,
  type DeskCharge,
  type PaymentChoice,
} from "@/lib/checkin/payment";
import { formatPropertyDate, getPropertyToday } from "@/lib/dashboardBookings";
import {
  CheckinPhoneHeader,
  CheckinStepBar,
  type CheckinStepItem,
} from "@/components/checkin/CheckinStepBar";
import {
  CheckinBookingCard,
  type CheckinCardAction,
} from "@/components/checkin/CheckinBookingCard";
import { ArrivalStep } from "@/components/checkin/ArrivalStep";
import { RoomsGuestsStep } from "@/components/checkin/RoomsGuestsStep";
import {
  AddonsPaymentStep,
  roomLineLabel,
  type PaymentLine,
} from "@/components/checkin/AddonsPaymentStep";
import { KeysCheckinStep, type CheckinReviewRow } from "@/components/checkin/KeysCheckinStep";
import { CheckinDone } from "@/components/checkin/CheckinDone";
import type { GuestFormValues, GuestLockableField } from "@/components/checkin/GuestForm";
import { nationalityLabel } from "@vayada/locale-constants";
import { CheckinStepCard } from "@/components/checkin/CheckinStepCard";

function guestName(b: Booking) {
  return `${b.guestFirstName} ${b.guestLastName}`.trim();
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

interface CheckinFlag {
  stepId: string;
  label: string;
}

/** VAY-2373: the 4-step check-in, as approved in Paper (VAY-2372-2374 Check-in, p-16-0). */
export default function CheckInPage() {
  const { locale, t } = useTranslation();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const searchParams = useSearchParams();
  const nextAfterCheckin = searchParams.get("next");
  const [booking, setBooking] = useState<Booking | null>(null);
  const [additionalGuests, setAdditionalGuests] = useState<BookingAdditionalGuest[]>([]);
  const [registrations, setRegistrations] = useState<GuestRegistration[]>([]);
  // The booker's guest record, through which their name and contact are edited (VAY-2420).
  const [bookerProfile, setBookerProfile] = useState<ReservationGuestProfile | null>(null);
  const [registrationsUnavailable, setRegistrationsUnavailable] = useState(false);
  const [canReadIdentity, setCanReadIdentity] = useState(false);
  const [settings, setSettings] = useState<CheckinSettings>(DEFAULT_CHECKIN_SETTINGS);
  const [catalog, setCatalog] = useState<BookingAddon[]>([]);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [requestRead, setRequestRead] = useState(false);
  const [movedFrom, setMovedFrom] = useState<Record<string, string>>({});
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [charges, setCharges] = useState<DeskCharge[]>([]);
  const [choice, setChoice] = useState<PaymentChoice | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  const [keysGiven, setKeysGiven] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<null | "payment" | "complete">(null);
  const [done, setDone] = useState<CheckinFlag[] | null>(null);
  const [checklistSteps, setChecklistSteps] = useState<CheckinChecklistStep[]>([]);
  const [checklistValues, setChecklistValues] = useState<Record<string, string | boolean>>({});
  const [checkOutTime, setCheckOutTime] = useState<string | null>(null);
  // The open guest form's save, and whether it holds details it couldn't save (VAY-2418).
  const guestFlush = useRef<(() => Promise<boolean>) | null>(null);
  const [guestUnsaved, setGuestUnsaved] = useState(false);

  useEffect(() => {
    if (!id) return;
    // The property's check-out time, for staff who may read the booking settings.
    arrivalTimesService
      .load()
      .then((setup) => setCheckOutTime(setup.current?.bundle.choices.checkOutTime ?? null))
      .catch(() => setCheckOutTime(null));
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
      calendarService.listAvailableAddons("").catch(() => [] as BookingAddon[]),
      bookingsService.listGuestProfiles(id).catch(() => null),
    ])
      .then(
        ([bookingRes, guestRes, registrationRes, settingsRes, checklistRes, addons, profiles]) => {
          // Listed booker first, like the guest the reservation read shows.
          const listedBooker = profiles?.[0];
          setBookerProfile(
            listedBooker?.guestProfileId && listedBooker.role !== "additional_guest"
              ? listedBooker
              : null,
          );
          setBooking(bookingRes);
          setAdditionalGuests(guestRes.guests);
          setRegistrations(registrationRes?.guests ?? []);
          setRegistrationsUnavailable(!registrationRes);
          setCanReadIdentity(registrationRes?.canReadIdentity ?? false);
          setSettings(settingsRes);
          setChecklistSteps(checklistRes.steps || []);
          setCatalog(addons);
        },
      )
      .catch((err) =>
        setError(localizedErrorText(err, err.message || t("checkIn.flow.loadError"), t)),
      )
      .finally(() => setLoading(false));
  }, [id, t]);

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
  // Leaving Rooms & guests waits for the open guest form's save, then is judged on what it saved:
  // a guest just made incomplete keeps staff there when every guest must be complete (VAY-2418).
  const [leaveTo, setLeaveTo] = useState<number | null>(null);
  const incompleteGuests = registration.incomplete.length;
  useEffect(() => {
    if (leaveTo === null) return;
    setLeaveTo(null);
    if (leaveTo < 2 || settings.allowIncompleteGuests || incompleteGuests === 0) {
      setStep(leaveTo);
      window.scrollTo({ top: 0 });
    }
  }, [leaveTo, settings.allowIncompleteGuests, incompleteGuests]);
  // Add-ons offered at the desk: those Settings → Check-in picks, in the booking's currency.
  const offers = useMemo(
    () =>
      booking && settings.offerAddons
        ? catalog
            .filter(
              (addon) =>
                (settings.addonIds === null || settings.addonIds.includes(addon.id)) &&
                addon.currency === booking.currency,
            )
            .map((addon) => addonOffer(addon, booking, rooms))
        : [],
    [booking, catalog, rooms, settings],
  );
  const addedItems: DeskAddon[] = offers
    .filter((offer) => (quantities[offer.addon.id] ?? 0) > 0)
    .map((offer) => {
      const quantity = quantities[offer.addon.id]!;
      return {
        addonId: offer.addon.id,
        label: quantity > 1 ? `${offer.addon.name} × ${quantity}` : offer.addon.name,
        amount: Math.round(offer.amount * quantity * 100) / 100,
      };
    });

  /** Saves what changed since the last save (VAY-2418 autosave). The booker's name and contact go
   * to their guest record (VAY-2420), the nationality to the booking's correction; other guests go
   * to the guest list, a new one listed first (`listed` gets its id at once, so a retry never
   * lists them twice); then their registration, when staff may see IDs. */
  const saveGuest = async (
    guest: RegistrationGuest,
    values: GuestFormValues,
    previous: GuestFormValues,
    knownId: string | null,
    listed: (id: string) => void,
  ) => {
    if (!booking) return;
    const { contact, registration: registrationChanged } = guestChanges(previous, values);
    let guestId = knownId;
    if (guest.role === "booker") {
      const edit = guestProfileEdit(previous, values);
      if (bookerProfile?.guestProfileId && Object.keys(edit).length) {
        await bookingsService.editGuestProfile(
          {
            bookingGuestId: bookerProfile.bookingGuestId,
            guestProfileId: bookerProfile.guestProfileId,
          },
          edit,
        );
        // The form holds both names as booked, so the booking's split of them stays right.
        const names = { firstName: values.firstName.trim(), lastName: values.lastName.trim() };
        setBookerProfile((current) => (current ? { ...current, ...names } : current));
        setBooking((current) =>
          current ? withBookerEdit(current, { ...edit, ...names }) : current,
        );
      }
      if (
        contact.includes("nationality") &&
        values.nationality &&
        values.nationality !== booking.guestCountry
      ) {
        const correction = await bookingsService.correctPrimaryGuestNationality(
          booking.id,
          values.nationality,
        );
        setBooking((current) => (current ? { ...current, ...correction } : current));
      }
    } else if (!guestId || contact.length) {
      const payload = {
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: values.email.trim(),
        phone: values.phone.trim(),
        nationality: values.nationality,
      };
      const changed: BookingAdditionalGuestPayload = {};
      for (const field of contact) changed[field] = payload[field];
      const saved = guestId
        ? await bookingsService.updateAdditionalGuest(booking.id, guestId, changed)
        : await bookingsService.createAdditionalGuest(booking.id, payload);
      guestId = saved.id;
      // In the same render as the list: the open card follows the new id instead of rebuilding.
      listed(saved.id);
      setAdditionalGuests((current) =>
        current.some((entry) => entry.id === saved.id)
          ? current.map((entry) => (entry.id === saved.id ? saved : entry))
          : [...current, saved],
      );
    }
    if (!canReadIdentity || !guestId || !registrationChanged) return;
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
    // The booker's names as booked: the reservation read only has them joined.
    const names = (booker && bookerProfile) || guest;
    const saved = guest.registration;
    const room = rooms.find((entry) =>
      (placement.get(entry.key) ?? []).some((placed) => placed.key === guest.key),
    );
    return {
      firstName: names.firstName,
      lastName: names.lastName,
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
    // The booker is edited through their guest record (VAY-2420); their contact only where staff
    // may see it.
    if (guest.role === "booker")
      return new Set<GuestLockableField>(
        !bookerProfile
          ? ["firstName", "lastName", "email", "phone"]
          : booking?.guestEmail === HIDDEN_GUEST_CONTACT
            ? ["email", "phone"]
            : [],
      );
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

  if (loading) {
    return <div className="p-4 md:p-6 text-sm text-gray-500">{t("common.loading")}</div>;
  }

  if (!booking) {
    return (
      <div className="p-4 md:p-6">
        <p className="text-sm text-red-600">{error || t("checkIn.flow.notFound")}</p>
      </div>
    );
  }

  const money = (amount: number) => formatCurrency(amount, booking.currency);
  const list = (items: string[]) =>
    new Intl.ListFormat(locale, { type: "conjunction" }).format(items);
  const unitName = (room: CheckinRoom) =>
    room.unit ? t("dashboard.popup.roomNumber", { number: room.unit }) : room.type;
  const nameOf = (guest: RegistrationGuest) =>
    guestDisplayName(guest, guests.indexOf(guest) + 1, t);
  const guestCount = Math.max(1, booking.numberOfGuests ?? booking.adults + booking.children);
  const incompleteNames = list(
    registration.incomplete.map((guest) =>
      guest.status === "id_missing"
        ? `${nameOf(guest)} (${t("checkIn.flow.status.id_missing")})`
        : nameOf(guest),
    ),
  );

  // What is still owed: the booking's balance when the desk can record it, plus add-ons added now.
  const { due } = bookingAmountDue(booking);
  const payable = deskPayableBalance(booking) !== null;
  const bookingDue = payable ? due : 0;
  const unpaidAdded = addedItems.filter(
    (item) =>
      !charges.some(
        (charge) =>
          charge.paid &&
          charge.addonId === item.addonId &&
          charge.label === item.label &&
          charge.amount === item.amount,
      ),
  );
  const dueNow = bookingDue + unpaidAdded.reduce((sum, item) => sum + item.amount, 0);
  const choiceLabel = (picked: PaymentChoice) =>
    picked.kind === "collect"
      ? t(`settings.checkIn.settlement.${picked.method}`)
      : t(`settings.checkIn.settlement.${picked.kind}`);
  const paymentLines: PaymentLine[] = (() => {
    const lines: PaymentLine[] = [];
    if (booking.amountStatus !== "unverified") {
      const priced = rooms.every((room) => room.nightlyRate != null);
      const roomsTotal = rooms.reduce(
        (sum, room) => sum + Math.round((room.nightlyRate ?? 0) * room.nights * 100) / 100,
        0,
      );
      if (priced && rooms.length) {
        for (const room of rooms)
          lines.push({
            key: `room-${room.key}`,
            label: roomLineLabel(room, t),
            amount: Math.round((room.nightlyRate ?? 0) * room.nights * 100) / 100,
          });
        if (booking.totalAmount - roomsTotal > 0.005)
          lines.push({
            key: "booked-addons",
            label: t("checkIn.flow.payment.bookedAddons"),
            amount: booking.totalAmount - roomsTotal,
          });
      } else
        lines.push({
          key: "booking",
          label: t("checkIn.flow.payment.bookingTotal"),
          amount: booking.totalAmount,
        });
    }
    for (const item of addedItems)
      lines.push({
        key: `added-${item.addonId}`,
        label: t("checkIn.flow.payment.addedLine", { name: item.label }),
        amount: item.amount,
      });
    if (booking.amountStatus !== "unverified")
      lines.push({
        key: "paid",
        label: t("checkIn.flow.payment.alreadyPaidLine"),
        amount: Math.max(0, booking.totalAmount - due),
      });
    if (!payable && due > 0 && booking.amountStatus !== "unverified")
      lines.push({
        key: "elsewhere",
        label: t("checkIn.flow.payment.notAtDesk"),
        amount: due,
      });
    return lines;
  })();

  const request =
    settings.showSpecialRequest && booking.specialRequests.trim() ? booking.specialRequests : null;
  const arrivalReady = !request || !settings.confirmSpecialRequest || requestRead;
  const guestsReady = settings.allowIncompleteGuests || registration.incomplete.length === 0;
  const paymentReady =
    recorded !== null || dueNow <= 0 || !settings.paymentChoiceRequired || choice !== null;
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
  const paymentSummary = recorded
    ? recorded
    : booking.amountStatus === "unverified"
      ? t("dashboard.popup.amountUnverified")
      : dueNow > 0
        ? choice
          ? `${money(dueNow)} · ${choiceLabel(choice)}`
          : t("dashboard.popup.amountDue", { amount: money(dueNow) })
        : t("dashboard.popup.nothingToPay");

  // Keys (D5: physical keys or no key step): every key is handed over before the check-in
  // (VAY-2418); the other open items stay on the reservation.
  const keyRooms = settings.keyHandover === "physical" ? rooms.filter((room) => room.unit) : [];
  const keysHanded = keyRooms.filter((room) => keysGiven[room.key]).length;
  const keysLeft = keyRooms.length - keysHanded;
  const checksDone = checklistSteps.filter((item) =>
    customStepDone(item, checklistValues[item.id]),
  ).length;
  const openFlags: CheckinFlag[] = [
    ...(registration.incomplete.length
      ? [
          {
            stepId: "guest-registrations",
            label: t("checkIn.flow.done.guestsFlag", { names: incompleteNames }),
          },
        ]
      : []),
    ...checklistSteps
      .filter((item) => item.required && !customStepDone(item, checklistValues[item.id]))
      .map((item) => ({ stepId: item.id, label: localizeBuiltInCheckinStep(item, t).label })),
  ];

  const summaries = [
    !request
      ? t("checkIn.flow.arrival.noRequest")
      : !settings.confirmSpecialRequest
        ? t("checkIn.flow.arrival.requestShown")
        : requestRead
          ? t("checkIn.flow.arrival.requestDone")
          : t("checkIn.flow.arrival.requestOpen"),
    `${countLabel(t, "rooms", rooms.length)} · ${registered}`,
    paymentSummary,
    keyRooms.length
      ? t("checkIn.flow.keys.keysCount", { handed: keysHanded, total: keyRooms.length })
      : t("checkIn.flow.keys.checks", { done: checksDone, total: checklistSteps.length }),
  ];
  // A step left behind with open items shows "!" instead of a tick.
  const warns = [false, registration.incomplete.length > 0, dueNow > 0 && !recorded, false];
  const steps: CheckinStepItem[] = STEP_KEYS.map((key, index) => ({
    title: t(`checkIn.flow.${key}.title`),
    summary: summaries[index]!,
    state: index === step ? "current" : index < step ? (warns[index] ? "warn" : "done") : "todo",
  }));
  // Forward only past a confirmed request, past incomplete guests when the hotel allows it, and
  // past the payment once it's settled (Continue on step 3 records it).
  const reachable = (index: number) =>
    index <= step ||
    ((index < 1 || arrivalReady) && (index < 2 || guestsReady) && (index < 3 || step === 2));
  const jump = (index: number) => {
    if (index === 3 && step === 2) {
      void settlePayment();
      return;
    }
    setStep(index);
    window.scrollTo({ top: 0 });
  };
  // An open guest form saves first; details it can't save keep staff on the step.
  const goTo = (index: number) => {
    if (!reachable(index)) return;
    if (step === 1 && guestFlush.current) {
      void guestFlush.current().then((saved) => saved && setLeaveTo(index));
      return;
    }
    jump(index);
  };

  /** Continue on step 3: the desk charges match the add-ons added now, then the payment is recorded
   * when staff collected it or it was paid earlier (D2: nothing is charged online). */
  async function settlePayment() {
    if (!booking || busy) return;
    if (!paymentReady) return;
    setBusy("payment");
    setError("");
    try {
      const { create, waive } = deskChargeChanges(addedItems, charges);
      let next = charges.filter((charge) => !waive.includes(charge));
      for (const charge of waive)
        await bookingsService.waiveCheckoutCharge(booking.id, charge.chargeId);
      for (const item of create) {
        const saved = await bookingsService.addCheckoutCharge(
          booking.id,
          item.label,
          item.amount,
          booking.currency,
        );
        next = [...next, { ...item, chargeId: saved.id, paid: false }];
      }
      setCharges(next);
      const method = !recorded && dueNow > 0 && choice ? settlementMethodFor(choice) : null;
      if (method && choice) {
        if (bookingDue > 0) setBooking(await bookingsService.markPaid(booking.id, method));
        for (const charge of next.filter((entry) => !entry.paid))
          await bookingsService.markCheckoutChargePaid(booking.id, charge.chargeId);
        setCharges(next.map((charge) => ({ ...charge, paid: true })));
        setRecorded(`${money(dueNow)} · ${choiceLabel(choice)}`);
      }
      setStep(3);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(localizedErrorText(err, t("checkIn.flow.payment.saveError"), t));
    } finally {
      setBusy(null);
    }
  }

  const completeCheckIn = async () => {
    if (busy || keysLeft > 0) return;
    setBusy("complete");
    setError("");
    try {
      const completedAt = new Date().toISOString();
      const results: CheckinStepResult[] = [
        ...checklistSteps.map((item) => {
          const value = checklistValues[item.id];
          return {
            stepId: item.id,
            label: item.label,
            type: item.type,
            value: customStepValueForRecord(item, value),
            completedAt: customStepDone(item, value) ? completedAt : null,
          };
        }),
        ...keyRooms.map((room) => ({
          stepId: `key:${room.key}`,
          label: t("checkIn.flow.keys.keyHanded", { room: unitName(room) }),
          type: "checkbox" as const,
          value: keysGiven[room.key] === true,
          completedAt: keysGiven[room.key] ? completedAt : null,
        })),
        {
          stepId: "payment",
          label: t("checkIn.flow.payment.heading"),
          type: "text" as const,
          value: recorded
            ? `recorded: ${recorded}`
            : dueNow > 0
              ? choice?.kind === "at_checkout"
                ? "at_checkout"
                : "open"
              : "nothing_due",
          completedAt,
        },
      ];
      const checkedIn = await bookingsService.completeCheckIn(
        booking.id,
        openFlags.map((flag) => flag.label),
        results,
        openFlags,
      );
      setBooking(checkedIn);
      setDone(openFlags);
    } catch (err) {
      setError(localizedErrorText(err, t("checkIn.flow.completeError"), t));
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <CheckinDone
        title={t("checkIn.flow.done.title", { name: guestName(booking) })}
        facts={[
          countLabel(t, "guests", guestCount),
          stayRangeLabel(locale, booking.checkIn, booking.checkOut),
          t("checkIn.flow.done.booking", { reference: booking.bookingReference }),
        ].join(" · ")}
        rooms={rooms.map((room) => ({ key: room.key, unit: unitName(room), type: room.type }))}
        openGuests={
          registration.incomplete.length
            ? {
                title: t(
                  `checkIn.flow.done.openGuests${registration.incomplete.length === 1 ? "One" : "Many"}`,
                  { count: registration.incomplete.length },
                ),
                detail: incompleteNames,
              }
            : null
        }
        otherFlags={done
          .filter((flag) => flag.stepId !== "guest-registrations")
          .map((flag) => flag.label)}
        bookingHref={`/bookings/${booking.id}`}
        next={
          nextAfterCheckin === "checkout"
            ? { href: `/check-out/${booking.id}`, label: t("checkIn.flow.done.toCheckout") }
            : { href: "/dashboard", label: t("checkIn.flow.done.toDashboard") }
        }
      />
    );
  }

  // Each step's button and the line under it, at the foot of the Booking card (VAY-2418).
  const fine = (text: string) => ({ text, ok: true });
  const pending = (text: string) => ({ text, ok: false });
  const actions: CheckinCardAction[] = [
    {
      label: t("checkIn.flow.arrival.cta"),
      disabled: !arrivalReady,
      onClick: () => goTo(1),
      status: arrivalReady
        ? fine(t("checkIn.flow.arrival.ready"))
        : pending(t("checkIn.flow.arrival.readFirst")),
    },
    {
      label: t("checkIn.flow.rooms.cta"),
      disabled: !guestsReady || guestUnsaved,
      onClick: () => goTo(2),
      status: guestUnsaved
        ? pending(t("checkIn.flow.rooms.notSaved"))
        : incompleteGuests === 0
          ? fine(t("checkIn.flow.rooms.allRegistered"))
          : pending(
              t(
                `checkIn.flow.rooms.${settings.allowIncompleteGuests ? "incompleteLater" : "incompleteBlocked"}${incompleteGuests === 1 ? "One" : "Many"}`,
                { count: incompleteGuests },
              ),
            ),
    },
    {
      label: busy === "payment" ? t("common.saving") : t("checkIn.flow.payment.cta"),
      disabled: !paymentReady || busy !== null,
      onClick: () => void settlePayment(),
      status: paymentReady
        ? { text: paymentSummary, ok: recorded !== null || dueNow <= 0 || choice !== null }
        : pending(t("checkIn.flow.payment.chooseFirst")),
    },
    {
      label: busy === "complete" ? t("checkIn.flow.keys.checkingIn") : t("checkIn.flow.keys.cta"),
      disabled: keysLeft > 0 || busy !== null,
      onClick: () => void completeCheckIn(),
      status:
        keysLeft > 0
          ? pending(
              t(`checkIn.flow.keys.keysLeft${keysLeft === 1 ? "One" : "Many"}`, {
                count: keysLeft,
              }),
            )
          : openFlags.length
            ? pending(
                t(`checkIn.flow.keys.openItems${openFlags.length === 1 ? "One" : "Many"}`, {
                  count: openFlags.length,
                }),
              )
            : fine(t("checkIn.flow.keys.allReady")),
    },
  ];
  const cardDate = (date: string) =>
    formatPropertyDate(date, { weekday: "short", month: "short", day: "numeric" }, locale);
  // "11:00" from the booking settings, in the reader's clock.
  const clockTime = (time: string) =>
    new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
      new Date(`1970-01-01T${time.slice(0, 5)}:00Z`),
    );
  const unitList = list(rooms.map(unitName));
  const reviewRows: CheckinReviewRow[] = [
    ...(request
      ? [
          {
            key: "request",
            title: t("dashboard.popup.specialRequest"),
            detail: settings.confirmSpecialRequest
              ? t("checkIn.flow.keys.requestRead")
              : t("checkIn.flow.arrival.requestShown"),
            ok: arrivalReady,
            editStep: 0,
          },
        ]
      : []),
    {
      key: "rooms",
      title: t("checkIn.flow.summary.rooms"),
      detail: rooms.map(unitName).join(" · "),
      ok: rooms.every((room) => room.unit),
      editStep: 1,
    },
    {
      key: "guests",
      title: t("checkIn.flow.summary.guests"),
      detail: registration.incomplete.length
        ? `${registered} · ${t("checkIn.flow.keys.finishLater")}`
        : registered,
      ok: registration.incomplete.length === 0,
      editStep: 1,
    },
    {
      key: "addons",
      title: t("checkIn.flow.summary.addons"),
      detail:
        [
          ...(booking.addonNames.length
            ? [t("checkIn.flow.summary.addonsBooked", { count: booking.addonNames.length })]
            : []),
          ...(addedItems.length
            ? [
                t("checkIn.flow.keys.addedNow", {
                  names: list(addedItems.map((item) => item.label)),
                }),
              ]
            : []),
        ].join(" · ") || t("checkIn.flow.summary.none"),
      ok: true,
      editStep: 2,
    },
    {
      key: "payment",
      title: t("checkIn.flow.payment.heading"),
      detail: recorded
        ? t("checkIn.flow.keys.paymentRecorded", { payment: recorded })
        : dueNow > 0
          ? choice?.kind === "at_checkout"
            ? t("checkIn.flow.keys.paymentAtCheckout", { amount: money(dueNow) })
            : t("dashboard.popup.amountDue", { amount: money(dueNow) })
          : t("dashboard.popup.nothingToPay"),
      ok: recorded !== null || dueNow <= 0,
      editStep: 2,
    },
    ...checklistSteps.map((item) => {
      const value = checklistValues[item.id];
      const complete = customStepDone(item, value);
      return {
        key: `check-${item.id}`,
        title: localizeBuiltInCheckinStep(item, t).label,
        detail: complete
          ? t("checkIn.flow.keys.checkDone")
          : item.required
            ? t("checkIn.flow.keys.checkRequired")
            : t("checkIn.flow.keys.checkOptional"),
        ok: complete || !item.required,
        control: (
          <ExtraCheckControl
            step={item}
            value={value}
            currency={booking.currency}
            onChange={(next) => setChecklistValues((current) => ({ ...current, [item.id]: next }))}
          />
        ),
      };
    }),
  ];

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
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </p>
        )}
        {registrationsUnavailable && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {t("dashboard.popup.registrationUnavailable")}
          </p>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          {step === 0 && (
            <CheckinStepCard
              step={1}
              total={4}
              title={steps[0]!.title}
              subtitle={t("checkIn.flow.arrival.subtitle")}
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
                guestFlush={guestFlush}
                onGuestUnsaved={setGuestUnsaved}
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
            >
              <AddonsPaymentStep
                booking={booking}
                settings={settings}
                offers={offers}
                quantities={quantities}
                onQuantity={(addonId, quantity) =>
                  setQuantities((current) => ({ ...current, [addonId]: Math.max(0, quantity) }))
                }
                locked={recorded !== null}
                lines={paymentLines}
                dueNow={dueNow}
                choice={choice}
                onChoice={setChoice}
                recorded={recorded}
                settledElsewhere={!payable && due > 0}
              />
            </CheckinStepCard>
          )}

          {step === 3 && (
            <CheckinStepCard
              step={4}
              total={4}
              title={steps[3]!.title}
              subtitle={t("checkIn.flow.keys.subtitle")}
            >
              <KeysCheckinStep
                keys={
                  keyRooms.length
                    ? keyRooms.map((room) => ({
                        key: room.key,
                        title: t("checkIn.flow.keys.keyHanded", { room: unitName(room) }),
                        guests: list((placement.get(room.key) ?? []).map(nameOf)),
                        given: keysGiven[room.key] === true,
                      }))
                    : null
                }
                onKey={(key, given) => setKeysGiven((current) => ({ ...current, [key]: given }))}
                rows={reviewRows}
                onEdit={goTo}
              />
            </CheckinStepCard>
          )}

          <CheckinBookingCard
            reference={booking.bookingReference}
            source={bookingChannelLabel(booking.channel, t)}
            viewHref={`/bookings/${booking.id}`}
            dates={[
              {
                label: t("bookings.detail.checkIn"),
                date: cardDate(booking.checkIn),
                time: bookingArrivalTime(booking),
              },
              {
                label: t("bookings.detail.checkOut"),
                date: cardDate(booking.checkOut),
                time: checkOutTime ? clockTime(checkOutTime) : null,
              },
            ]}
            rows={[
              { label: t("checkIn.flow.summary.rooms"), value: unitList },
              {
                label: t("checkIn.flow.summary.guests"),
                value: registered,
                warn: incompleteGuests > 0,
              },
              {
                label: t("checkIn.flow.summary.addons"),
                value:
                  [
                    ...(booking.addonNames.length
                      ? [
                          t("checkIn.flow.summary.addonsBooked", {
                            count: booking.addonNames.length,
                          }),
                        ]
                      : []),
                    ...(addedItems.length
                      ? [t("checkIn.flow.summary.addonsAdded", { count: addedItems.length })]
                      : []),
                  ].join(" · ") || t("checkIn.flow.summary.none"),
              },
              ...(keyRooms.length
                ? [
                    {
                      label: t("checkIn.flow.summary.keys"),
                      value: t("checkIn.flow.summary.keysCount", {
                        handed: keysHanded,
                        total: keyRooms.length,
                      }),
                      warn: keysLeft > 0,
                    },
                  ]
                : []),
            ]}
            balance={{ label: t("checkIn.flow.summary.balance"), value: paymentSummary }}
            action={actions[step]!}
            back={
              step > 0
                ? {
                    label: t("checkIn.flow.backTo", { step: steps[step - 1]!.title }),
                    onClick: () => goTo(step - 1),
                  }
                : null
            }
          />
        </div>
      </div>
    </div>
  );
}

/** An extra check from Settings → Check-in, filled in on its review row. */
function ExtraCheckControl({
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
  const label = localizeBuiltInCheckinStep(step, t).label;
  if (step.type === "checkbox")
    return (
      <label className="flex shrink-0 items-center gap-2 text-sm font-semibold text-gray-700">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="h-5 w-5 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
        />
        {t("checkIn.flow.keys.checkDoneBox")}
        <span className="sr-only"> {label}</span>
      </label>
    );
  if (step.type === "amount")
    return (
      <div className="flex h-10 w-40 shrink-0 rounded-xl border border-gray-300 bg-white">
        <span className="flex items-center border-r border-gray-200 px-3 text-xs font-semibold text-gray-500">
          {currency}
        </span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder="0.00"
          aria-label={label}
          className="min-w-0 flex-1 rounded-r-xl px-3 text-sm outline-none"
        />
      </div>
    );
  return (
    <input
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
      placeholder={step.prompt || t("checkIn.flow.keys.checkNote")}
      aria-label={label}
      className="h-10 w-full shrink-0 rounded-xl border border-gray-300 px-3 text-sm sm:w-56"
    />
  );
}
