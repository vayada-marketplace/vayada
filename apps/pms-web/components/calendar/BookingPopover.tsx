"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { differenceInDays, parseISO } from "date-fns";
import { bookingChannelLabel } from "@/lib/bookings/channelLabel";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";
import { useHasPmsPermission } from "@/lib/settings/PmsAccessContext";
import type { CalendarBlock, CalendarBooking } from "@/services/calendar";
import { arrivalTimesService } from "@/services/settings/arrivalTimes";
import CalendarPopover, { PopoverBadge, type PopoverAnchor } from "./CalendarPopover";

const STATUS_KEYS: Record<CalendarBooking["status"], string> = {
  pending: "bookings.statusPending",
  confirmed: "bookings.statusConfirmed",
  checked_in: "bookings.statusCheckedIn",
  in_house: "bookings.statusInHouse",
  awaiting_payment: "bookings.statusAwaitingPayment",
};

function useStayText() {
  const { locale, t } = useTranslation();
  const day = (date: string, weekday = false) =>
    parseISO(date).toLocaleDateString(locale, {
      ...(weekday ? { weekday: "short" as const } : {}),
      month: "short",
      day: "numeric",
    });
  const stay = (from: string, to: string) => {
    const nights = differenceInDays(parseISO(to), parseISO(from));
    return t("calendar.popover.nightsHeader", {
      from: day(from),
      to: day(to),
      nights: `${nights} ${t(nights === 1 ? "common.night" : "common.nights")}`,
    });
  };
  return { day, stay, t };
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right font-medium text-gray-900 min-w-0">{children}</dd>
    </div>
  );
}

/** A booking's popover in the timeline (VAY-2411): its basics, "Open reservation" for the reservation page and
 * "Change room" for the calendar's room tools. */
export default function BookingPopover({
  booking,
  roomLabel,
  anchor,
  onChangeRoom,
  onClose,
}: {
  booking: CalendarBooking;
  /** "#101", or "Unassigned · Suite" for a booking without a room yet. */
  roomLabel: string;
  anchor: PopoverAnchor;
  onChangeRoom: () => void;
  onClose: () => void;
}) {
  const { day, stay, t } = useStayText();
  // The hotel's check-in time from its arrival times, which only staff who manage Booking settings may read; others
  // see the arrival day alone.
  const canReadArrivalTimes = useHasPmsPermission("booking.settings.manage");
  const [checkInTime, setCheckInTime] = useState<string | null>(null);
  useEffect(() => {
    if (!canReadArrivalTimes) return;
    const controller = new AbortController();
    arrivalTimesService
      .load(controller.signal)
      .then((setup) => setCheckInTime(setup.current?.bundle.choices.checkInTime ?? null))
      .catch(() => setCheckInTime(null));
    return () => controller.abort();
  }, [canReadArrivalTimes]);
  const guest = `${booking.guestFirstName} ${booking.guestLastName}`.trim();
  const value = booking.bookingValue;
  const amount = value ? Number(value.amountDecimal) : null;

  return (
    <CalendarPopover
      anchor={anchor}
      label={`${guest} · ${roomLabel}`}
      eyebrow={roomLabel}
      title={stay(booking.checkIn, booking.checkOut)}
      badge={<PopoverBadge tone="blue">{t(STATUS_KEYS[booking.status])}</PopoverBadge>}
      onClose={onClose}
    >
      <dl className="px-4 py-3 text-sm">
        <Detail label={t("calendar.popover.guest")}>{guest}</Detail>
        <Detail label={t("calendar.popover.channel")}>
          {bookingChannelLabel(booking.channel, t)}
        </Detail>
        <Detail label={t("calendar.popover.value")}>
          {value && amount !== null && Number.isFinite(amount)
            ? formatCurrency(amount, value.currency, Number.isInteger(amount) ? 0 : 2)
            : "—"}
          {/* A multi-room reservation's total covers all its rooms. */}
          {value && booking.numberOfRooms > 1 && (
            <span className="block text-[11px] font-normal text-gray-500">
              {t("calendar.popover.forRooms", {
                rooms: t("calendar.bookingDetail.roomsCount", { count: booking.numberOfRooms }),
              })}
            </span>
          )}
        </Detail>
        <Detail label={t("calendar.popover.arrival")}>
          {checkInTime
            ? t("calendar.popover.arrivalAt", {
                date: day(booking.checkIn, true),
                time: checkInTime,
              })
            : day(booking.checkIn, true)}
        </Detail>
      </dl>
      <div className="px-4 pb-3 flex gap-2">
        <Link
          href={`/bookings/${booking.id}`}
          className="flex-1 text-center px-3 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg"
        >
          {t("calendar.popover.openReservation")}
        </Link>
        <button
          type="button"
          onClick={onChangeRoom}
          className="px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg"
        >
          {t("calendar.popover.changeRoom")}
        </button>
      </div>
    </CalendarPopover>
  );
}

/** A block's popover in the timeline (VAY-2411): why the dates are closed, "Unblock dates" after a confirmation and
 * "Edit" for the block window. Linked blocks follow their source, so they offer neither. */
export function BlockPopover({
  block,
  anchor,
  onEdit,
  onUnblock,
  onClose,
}: {
  block: CalendarBlock;
  anchor: PopoverAnchor;
  onEdit: () => void;
  onUnblock: () => Promise<void>;
  onClose: () => void;
}) {
  const { stay, t } = useStayText();
  const [confirming, setConfirming] = useState(false);
  const [unblocking, setUnblocking] = useState(false);
  const [error, setError] = useState("");
  const room = block.roomId
    ? `#${block.roomNumber ?? ""}`
    : t("calendar.blockDetail.roomCount", { count: block.blockedCount });
  const unblock = async () => {
    setUnblocking(true);
    setError("");
    try {
      await onUnblock();
    } catch {
      setError(t("calendar.blockDetail.unblockError"));
      setUnblocking(false);
    }
  };

  return (
    <CalendarPopover
      anchor={anchor}
      label={`${t(block.protected ? "rooms.linked" : "calendar.blocked")} · ${room}`}
      eyebrow={room}
      title={stay(block.startDate, block.endDate)}
      badge={
        <PopoverBadge tone={block.protected ? "gray" : "red"}>
          {t(block.protected ? "rooms.linked" : "calendar.blocked")}
        </PopoverBadge>
      }
      onClose={onClose}
    >
      <div className="px-4 py-3 text-sm text-gray-700 space-y-2">
        <p>
          {block.protected
            ? block.sourceSummary || t("calendar.blockDetail.linkedDescription")
            : block.reason || t("calendar.blockDetail.noReason")}
        </p>
        {block.protected && block.sourceSummary && (
          <p className="text-[13px] text-gray-500">{t("calendar.blockDetail.linkedDescription")}</p>
        )}
        {error && (
          <p role="alert" className="text-[13px] text-red-700">
            {error}
          </p>
        )}
      </div>
      {!block.protected && (
        <div className="px-4 pb-3 flex items-center gap-2">
          {confirming ? (
            <>
              <span className="flex-1 text-[13px] text-gray-700">
                {t("calendar.blockDetail.unblockConfirm")}
              </span>
              <button
                type="button"
                disabled={unblocking}
                onClick={() => setConfirming(false)}
                className="px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg disabled:opacity-50"
              >
                {t("calendar.cancel")}
              </button>
              <button
                type="button"
                disabled={unblocking}
                onClick={unblock}
                className="px-3 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
              >
                {unblocking
                  ? t("calendar.blockDetail.unblocking")
                  : t("calendar.blockDetail.unblock")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="flex-1 px-3 py-2 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg"
              >
                {t("calendar.popover.unblockDates")}
              </button>
              <button
                type="button"
                onClick={onEdit}
                className="px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg"
              >
                {t("calendar.popover.edit")}
              </button>
            </>
          )}
        </div>
      )}
    </CalendarPopover>
  );
}
