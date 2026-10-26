"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { trapFocus } from "@/components/Modal";
import { ChatBubbleOvalLeftEllipsisIcon, CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { Booking, BookingAdditionalGuest, GuestRegistration } from "@/services/bookings";
import type { CheckinSettings } from "@/services/settings";
import {
  bookingAmountDue,
  expectedPaymentMethodLabel,
} from "@/components/bookings/BookingStaySummary";
import { bookingChannelLabel } from "@/lib/bookings/channelLabel";
import {
  expectedRegistrations,
  registrationGuests,
  registrationSummary,
  type RegistrationGuest,
} from "@/lib/checkin/registration";
import { countLabel, stayRangeLabel } from "@/lib/checkin/labels";
import { checkinRooms } from "@/lib/checkin/rooms";
import { formatPropertyDate } from "@/lib/dashboardBookings";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";

type Translate = ReturnType<typeof useTranslation>["t"];
type Status = "warn" | "ok" | "info";

/** Starts a lower-case fragment ("paid in full") with a capital when nothing comes before it. */
function sentence(parts: Array<string | null>, locale: string): string {
  const text = parts.filter(Boolean).join(" · ");
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** Who is still missing what: "Grace Hopper’s ID is missing · Guest 3 and Guest 4 have no details yet". */
function registrationDetail(
  incomplete: RegistrationGuest[],
  guests: RegistrationGuest[],
  locale: string,
  t: Translate,
): string {
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  const named = (guest: RegistrationGuest) => Boolean(`${guest.firstName}${guest.lastName}`.trim());
  const name = (guest: RegistrationGuest) =>
    named(guest)
      ? `${guest.firstName} ${guest.lastName}`.trim()
      : t("dashboard.popup.guestNumber", { number: guests.indexOf(guest) + 1 });
  const groups: Array<[string, RegistrationGuest[]]> = [
    ["idMissing", incomplete.filter((guest) => guest.status === "id_missing")],
    [
      "detailsMissing",
      incomplete.filter((guest) => guest.status === "details_missing" && named(guest)),
    ],
    [
      "noDetails",
      incomplete.filter((guest) => guest.status === "details_missing" && !named(guest)),
    ],
  ];
  return groups
    .filter(([, members]) => members.length > 0)
    .map(([key, members]) =>
      t(`dashboard.popup.${key}${members.length === 1 ? "One" : "Many"}`, {
        names: list.format(members.map(name)),
      }),
    )
    .join(" · ");
}

/** VAY-2372: what the desk needs before a guest's check-in, as approved in Paper (p-16-0). */
export function ArrivalPopup({
  booking,
  additionalGuests,
  registrations,
  settings,
  loading,
  arrivalTime,
  today,
  onClose,
}: {
  booking: Booking;
  additionalGuests: BookingAdditionalGuest[];
  /** Null when the registrations couldn't be read. */
  registrations: GuestRegistration[] | null;
  settings: CheckinSettings;
  loading: boolean;
  arrivalTime: string;
  today: string;
  onClose: () => void;
}) {
  const { locale, t } = useTranslation();
  const titleId = useId();
  const isFuture = booking.checkIn > today;
  const rooms = checkinRooms(booking);

  const panelRef = useRef<HTMLDivElement>(null);
  // Like the shared Modal: focus moves into the dialog, Tab stays inside, and focus goes back to
  // the guest row on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const guests = registrations
    ? registrationGuests({ booking, additionalGuests, registrations, settings })
    : [];
  const summary = registrationSummary(guests, expectedRegistrations(booking, settings));
  const registration: { status: Status; title: string; detail: string } = loading
    ? { status: "info", title: t("dashboard.popup.registration"), detail: t("common.loading") }
    : !registrations
      ? {
          status: "warn",
          title: t("dashboard.popup.registration"),
          detail: t("dashboard.popup.registrationUnavailable"),
        }
      : {
          status: summary.incomplete.length ? "warn" : "ok",
          title: t("dashboard.guestsRegistered", {
            registered: summary.registered,
            total: summary.total,
          }),
          detail: summary.incomplete.length
            ? registrationDetail(summary.incomplete, guests, locale, t)
            : t("dashboard.popup.everyoneRegistered"),
        };

  const { due } = bookingAmountDue(booking);
  const paidSoFar = Math.max(0, booking.totalAmount - due);
  const method =
    booking.expectedPaymentMethod === "unknown"
      ? null
      : expectedPaymentMethodLabel(booking.expectedPaymentMethod, t);
  const payment: { status: Status; title: string; detail: string } =
    booking.amountStatus === "unverified"
      ? {
          status: "warn",
          title: t("dashboard.popup.amountUnverified"),
          detail: t("dashboard.popup.amountUnverifiedHint"),
        }
      : due > 0
        ? {
            status: "warn",
            title: t("dashboard.popup.amountDue", {
              amount: formatCurrency(due, booking.currency),
            }),
            detail: sentence(
              [
                method,
                paidSoFar > 0
                  ? t("dashboard.popup.paidSoFar", {
                      amount: formatCurrency(paidSoFar, booking.currency),
                    })
                  : t("dashboard.popup.nothingPaidYet"),
              ],
              locale,
            ),
          }
        : {
            status: "ok",
            title: t("dashboard.popup.nothingToPay"),
            detail: sentence([method, t("dashboard.popup.paidInFull")], locale),
          };

  const facts = [
    countLabel(t, "nights", booking.nights),
    countLabel(t, "adults", booking.adults),
    ...(booking.children > 0 ? [countLabel(t, "children", booking.children)] : []),
    countLabel(t, "rooms", rooms.length),
  ].join(" · ");

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-gray-950/40 md:items-center md:p-6"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => trapFocus(event, panelRef.current, onClose)}
        className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none md:max-h-[90dvh] md:w-[680px] md:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-col gap-5 overflow-y-auto px-4 pb-5 pt-3.5 md:px-7 md:pb-6 md:pt-7">
          <div aria-hidden="true" className="mx-auto h-1 w-10 rounded-full bg-gray-300 md:hidden" />
          <div className="flex items-start gap-4">
            <span
              aria-hidden="true"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-50 text-base font-bold text-primary-800 md:h-[52px] md:w-[52px]"
            >
              {`${booking.guestFirstName[0] ?? ""}${booking.guestLastName[0] ?? ""}`.toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <h2
                id={titleId}
                className="truncate text-[22px] font-extrabold leading-7 text-gray-900"
              >
                {`${booking.guestFirstName} ${booking.guestLastName}`.trim()}
              </h2>
              <p className="text-sm text-gray-500">
                {booking.bookingReference} · {bookingChannelLabel(booking.channel, t)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                    isFuture ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"
                  }`}
                >
                  {isFuture
                    ? t("dashboard.popup.arrivesOn", {
                        date: formatPropertyDate(
                          booking.checkIn,
                          { month: "short", day: "numeric", year: "numeric" },
                          locale,
                        ),
                      })
                    : t("dashboard.popup.arrivingToday", { time: arrivalTime })}
                </span>
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
                  {facts}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-gray-200 text-gray-700 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <XMarkIcon className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          </div>

          <section className="flex flex-col gap-2.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
              {t("dashboard.popup.beforeCheckIn")}
            </h3>
            <ul className="divide-y divide-gray-200 overflow-hidden rounded-[14px] border border-gray-200">
              <PopupRow {...registration} />
              <PopupRow {...payment} />
              {booking.specialRequests.trim() && (
                <PopupRow
                  status="info"
                  title={t("dashboard.popup.specialRequest")}
                  detail={booking.specialRequests}
                  highlight
                />
              )}
            </ul>
          </section>

          <section className="flex flex-col gap-2.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
              {t("dashboard.popup.rooms")}
            </h3>
            <ul className="flex flex-col gap-2.5">
              {rooms.map((room) => (
                <li
                  key={room.key}
                  className="flex items-center gap-3 rounded-[14px] border border-gray-200 px-4 py-3.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] leading-5">
                      <span className="font-bold text-gray-900">
                        {room.unit
                          ? t("dashboard.popup.roomNumber", { number: room.unit })
                          : t("dashboard.popup.noRoom")}
                      </span>
                      {room.guests != null && (
                        <span className="text-gray-600">
                          {" · "}
                          {countLabel(t, "guests", room.guests)}
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-gray-600">{room.type}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[15px] font-bold leading-5 text-gray-900">
                      {stayRangeLabel(locale, room.checkIn, room.checkOut)}
                    </p>
                    <p
                      className={`text-sm ${
                        room.departsEarlier ? "font-semibold text-amber-700" : "text-gray-600"
                      }`}
                    >
                      {countLabel(t, "nights", room.nights)}
                      {room.departsEarlier && ` · ${t("dashboard.popup.leavesEarlier")}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="flex flex-col gap-2.5 border-t border-gray-200 px-4 pb-7 pt-4 md:flex-row md:gap-3 md:px-7 md:py-5">
          {!isFuture && (
            <Link
              href={`/check-in/${booking.id}`}
              className="flex h-[50px] items-center justify-center rounded-xl bg-primary-600 px-5 text-sm font-semibold text-white hover:bg-primary-700 md:order-2 md:flex-1"
            >
              {t("dashboard.popup.startCheckIn")}
            </Link>
          )}
          <Link
            href={`/bookings/${booking.id}`}
            className={`flex h-[50px] items-center justify-center rounded-xl border border-gray-200 px-5 text-sm font-semibold text-gray-700 hover:bg-gray-50 md:order-1 ${
              isFuture ? "md:flex-1" : ""
            }`}
          >
            {t("dashboard.popup.viewBooking")}
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PopupRow({
  status,
  title,
  detail,
  highlight = false,
}: {
  status: Status;
  title: string;
  detail: string;
  highlight?: boolean;
}) {
  return (
    <li className={`flex items-center gap-3.5 px-4 py-3.5 ${highlight ? "bg-amber-50" : ""}`}>
      <span
        aria-hidden="true"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
          status === "warn"
            ? "bg-amber-100 text-amber-700"
            : status === "ok"
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-600"
        }`}
      >
        {status === "warn" ? (
          "!"
        ) : status === "ok" ? (
          <CheckIcon className="h-4 w-4" />
        ) : (
          <ChatBubbleOvalLeftEllipsisIcon className="h-4 w-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-bold leading-5 text-gray-900">{title}</p>
        <p className="line-clamp-2 text-sm text-gray-600">{detail}</p>
      </div>
    </li>
  );
}
