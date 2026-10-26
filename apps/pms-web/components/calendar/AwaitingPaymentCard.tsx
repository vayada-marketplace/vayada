"use client";

import Link from "next/link";
import { ClockIcon, XMarkIcon } from "@heroicons/react/24/outline";
import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";
import { AWAITING_PAYMENT_BADGE_CLASS, formatPaymentDeadline } from "@/lib/awaitingPayment";
import type { CalendarBooking } from "@/services/calendar";

/** VAY-2348: what a click on an "awaiting payment" calendar bar shows: the payment deadline, that
 * the rooms are held until then, and the way to the booking to mark the payment received. */
export default function AwaitingPaymentCard({
  booking,
  timeZone,
  onClose,
}: {
  booking: CalendarBooking;
  timeZone: string | null;
  onClose: () => void;
}) {
  const { locale, t } = useTranslation();
  const name = `${booking.guestFirstName} ${booking.guestLastName}`.trim();
  const href = `/bookings/${encodeURIComponent(booking.id)}`;
  const deadline = booking.paymentDeadlineAt;
  // Until the release job runs, a passed deadline can't be marked received any more.
  const passed = !!deadline && Date.now() >= new Date(deadline).getTime();
  return (
    <Modal onClose={onClose} ariaLabel={name}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-gray-900">{name}</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {booking.roomName ? `${booking.roomName} · ` : ""}
            {booking.checkIn} → {booking.checkOut}
            {booking.numberOfRooms > 1 ? ` · ×${booking.numberOfRooms}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="-m-1 rounded p-1 text-gray-400 hover:text-gray-600"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
      <span
        className={`mt-3 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${AWAITING_PAYMENT_BADGE_CLASS}`}
      >
        <ClockIcon className="h-3 w-3" />
        {t("bookings.statusAwaitingPayment")}
      </span>
      {deadline && (
        <p className="mt-2 text-xs font-semibold text-amber-800">
          {t("bookings.payBy", { date: formatPaymentDeadline(deadline, locale, timeZone) })}
        </p>
      )}
      <p className="mt-1 text-xs text-gray-500">
        {t(passed ? "calendar.paymentDeadlinePassed" : "calendar.awaitingPaymentHeld")}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={href}
          className="inline-flex min-h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          {t("calendar.openBooking")}
        </Link>
        {!passed && (
          <Link
            href={`${href}?confirm=payment`}
            className="inline-flex min-h-9 items-center rounded-lg bg-primary-600 px-3 text-sm font-medium text-white hover:bg-primary-700"
          >
            {t(
              booking.paymentMethod === "bank_transfer"
                ? "bookings.detail.markBankTransferReceived"
                : "bookings.detail.markAsPaid",
            )}
          </Link>
        )}
      </div>
    </Modal>
  );
}
