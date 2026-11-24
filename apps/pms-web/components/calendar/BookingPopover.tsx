"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { differenceInDays, parseISO } from "date-fns";
import { bookingChannelLabel } from "@/lib/bookings/channelLabel";
import { nightlyPriceSummary, priceDigits } from "@/lib/bookings/nightlyPrices";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";
import { useGuestStayTimes } from "@/lib/settings/useGuestStayTimes";
import type { CalendarBlock, CalendarBooking } from "@/services/calendar";
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
  const nightCount = (nights: number) =>
    `${nights} ${t(nights === 1 ? "common.night" : "common.nights")}`;
  const stay = (from: string, to: string) =>
    t("calendar.popover.nightsHeader", {
      from: day(from),
      to: day(to),
      nights: nightCount(differenceInDays(parseISO(to), parseISO(from))),
    });
  return { day, nightCount, stay, t };
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
  /** None opens a bottom sheet (the phone calendar). */
  anchor?: PopoverAnchor;
  onChangeRoom: () => void;
  onClose: () => void;
}) {
  const { day, nightCount, stay, t } = useStayText();
  const [showNights, setShowNights] = useState(false);
  const nightsId = useId();
  // The check-in time guests see; staff who can't read it see the arrival day alone.
  const checkInTime = useGuestStayTimes()?.checkInTime ?? null;
  const guest = `${booking.guestFirstName} ${booking.guestLastName}`.trim();
  const value = booking.bookingValue;
  const amount = value ? Number(value.amountDecimal) : null;
  // VAY-2576: the booked price per night, for the whole booking like its value.
  const prices = nightlyPriceSummary(
    value && amount !== null ? { amount, currency: value.currency } : null,
    booking.stayNights ?? differenceInDays(parseISO(booking.checkOut), parseISO(booking.checkIn)),
    booking.bookedNights,
  );
  const nights = prices?.nights ?? null;
  const listDigits = prices
    ? priceDigits(
        prices.currency,
        prices.total,
        prices.feesAndExtras ?? 0,
        ...(nights ?? []).map((night) => night.amount),
      )
    : 0;
  const listPrice = (price: number) =>
    prices ? formatCurrency(price, prices.currency, listDigits) : "";
  // "{amount} avg" / "Ø {amount}": the amount in bold, the word around it in grey.
  const [averageBefore = "", averageAfter = ""] = t("calendar.popover.averagePrice", {
    amount: "{amount}",
  }).split("{amount}");
  // A multi-room reservation's total covers all its rooms.
  const forRooms = booking.numberOfRooms > 1 && (
    <span className="block text-[11px] font-normal text-gray-500">
      {t("calendar.popover.forRooms", {
        rooms: t("calendar.bookingDetail.roomsCount", { count: booking.numberOfRooms }),
      })}
    </span>
  );

  return (
    <CalendarPopover
      anchor={anchor}
      label={`${guest} · ${roomLabel}`}
      eyebrow={roomLabel}
      title={stay(booking.checkIn, booking.checkOut)}
      badge={<PopoverBadge tone="blue">{t(STATUS_KEYS[booking.status])}</PopoverBadge>}
      onClose={onClose}
    >
      <div className="px-4 py-3 text-sm">
        <dl>
          <Detail label={t("calendar.popover.guest")}>{guest}</Detail>
          <Detail label={t("calendar.popover.channel")}>
            {bookingChannelLabel(booking.channel, t)}
          </Detail>
          <Detail label={t("calendar.popover.value")}>
            <span className="font-semibold">
              {value && amount !== null && Number.isFinite(amount)
                ? formatCurrency(amount, value.currency, Number.isInteger(amount) ? 0 : 2)
                : "—"}
            </span>
            {value && forRooms}
          </Detail>
          <Detail label={t("calendar.popover.pricePerNight")}>
            {prices ? (
              <span className="tabular-nums">
                {averageBefore && (
                  <span className="font-normal text-gray-500">{averageBefore}</span>
                )}
                {formatCurrency(
                  prices.average,
                  prices.currency,
                  priceDigits(prices.currency, prices.average),
                )}
                {averageAfter && <span className="font-normal text-gray-500">{averageAfter}</span>}
              </span>
            ) : (
              "—"
            )}
            {prices && forRooms}
          </Detail>
        </dl>
        {nights && (
          <div className="flex justify-end">
            <button
              type="button"
              aria-expanded={showNights}
              aria-controls={nightsId}
              onClick={() => setShowNights((shown) => !shown)}
              className="inline-flex min-h-[28px] items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
            >
              {t(
                showNights ? "calendar.popover.hideNightlyRates" : "calendar.popover.showNightlyRates",
              )}
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
              >
                <path d={showNights ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
              </svg>
            </button>
          </div>
        )}
        {prices && nights && showNights && (
          <div
            id={nightsId}
            className="mt-1 mb-2 rounded-lg border border-gray-200 bg-slate-50 px-3 py-1.5 text-[13px] tabular-nums"
          >
            {/* Fourteen nights fit; a longer stay scrolls its nights, and the total stays in view. */}
            <ul className="max-h-[308px] overflow-y-auto">
              {nights.map((night) => (
                <li key={night.date} className="flex justify-between gap-3 py-px">
                  <span className="text-gray-700">{day(night.date, true)}</span>
                  <span className="font-medium text-gray-900">{listPrice(night.amount)}</span>
                </li>
              ))}
            </ul>
            {prices.feesAndExtras !== null && (
              <div className="flex justify-between gap-3 py-px">
                <span className="text-gray-700">{t("calendar.popover.feesAndExtras")}</span>
                <span className="font-medium text-gray-900">
                  {listPrice(prices.feesAndExtras)}
                </span>
              </div>
            )}
            <div className="mt-1 flex justify-between gap-3 border-t border-gray-200 pt-2 pb-0.5 font-semibold text-gray-900">
              <span>{`${t("calendar.popover.total")} · ${nightCount(nights.length)}`}</span>
              <span>{listPrice(prices.total)}</span>
            </div>
          </div>
        )}
        <dl>
          <Detail label={t("calendar.popover.arrival")}>
            {checkInTime
              ? t("calendar.popover.arrivalAt", {
                  date: day(booking.checkIn, true),
                  time: checkInTime,
                })
              : day(booking.checkIn, true)}
          </Detail>
        </dl>
      </div>
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
  /** None opens a bottom sheet (the phone calendar). */
  anchor?: PopoverAnchor;
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
