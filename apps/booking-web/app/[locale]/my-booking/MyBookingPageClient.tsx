"use client";

import { formatCheckInTime, formatCheckOutTime } from "@/lib/arrivalTimes";
import { formatStayDate } from "@/lib/utils";
import { Link } from "@/i18n/navigation";
import ApproximateAmountsNote from "@/components/booking/ApproximateAmountsNote";
import RoomSelectionSummary from "@/components/booking/RoomSelectionSummary";
import { useState, useEffect } from "react";
import HotelHeroImage from "@/components/booking/HotelHeroImage";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import BookingNavigation from "@/components/layout/BookingNavigation";
import BookingFooter from "@/components/layout/BookingFooter";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { bookingService, CancelPreview, type BookingLookupResponse } from "@/services/api/booking";
import { ApiError } from "@/services/api/client";
import { readLastBooking } from "@/lib/storage/bookingDraft";
import { isLastingRefusal, useGuestErrorText } from "@/lib/guestError";

/** Today's date (YYYY-MM-DD) in the hotel's time zone. */
function todayIn(timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const part = (type: string) => parts.find((value) => value.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Pending or confirmed, with check-in today or later: the page offers withdraw or cancel. */
const offersCancel = (booking: Pick<BookingLookupResponse, "status" | "checkIn">) =>
  (booking.status === "pending" || booking.status === "confirmed") &&
  booking.checkIn >= new Date().toISOString().slice(0, 10);

/** The whole card payment goes back: decided on the amounts, never on a rounded percentage. */
const fullRefund = (preview: { amountPaid?: number; refundAmount: number }) =>
  (preview.amountPaid ?? 0) > 0 && preview.refundAmount >= (preview.amountPaid ?? 0);

export default function MyBookingPageClient() {
  const t = useTranslations("myBooking");
  const locale = useLocale();
  const tc = useTranslations("common");
  const tr = useTranslations("roomSelection");
  const { hotel } = useHotel();
  const { formatPrice } = useCurrency();
  const errorText = useGuestErrorText();
  const searchParams = useSearchParams();
  const [reference, setReference] = useState("");
  const [email, setEmail] = useState("");
  const [booking, setBooking] = useState<BookingLookupResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const { slug } = useSlug();

  const [cancelPreview, setCancelPreview] = useState<CancelPreview | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  // Why the server won't cancel this booking online; replaces the Cancel button (VAY-2308).
  const [cancelRefusal, setCancelRefusal] = useState("");

  const handleSearch = async (overrideReference?: string, overrideEmail?: string) => {
    const ref = overrideReference ?? reference;
    const em = overrideEmail ?? email;
    if (!ref || !em) return;
    setSearching(true);
    setError("");
    setBooking(null);
    setSuccessMessage("");
    setCancelPreview(null);
    setCancelRefusal("");

    try {
      const result = await bookingService.lookup(slug, ref, em);
      // Ask before the guest clicks: a booking the server won't cancel online says why up front.
      if (result.status === "confirmed" && offersCancel(result)) {
        try {
          setCancelPreview(await bookingService.cancelPreview(slug, result.id, em));
        } catch (err) {
          // Anything else (busy, outage) keeps the button; clicking asks again.
          if (isLastingRefusal(err)) setCancelRefusal(errorText(err));
        }
      }
      setBooking(result);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? t("notFound")
          : err instanceof ApiError && err.status === 429
            ? t("tooManyAttempts")
            : errorText(err, t("lookupUnavailable")),
      );
    } finally {
      setSearching(false);
    }
  };

  // Skip the lookup form when the guest came in from the confirmation
  // email link with ?reference=&email= already populated (VAY-379).
  useEffect(() => {
    const qpRef = searchParams.get("reference");
    const stored = readLastBooking();
    const qpEmail =
      searchParams.get("email") ||
      (stored?.bookingReference === qpRef?.toUpperCase() ? (stored?.guestEmail ?? "") : "");
    if (qpRef && qpEmail) {
      setReference(qpRef.toUpperCase());
      setEmail(qpEmail);
      handleSearch(qpRef.toUpperCase(), qpEmail);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isPending = booking?.status === "pending";
  const isConfirmed = booking?.status === "confirmed";
  const canCancel = !!booking && offersCancel(booking);

  const handleCancelClick = async () => {
    if (!booking) return;

    if (isPending) {
      setShowConfirmDialog(true);
      return;
    }

    // The preview from the lookup; the fee is checked again when cancelling.
    if (cancelPreview) {
      setShowConfirmDialog(true);
      return;
    }
    setLoadingPreview(true);
    setError("");
    try {
      const preview = await bookingService.cancelPreview(slug, booking.id, email);
      setCancelPreview(preview);
      setShowConfirmDialog(true);
    } catch (err) {
      if (isLastingRefusal(err)) setCancelRefusal(errorText(err));
      else setError(errorText(err));
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleConfirmCancel = async () => {
    if (!booking) return;
    setCancelling(true);
    setError("");

    try {
      if (isPending) {
        await bookingService.withdraw(slug, booking.id, email);
        setBooking({ ...booking, status: "cancelled" });
        setSuccessMessage(t("bookingWithdrawn"));
      } else {
        await bookingService.cancel(
          slug,
          booking.id,
          email,
          cancelPreview?.bookedTermsOutcome?.retainedMinor,
        );
        setBooking({ ...booking, status: "cancelled" });
        setSuccessMessage(t("bookingCancelled"));
      }
      setShowConfirmDialog(false);
      setCancelPreview(null);
    } catch (err) {
      setError(errorText(err));
      // The fee may have moved to another tier since the preview: show the current one here.
      if (!isPending) {
        try {
          setCancelPreview(await bookingService.cancelPreview(slug, booking.id, email));
        } catch (previewError) {
          // Keep the shown preview; the error explains why cancelling failed. Once the dialog
          // closes, a lasting refusal takes the Cancel button's place.
          if (isLastingRefusal(previewError)) setCancelRefusal(errorText(previewError));
        }
      }
    } finally {
      setCancelling(false);
    }
  };

  const handleCloseDialog = () => {
    setShowConfirmDialog(false);
    setCancelPreview(null);
    setError("");
  };

  const statusColor: Record<string, string> = {
    confirmed: "text-success-600",
    pending: "text-yellow-600",
    cancelled: "text-red-600",
    // VAY-404 — host-rejected request, distinct from guest cancel.
    declined: "text-red-700",
    expired: "text-gray-500",
  };
  const statusLabels: Record<string, string> = {
    pending: t("pending"),
    confirmed: t("confirmed"),
    checked_in: t("checkedIn"),
    checked_out: t("checkedOut"),
    completed: t("checkedOut"),
    cancelled: t("cancelled"),
    declined: t("declined"),
    expired: t("expired"),
    no_show: t("pastStay"),
  };
  // VAY-2163: the API keeps "confirmed" after check-out unless the hotel checked the guest out,
  // and for no-shows, so a stay whose check-out date has passed gets a neutral name.
  const isPastStay = isConfirmed && !!booking && booking.checkOut < todayIn(hotel.timezone);

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      {/* Mini Hero */}
      <div className="relative h-48 w-full">
        <HotelHeroImage src={hotel.heroImage} alt={hotel.name} sizes={bookingImageSizes.hero} />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/60" />
        <BookingNavigation />
        <div className="absolute inset-0 flex items-center justify-center">
          <h1 className="text-3xl md:text-4xl font-heading italic text-white">{t("title")}</h1>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 sm:px-6 lg:px-8 py-12 flex-1">
        {/* Lookup Form */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-2">{t("lookUp")}</h2>
          <p className="text-sm text-gray-600 mb-6">{t("lookUpDesc")}</p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t("reference")} *
              </label>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value.toUpperCase())}
                placeholder="VAY-XXXXXX"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 bg-gray-50 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400 uppercase tracking-wider"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t("emailAddress")} *
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="john@example.com"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 bg-gray-50 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
              />
            </div>
            <button
              onClick={() => handleSearch()}
              disabled={searching || !reference || !email}
              className="w-full py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {searching ? "..." : t("findBooking")}
            </button>
          </div>

          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Success Message */}
        {successMessage && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            {successMessage}
          </div>
        )}

        {/* Result */}
        {booking && (
          <div className="mt-6 bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center ${
                  booking.status === "cancelled" ||
                  booking.status === "declined" ||
                  booking.status === "expired"
                    ? "bg-red-100"
                    : "bg-success-100"
                }`}
              >
                {booking.status === "cancelled" ||
                booking.status === "declined" ||
                booking.status === "expired" ? (
                  <svg
                    className="w-5 h-5 text-red-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                ) : (
                  <svg
                    className="w-5 h-5 text-success-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </div>
              <div>
                <p className="font-bold text-gray-900">{t("bookingFound")}</p>
                <p
                  className={`text-sm font-medium ${isPastStay ? "text-gray-600" : statusColor[booking.status] || ""}`}
                >
                  {isPastStay ? t("pastStay") : (statusLabels[booking.status] ?? "")}
                </p>
              </div>
            </div>

            <div className="space-y-0 divide-y divide-gray-100">
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("reference")}</span>
                <span className="font-medium text-gray-900 text-sm">
                  {booking.bookingReference}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("hotel")}</span>
                <span className="font-medium text-gray-900 text-sm">{booking.hotelName}</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("room")}</span>
                <span className="font-medium text-gray-900 text-sm">
                  {!booking.roomSelection && booking.numberOfRooms && booking.numberOfRooms > 1
                    ? `${booking.numberOfRooms}× `
                    : ""}
                  {booking.roomName}
                  {booking.mealDescription && (
                    <span className="block text-sm">{booking.mealDescription}</span>
                  )}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("checkIn")}</span>
                <span className="font-medium text-gray-900 text-sm">
                  {formatStayDate(booking.checkIn, locale)}, {formatCheckInTime(hotel)}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("checkOut")}</span>
                <span className="font-medium text-gray-900 text-sm">
                  {formatStayDate(booking.checkOut, locale)}, {formatCheckOutTime(hotel)}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("guests")}</span>
                <span className="font-medium text-gray-900 text-sm">
                  {tc("adults", { count: booking.adults })}
                  {booking.children > 0 && `, ${tc("children", { count: booking.children })}`}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("total")}</span>
                <span className="font-bold text-gray-900">
                  {formatPrice(booking.totalAmount, booking.currency)}
                </span>
              </div>
              <ApproximateAmountsNote currency={booking.currency} />
            </div>

            {booking.roomLines && (
              <div className="mt-5">
                <RoomSelectionSummary
                  lines={booking.roomLines}
                  currency={booking.currency}
                  checkIn={booking.checkIn}
                  timezone={hotel.timezone}
                />
              </div>
            )}
            {isPending &&
              booking.canEditRequest &&
              booking.confirmationToken &&
              (!booking.hostResponseDeadline ||
                Date.parse(booking.hostResponseDeadline) > Date.now()) && (
                <Link
                  href={`/booking/${encodeURIComponent(booking.bookingReference)}/edit-request?token=${encodeURIComponent(booking.confirmationToken)}`}
                  className="mt-6 inline-block rounded-full border border-gray-300 px-6 py-3 font-semibold"
                >
                  {tr("editRequest")}
                </Link>
              )}
            {/* Cancel / Withdraw Button, or why it can't be done online */}
            {canCancel &&
              (cancelRefusal ? (
                <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
                  <p className="text-sm text-gray-700">{cancelRefusal}</p>
                  {hotel.contact.email && (
                    <a
                      href={`mailto:${hotel.contact.email}`}
                      className="mt-4 block w-full py-3 text-center border border-gray-300 bg-white text-gray-700 font-semibold rounded-full hover:bg-gray-100 transition-colors"
                    >
                      {t("contactHotel")}
                    </a>
                  )}
                </div>
              ) : (
                <button
                  onClick={handleCancelClick}
                  disabled={loadingPreview}
                  className="w-full mt-6 py-3 border-2 border-red-300 text-red-600 font-semibold rounded-full hover:bg-red-50 transition-colors disabled:opacity-50"
                >
                  {loadingPreview ? "..." : isPending ? t("withdrawBooking") : t("cancelBooking")}
                </button>
              ))}
          </div>
        )}
      </div>

      {/* Confirmation Dialog Overlay */}
      {showConfirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 mb-3">
              {isPending ? t("withdrawConfirmTitle") : t("cancelConfirmTitle")}
            </h3>

            {/* Refund info for confirmed bookings */}
            {error && (
              <p role="alert" className="mb-4 text-sm text-red-700">
                {error}
              </p>
            )}

            {cancelPreview && !isPending && (
              <div className="mb-4 space-y-2">
                <div
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                    cancelPreview.cancellationFeeAmount === 0 || fullRefund(cancelPreview)
                      ? "bg-green-100 text-green-700"
                      : cancelPreview.refundAmount > 0
                        ? "bg-yellow-100 text-yellow-700"
                        : "bg-red-100 text-red-700"
                  }`}
                >
                  {cancelPreview.cancellationFeeAmount === 0 || fullRefund(cancelPreview)
                    ? t("freeCancellation")
                    : t("cancellationFeeApplies")}
                </div>
                <p className="text-sm text-gray-700">
                  {cancelPreview.amountPaid === 0 && cancelPreview.cancellationFeeAmount === 0
                    ? t("noPaymentToRefund")
                    : cancelPreview.amountPaid === 0 && cancelPreview.cancellationFeeAmount
                      ? // Nothing was paid online: the terms' share is a fee, never a refund.
                        t("unpaidCancellationFee", {
                          amount: formatPrice(
                            cancelPreview.cancellationFeeAmount,
                            cancelPreview.currency,
                          ),
                        })
                      : fullRefund(cancelPreview)
                        ? t("fullRefund", {
                            amount: formatPrice(cancelPreview.refundAmount, cancelPreview.currency),
                          })
                        : cancelPreview.refundAmount > 0
                          ? t("partialRefund", {
                              amount: formatPrice(
                                cancelPreview.refundAmount,
                                cancelPreview.currency,
                              ),
                              // A part refund never reads 0% or 100% (VAY-2205).
                              percentage: Math.min(99, Math.max(1, cancelPreview.refundPercentage)),
                            })
                          : t("noRefund")}
                </p>
              </div>
            )}

            <div className="flex gap-3 mt-6">
              <button
                onClick={handleCloseDialog}
                disabled={cancelling}
                className="flex-1 py-3 border border-gray-300 text-gray-700 font-semibold rounded-full hover:bg-gray-50 transition-colors"
              >
                {t("goBack")}
              </button>
              <button
                onClick={handleConfirmCancel}
                disabled={cancelling}
                className="flex-1 py-3 bg-red-600 text-white font-semibold rounded-full hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {cancelling
                  ? isPending
                    ? t("withdrawing")
                    : t("cancelling")
                  : isPending
                    ? t("confirmWithdraw")
                    : t("confirmCancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      <BookingFooter />
    </div>
  );
}
