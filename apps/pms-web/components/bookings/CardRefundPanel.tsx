"use client";

import { useState } from "react";
import Link from "next/link";
import Modal from "@/components/Modal";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";
import { bookingsService, type Booking, type BookingCardRefund } from "@/services/bookings";

type Translate = ReturnType<typeof useTranslation>["t"];

/** Stripe's refund failure reason, in plain words (VAY-2205, approved by Flamur 2026-10-18). */
function reasonText(reason: string | null, t: Translate) {
  if (reason === "expired_or_canceled_card")
    return t("bookings.detail.cardRefund.reasonExpiredCard");
  if (reason === "lost_or_stolen_card") return t("bookings.detail.cardRefund.reasonLostCard");
  if (reason === "insufficient_funds")
    return t("bookings.detail.cardRefund.reasonInsufficientFunds");
  return t("bookings.detail.cardRefund.reasonOther");
}

const STYLES: Record<BookingCardRefund["status"], { box: string; icon: string; badge: string }> = {
  pending: {
    box: "border-amber-200 bg-amber-50",
    icon: "bg-amber-100 text-amber-700",
    badge: "border-amber-300 text-amber-700",
  },
  succeeded: {
    box: "border-emerald-200 bg-emerald-50",
    icon: "bg-emerald-100 text-emerald-700",
    badge: "border-emerald-300 text-emerald-700",
  },
  failed: {
    box: "border-red-200 bg-red-50",
    icon: "bg-red-100 text-red-700",
    badge: "border-red-300 text-red-700",
  },
};

const ICONS: Record<BookingCardRefund["status"], string> = {
  pending: "M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z",
  succeeded: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
  failed:
    "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z",
};

/** The refund back to the guest's card after a paid card stay was cancelled: on its way, done, or
 * failed with Stripe's reason and a retry (VAY-2205 P1.7, as drawn in Paper and approved by Flamur
 * on 2026-10-18). */
export function CardRefundPanel({
  booking,
  messageGuestHref,
  onRetried,
}: {
  booking: Pick<
    Booking,
    "id" | "cardRefund" | "totalAmount" | "currency" | "guestFirstName" | "guestLastName"
  >;
  /** The guest's conversation, when the hotel can message them here. */
  messageGuestHref?: string | null;
  onRetried: () => Promise<void> | void;
}) {
  const { t, locale } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refund = booking.cardRefund;
  if (!refund) return null;

  const amount = formatCurrency(Number(refund.amount), refund.currency, 2);
  const amountOf = t("bookings.detail.cardRefund.amountOf", {
    amount,
    total: formatCurrency(booking.totalAmount, booking.currency, 2),
  });
  const when = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const byGuest = refund.requestedBy === "guest";
  const settled = refund.settledAt ?? refund.createdAt;
  const detail =
    refund.status === "pending"
      ? [
          amountOf,
          byGuest
            ? t("bookings.detail.cardRefund.guestCancelledOn", { date: when(refund.createdAt) })
            : t("bookings.detail.cardRefund.hostCancelledOn", { date: when(refund.createdAt) }),
        ]
      : [
          amountOf,
          when(settled),
          refund.status === "failed"
            ? reasonText(refund.failureReason, t)
            : byGuest
              ? t("bookings.detail.cardRefund.guestCancelled")
              : t("bookings.detail.cardRefund.hostCancelled"),
        ];
  const style = STYLES[refund.status];
  const title =
    refund.status === "pending"
      ? t("bookings.detail.cardRefund.pendingTitle")
      : refund.status === "succeeded"
        ? t("bookings.detail.cardRefund.succeededTitle")
        : t("bookings.detail.cardRefund.failedTitle");
  const guest = `${booking.guestFirstName} ${booking.guestLastName}`.trim();

  const retry = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const result = await bookingsService.retryCardRefund(booking.id, crypto.randomUUID());
      if (result.status === "busy") setError(t("bookings.detail.cardRefund.retryBusy"));
      await onRetried();
    } catch {
      setError(t("bookings.detail.cardRefund.retryError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={title} className={`mt-4 rounded-xl border p-4 text-sm ${style.box}`}>
      <div className="flex items-start gap-3">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${style.icon}`}
          aria-hidden="true"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d={ICONS[refund.status]}
            />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="font-semibold text-gray-900">{title}</p>
            <span
              className={`shrink-0 rounded-full border bg-white px-2.5 py-0.5 text-xs font-medium ${style.badge}`}
            >
              {refund.status === "pending"
                ? t("bookings.detail.cardRefund.badgePending")
                : refund.status === "succeeded"
                  ? t("bookings.detail.cardRefund.badgeSucceeded")
                  : t("bookings.detail.cardRefund.badgeFailed")}
            </span>
          </div>
          <p className="mt-1 text-gray-600">{detail.join(" · ")}</p>
          {refund.status === "failed" && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(true)}
                className="inline-flex min-h-9 items-center rounded-md bg-gray-900 px-3.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {t("bookings.detail.cardRefund.retry")}
              </button>
              {messageGuestHref && (
                <Link
                  href={messageGuestHref}
                  className="inline-flex min-h-9 items-center rounded-md border border-gray-300 bg-white px-3.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                  {t("bookings.detail.messageGuest")}
                </Link>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-2 text-red-700">
              {error}
            </p>
          )}
          <p className="mt-3 text-xs text-gray-600">
            {refund.status === "pending"
              ? t("bookings.detail.cardRefund.pendingNote")
              : refund.status === "succeeded"
                ? t("bookings.detail.cardRefund.succeededNote", { amount })
                : t("bookings.detail.cardRefund.failedNote")}
          </p>
        </div>
      </div>
      {confirming && (
        <Modal
          onClose={() => setConfirming(false)}
          ariaLabel={t("bookings.detail.cardRefund.retryTitle")}
        >
          <h3 className="mb-2 text-lg font-semibold text-gray-900">
            {t("bookings.detail.cardRefund.retryTitle")}
          </h3>
          <p className="mb-6 text-sm text-gray-600">
            {t("bookings.detail.cardRefund.retryMessage", { amount, guest })}
          </p>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              {t("bookings.detail.cardRefund.cancel")}
            </button>
            <button
              type="button"
              onClick={retry}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
            >
              {t("bookings.detail.cardRefund.retry")}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
