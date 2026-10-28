"use client";
import ApproximateAmountsNote from "@/components/booking/ApproximateAmountsNote";
import RoomSelectionSummary from "@/components/booking/RoomSelectionSummary";
import BookedRoomsList, { useBookedRoomLine } from "@/components/booking/BookedRoomsList";
import ConfirmationCancellation from "@/components/booking/ConfirmationCancellation";
import ConfirmationExtras from "@/components/booking/ConfirmationExtras";
import ConfirmationHotelCard from "@/components/booking/ConfirmationHotelCard";
import StayDates from "@/components/booking/StayDates";
import StayRange from "@/components/booking/StayRange";
import {
  bookedPolicyBlocks,
  isManualPricingPaymentMethod,
} from "@vayada/domain-booking/replacement-pricing";

import { formatCheckInTime, formatCheckOutTime } from "@/lib/arrivalTimes";
import { bookedMeal, singleRoomMeal } from "@/lib/bookedMeal";
import type { BookingStay } from "@/lib/bookingStay";
import { stayCalendarFile } from "@/lib/calendarFile";
import { hotelCountryName } from "@/lib/checkoutTerms";
import {
  directionsUrl,
  groupReference,
  paymentLine,
  type PaymentWay,
} from "@/lib/confirmationDisplay";
import { directPerks } from "@/lib/directPerks";
import { fetchGuestNearby } from "@/lib/nearbyPlaces";
import { hotelToday } from "@/lib/roomChoices";
import { serverNow } from "@/lib/serverClock";
import { resolveLocale } from "@/lib/utils";
import { useState, useEffect, useId, useRef, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { paymentMethodLabelKey, type PaymentMethodLabelKey } from "@vayada/locale-constants";
import { Link, useRouter } from "@/i18n/navigation";
import BookingNavigation from "@/components/layout/BookingNavigation";
import BookingFooter from "@/components/layout/BookingFooter";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { Booking } from "@/lib/types";
import { bookingService, type BookingChangeRequest } from "@/services/api/booking";
import { ApiError } from "@/services/api/client";
import { quoteMoneyAmount } from "@/services/api/replacementOffers";
import {
  readGuestDetails,
  readLastBooking,
  saveLastBooking,
  toConfirmationBooking,
} from "@/lib/storage/bookingDraft";

// Stay details are asked for by the booking's id only (VAY-2360), as the API stores it.
const STAY_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** "Waiting for our reply · 17h 59m 58s left"; it ticks on its own so the page doesn't re-render. */
function PendingStatus({
  deadline,
  label,
  left,
}: {
  deadline?: string | null;
  label: string;
  left: (time: string) => string;
}) {
  const [timeLeft, setTimeLeft] = useState<string | null>(null);

  useEffect(() => {
    if (!deadline) return;
    const update = () => {
      const diff = new Date(deadline).getTime() - Date.now();
      if (!(diff > 0)) {
        setTimeLeft(null);
        return;
      }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      setTimeLeft(`${hours}h ${minutes}m ${seconds}s`);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  return <>{deadline && timeLeft ? `${label} · ${left(timeLeft)}` : label}</>;
}

function displayCardBrand(brand: string): string {
  return brand.charAt(0).toUpperCase() + brand.slice(1).replaceAll("_", " ");
}

function formatPropertyDateTime(value: string, locale: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(resolveLocale(locale), {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timeZone || "UTC",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function formatPropertyDate(value: string, locale: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(resolveLocale(locale), {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: timeZone || "UTC",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// Heroicons (outline, 24px) for the next steps and the payment line.
const ICONS = {
  card: "M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z",
  cash: "M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z",
  mail: "M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75",
  pencil:
    "m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10",
  ticket:
    "M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 0 1 0 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 0 1 0-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375Z",
  home: "m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25",
  cross: "M6 18 18 6M6 6l12 12",
  calendar:
    "M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5",
} as const;

function Icon({ name, className }: { name: keyof typeof ICONS; className: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

const labelClass = "text-xs font-semibold uppercase tracking-[0.08em] text-gray-500";

/** One next step: an icon, what it does, and a hint; a link or a button. */
function StepRow({
  icon,
  title,
  hint,
  danger = false,
  href,
  onClick,
  disabled,
}: {
  icon: keyof typeof ICONS;
  title: string;
  hint?: string;
  danger?: boolean;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const body = (
    <>
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${danger ? "bg-error-50 text-error-700" : "bg-primary-50 text-primary-700"}`}
      >
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`font-semibold ${danger ? "text-error-700" : "text-gray-900"}`}>
          {title}
        </span>
        {hint && <span className="text-sm text-gray-500">{hint}</span>}
      </span>
      <svg
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-gray-400"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
      </svg>
    </>
  );
  const className =
    "flex w-full items-center gap-3.5 px-5 py-3 text-left transition-colors hover:bg-gray-50 disabled:opacity-50";
  return href?.startsWith("https:") ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {body}
    </a>
  ) : href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} disabled={disabled} className={className}>
      {body}
    </button>
  );
}

export default function BookingConfirmationPageClient({
  reference,
  emailParam,
  tokenParam,
}: {
  reference: string;
  emailParam?: string;
  tokenParam?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const t = useTranslations("confirmation");
  const locale = useLocale();
  const tc = useTranslations("common");
  const tp = useTranslations("payment");
  const tm = useTranslations("myBooking");
  const th = useTranslations("home");
  const roomLine = useBookedRoomLine();
  const withdrawTitleId = useId();
  const withdrawDialog = useRef<HTMLDialogElement>(null);
  const { hotel } = useHotel();
  const { slug } = useSlug();
  const { formatPrice } = useCurrency();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [status, setStatus] = useState<string>("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false);
  const [withdrawError, setWithdrawError] = useState("");
  const [hydrateError, setHydrateError] = useState(false);
  const [changeRequest, setChangeRequest] = useState<BookingChangeRequest | null>(null);
  const [copied, setCopied] = useState(false);
  // VAY-2360: the booked terms and places of this booking (by id), and the hotel's direct-booking perks.
  // `details` null: the read failed, so the page shows what it did before.
  const [stay, setStay] = useState<{ id: string; details: BookingStay | null } | null>(null);
  // Bumped to read the stay again, e.g. when an extras request was refused as out of date.
  const [stayReads, setStayReads] = useState(0);
  const [benefits, setBenefits] = useState<string[]>([]);
  const [hasTips, setHasTips] = useState(false);
  const confirmationLookup = useRef<Promise<Booking | null> | null>(null);
  const [paypalInfo, setPaypalInfo] = useState<{
    email: string;
    windowHours: number;
  } | null>(null);

  // Use the saved booking on refresh.
  useEffect(() => {
    setHydrateError(false);
    const stored = readLastBooking();
    if (
      stored &&
      stored.bookingReference === reference &&
      !(stored.paymentMethod === "bank_transfer" && tokenParam)
    ) {
      const guest = readGuestDetails();
      const normalized = toConfirmationBooking(stored, {
        hotelName: hotel.name,
        guestFirstName: guest?.guestFirstName,
        guestLastName: guest?.guestLastName,
        guestEmail: guest?.guestEmail || emailParam,
      });
      setBooking(normalized);
      setStatus(normalized.status);
      saveLastBooking(normalized);
      return;
    }

    if (tokenParam) {
      let cancelled = false;
      confirmationLookup.current ??= (async () => {
        for (let attempt = 0; attempt < 15; attempt += 1) {
          try {
            return await bookingService.confirmation(slug, reference, tokenParam);
          } catch (error) {
            if (error instanceof ApiError && error.status !== 409 && error.status < 500) {
              return null;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        return null;
      })();
      void confirmationLookup.current.then((fetched) => {
        if (cancelled) return;
        if (!fetched) {
          setHydrateError(true);
          return;
        }
        const normalized = toConfirmationBooking(fetched, { hotelName: hotel.name });
        setBooking(normalized);
        setStatus(normalized.status);
        saveLastBooking(normalized);
      });
      return () => {
        cancelled = true;
      };
    }

    // A confirmation-email link carries the guest email so the stored booking
    // can be hydrated on another device without exposing it by reference alone.
    const email = emailParam;
    if (!email) {
      // Nothing to load the booking with: say so instead of an empty ticket.
      setHydrateError(true);
      return;
    }

    let cancelled = false;
    bookingService
      .lookup(slug, reference, email)
      .then((fetched) => {
        if (cancelled) return;
        const normalized = toConfirmationBooking(fetched, {
          hotelName: hotel.name,
          guestEmail: email,
        });
        setBooking(normalized);
        setStatus(normalized.status);
        saveLastBooking(normalized);
      })
      .catch(() => {
        if (cancelled) return;
        setHydrateError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [reference, emailParam, tokenParam, hotel.name, slug]);

  useEffect(() => {
    if (booking?.paymentMethod !== "paypal") return;
    bookingService
      .getPaymentInstructions(slug, booking.id || booking.bookingReference)
      .then((instructions) => {
        if (instructions.paypal.enabled && instructions.paypal.email) {
          setPaypalInfo({
            email: instructions.paypal.email,
            windowHours: instructions.paypal.paymentWindowHours || 24,
          });
        }
      })
      .catch(() => {});
  }, [booking?.id, booking?.bookingReference, booking?.paymentMethod, slug]);

  // Fetch any existing change request once we know the booking + email.
  useEffect(() => {
    const email = booking?.guestEmail || emailParam;
    if (!booking?.id || !email) return;
    let cancelled = false;
    bookingService
      .getChangeRequest(slug, booking.id, email)
      .then((cr) => {
        if (!cancelled) setChangeRequest(cr);
      })
      .catch(() => {
        /* 404 / network — leave null */
      });
    return () => {
      cancelled = true;
    };
  }, [booking?.id, booking?.guestEmail, emailParam, slug]);

  // VAY-2360: what the ticket and the hotel card add, for a booking known by its id; a status change (the
  // hotel accepts) reloads it. Extras only: without them the page shows what it did before.
  const stayEmail = (booking?.guestEmail || emailParam || "").trim();
  useEffect(() => {
    const id = booking?.id;
    if (!id || !stayEmail || !STAY_ID.test(id)) return;
    let cancelled = false;
    bookingService
      .stay(slug, id, stayEmail)
      .then((details) => {
        if (!cancelled) setStay({ id, details });
      })
      .catch(() => {
        if (!cancelled) setStay({ id, details: null });
      });
    return () => {
      cancelled = true;
    };
  }, [booking?.id, booking?.status, stayEmail, slug, stayReads]);

  // The hotel's local tips (our own API, no Google): Directions opens "Around {hotel}" when there are some.
  useEffect(() => {
    if (!slug) return;
    const controller = new AbortController();
    fetchGuestNearby(slug, controller.signal)
      .then((nearby) => setHasTips(nearby.places.length > 0))
      .catch(() => {});
    return () => controller.abort();
  }, [slug]);

  useEffect(() => {
    if (status !== "confirmed") return;
    let cancelled = false;
    bookingService
      .getPaymentSettings(slug)
      .then((settings) => {
        if (!cancelled) setBenefits(Array.isArray(settings.benefits) ? settings.benefits : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status, slug]);

  // Poll for status updates every 30s when pending
  useEffect(() => {
    if (status !== "pending" || !booking?.guestEmail) return;

    const poll = async () => {
      try {
        const result = await bookingService.getStatus(slug, reference, booking.guestEmail);
        if (result.status !== status || result.canEditRequest !== booking.canEditRequest) {
          setStatus(result.status);
          const updated = {
            ...booking,
            status: result.status as Booking["status"],
            canEditRequest: result.canEditRequest,
          };
          setBooking(updated);
          saveLastBooking(updated);
          // VAY-2307: an answered request may have charged or released the card, so reload what
          // the payment line says; the polled status stays if that fails.
          if (result.status !== status) {
            void bookingService
              .lookup(slug, reference, booking.guestEmail)
              .then((fetched) => {
                const reloaded = toConfirmationBooking(fetched, {
                  hotelName: hotel.name,
                  guestEmail: booking.guestEmail,
                });
                // Only a full answer for this booking replaces what the poll showed.
                if (reloaded.bookingReference !== booking.bookingReference) return;
                setStatus(reloaded.status);
                setBooking(reloaded);
                saveLastBooking(reloaded);
              })
              .catch(() => {});
          }
        }
      } catch {
        // Ignore polling errors
      }
    };

    const interval = setInterval(poll, 30000);
    return () => clearInterval(interval);
  }, [status, booking, slug, reference, hotel.name]);

  const handleWithdraw = async () => {
    if (!booking) return;
    setWithdrawing(true);
    setWithdrawError("");

    try {
      await bookingService.withdraw(slug, booking.id, booking.guestEmail);
      setConfirmingWithdraw(false);
      setStatus("cancelled");
      const updated = { ...booking, status: "cancelled" as const };
      setBooking(updated);
      saveLastBooking(updated);
    } catch (err: unknown) {
      setWithdrawError(
        err instanceof Error && err.message ? err.message : "Failed to withdraw booking",
      );
    } finally {
      setWithdrawing(false);
    }
  };

  const handleEdit = async () => {
    if (!booking) return;
    setEditing(true);
    setWithdrawError("");
    try {
      const token =
        tokenParam ||
        (await bookingService.lookup(slug, reference, booking.guestEmail)).confirmationToken;
      router.push(
        `/booking/${encodeURIComponent(reference)}/edit-request?token=${encodeURIComponent(token)}`,
      );
    } catch (error) {
      setWithdrawError(error instanceof Error ? error.message : "Unable to edit request.");
    } finally {
      setEditing(false);
    }
  };

  const copyReference = () => {
    void navigator.clipboard
      ?.writeText(reference)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // The reference stays on screen to copy by hand.
      });
  };

  const isPending = status === "pending";
  const isConfirmed = status === "confirmed";
  const isCheckedIn = status === "checked_in";
  const isCheckedOut = status === "checked_out";
  const isCancelled = status === "cancelled";
  // VAY-404: host-rejected request. Shares the cancelled look but uses different copy so the guest
  // doesn't think they cancelled.
  const isDeclined = status === "declined";
  const isExpired = status === "expired";
  const isEnded = isCancelled || isDeclined || isExpired;
  // A native modal dialog traps focus, closes on Escape and returns focus to Withdraw. It also
  // closes if a status update ends the request while it is open.
  const showWithdrawDialog = confirmingWithdraw && isPending;
  useEffect(() => {
    const element = withdrawDialog.current;
    if (showWithdrawDialog && element && !element.open) element.showModal();
    if (!showWithdrawDialog && element?.open) element.close();
  }, [showWithdrawDialog]);
  const displayedNights =
    booking && Number.isInteger(booking.nights) && booking.nights > 0 ? booking.nights : null;
  const displayedAdults =
    booking && Number.isInteger(booking.adults) && booking.adults >= 0 ? booking.adults : null;
  const displayedChildren =
    booking && Number.isInteger(booking.children) && booking.children >= 0 ? booking.children : 0;
  const displayedRooms =
    booking?.numberOfRooms && Number.isInteger(booking.numberOfRooms) && booking.numberOfRooms > 0
      ? booking.numberOfRooms
      : 1;
  const guestEmail = (booking?.guestEmail || emailParam || "").trim();
  const guestName = booking?.guestFirstName?.trim();
  const manageBookingHref = `/my-booking?reference=${encodeURIComponent(reference)}`;
  const paymentMethodLabels: Record<PaymentMethodLabelKey, string> = {
    card: t("manualCard"),
    creditCard: t("creditCard"),
    payAtProperty: tp("payAtProperty"),
    bankTransfer: tp("bankTransfer"),
    cash: t("cash"),
    manualCard: t("manualCard"),
    paypal: "PayPal",
    xendit: tp("xenditTitle"),
    other: t("otherPayment"),
  };
  const owed = booking?.balanceAmount;
  const paid = booking?.paymentStatus === "captured" || booking?.paymentStatus === "paid";
  // VAY-2163: a card deposit comes back as partially_paid, with what's still owed as the balance.
  // A bank transfer's remainder is paid by transfer (see the transfer box), not at check-in.
  const partlyPaid =
    !!booking &&
    booking.paymentMethod !== "bank_transfer" &&
    (booking.paymentStatus === "partially_paid" || (paid && (owed ?? 0) > 0));
  const isTotalPaid = paid && !partlyPaid;
  const displayedTotal =
    isEnded || isTotalPaid || partlyPaid ? booking?.totalAmount : (owed ?? booking?.totalAmount);
  const paymentStatusLabels: Record<string, string> = {
    paid: t("paymentPaid"),
    partially_paid: t("paymentPartlyPaid"),
    authorized: t("paymentAuthorized"),
    unpaid: t("paymentUnpaid"),
    refunded: t("paymentRefunded"),
    failed: t("paymentFailed"),
    waived: t("paymentWaived"),
  };
  const paymentStatusKey = partlyPaid ? "partially_paid" : paid ? "paid" : booking?.paymentStatus;
  const methodKey = booking?.paymentMethod
    ? paymentMethodLabelKey(booking.paymentMethod)
    : undefined;
  const way: PaymentWay =
    !methodKey || methodKey === "other"
      ? null
      : methodKey === "card"
        ? "card"
        : methodKey === "payAtProperty"
          ? "at_hotel"
          : "named";
  const cardDetails =
    way === "card" && booking?.cardBrand && booking.cardLast4
      ? `${displayCardBrand(booking.cardBrand)} •••• ${booking.cardLast4}`
      : null;
  const method = cardDetails ?? (methodKey ? paymentMethodLabels[methodKey] : "");
  const payment = paymentLine({
    ended: isEnded,
    pending: isPending,
    arrived: isCheckedIn || isCheckedOut,
    way,
    status: paymentStatusKey,
  });
  // A card without brand and last four digits gets its own sentence ("Paid by card").
  const cardTitles = {
    paidWith: "paidByCard",
    partlyPaidWith: "partlyPaidByCard",
    heldOn: "heldOnCard",
    refundedTo: "refundedToCard",
  } as const;
  const statusText = paymentStatusKey ? paymentStatusLabels[paymentStatusKey] : undefined;
  const paymentTitle =
    payment.title === "status"
      ? statusText
      : payment.title === "method"
        ? method
        : payment.title === "payAtHotel"
          ? tp("payAtProperty")
          : payment.title && way === "card" && !cardDetails && payment.title in cardTitles
            ? t(cardTitles[payment.title as keyof typeof cardTitles])
            : payment.title
              ? t(payment.title, { method })
              : undefined;
  const paymentDetail =
    payment.detail === "status" ? statusText : payment.detail ? t(payment.detail) : undefined;
  const amount = payment.amountLabel === "total" ? booking?.totalAmount : displayedTotal;
  const amountLabel = payment.amountLabel
    ? t(payment.amountLabel)
    : isEnded || partlyPaid
      ? t("total")
      : isTotalPaid
        ? t("totalPaid")
        : t("totalDue");

  const statusPill = isPending
    ? {
        tone: "bg-warning-100 text-warning-800",
        dot: "bg-warning-600",
        text: (
          <PendingStatus
            deadline={booking?.hostResponseDeadline}
            label={t("statusPending")}
            left={(time) => t("timeLeft", { time })}
          />
        ),
      }
    : isConfirmed || isCheckedIn || isCheckedOut
      ? {
          tone: "bg-success-100 text-success-800",
          dot: "bg-success-600",
          text: t(
            isConfirmed ? "statusConfirmed" : isCheckedIn ? "statusCheckedIn" : "statusCheckedOut",
          ),
        }
      : isEnded
        ? {
            tone: "bg-error-100 text-error-800",
            dot: "bg-error-600",
            text: t(
              isCancelled ? "statusCancelled" : isDeclined ? "statusDeclined" : "statusExpired",
            ),
          }
        : null;
  const heading = isPending
    ? guestName
      ? t("requestSent", { name: guestName })
      : t("requestSentNoName")
    : isConfirmed
      ? guestName
        ? t("allSet", { name: guestName })
        : t("allSetNoName")
      : isCheckedIn
        ? t("checkedInTitle")
        : isCheckedOut
          ? t("checkedOutTitle")
          : isCancelled
            ? t("cancelledHeading")
            : isDeclined
              ? t("declinedTitle")
              : isExpired
                ? t("expiredTitle")
                : null;
  // Whole sentences, so no JSX whitespace can go missing between them.
  const subtitle = isPending
    ? booking?.hostResponseDeadline
      ? t("replyBy", {
          deadline: formatPropertyDateTime(booking.hostResponseDeadline, locale, hotel.timezone),
        })
      : t("pendingSubtitle")
    : isConfirmed
      ? [
          t("confirmedSubtitle", { hotel: hotel.name }),
          booking && guestEmail ? t("detailsSent", { email: guestEmail }) : "",
        ]
          .filter(Boolean)
          .join(" ")
      : isCheckedIn
        ? t("checkedInSubtitle")
        : isCheckedOut
          ? t("checkedOutSubtitle")
          : isCancelled
            ? booking?.cancelledAt
              ? t("cancelledOnDate", {
                  date: formatPropertyDate(booking.cancelledAt, locale, hotel.timezone),
                })
              : t("cancelledSubtitle")
            : isDeclined
              ? booking?.paymentMethod === "card"
                ? t("declinedCardSubtitle")
                : t("declinedSubtitle")
              : isExpired
                ? t("expiredSubtitle")
                : null;

  const checkInTime = formatCheckInTime(hotel);
  const checkOutTime = formatCheckOutTime(hotel);
  const phone = hotel.contact.phone?.trim();
  const whatsappDigits = hotel.contact.whatsapp?.replace(/\D/g, "");
  const contactLinks = [
    hotel.contact.email && { label: t("contactEmail"), href: `mailto:${hotel.contact.email}` },
    phone && { label: t("contactCall"), href: `tel:${phone.replace(/\s+/g, "")}` },
    whatsappDigits && { label: t("contactWhatsApp"), href: `https://wa.me/${whatsappDigits}` },
  ].filter((link): link is { label: string; href: string } => !!link);
  const canEdit =
    isPending &&
    !!booking?.canEditRequest &&
    (!booking.hostResponseDeadline || Date.parse(booking.hostResponseDeadline) > Date.now());
  const details = stay && booking && stay.id === booking.id ? stay.details : null;
  // The stay details have answered (or can't be asked for): until then no terms show anywhere.
  const stayKnown = !!booking && (!STAY_ID.test(booking.id) || stay?.id === booking.id);
  // The booked terms, judged against the hotel's date today, as the cancel route does (VAY-2360).
  // An unpaid PayPal stay is released without its money and can be withdrawn for free: no line.
  const policyBlocks =
    booking &&
    details?.cancellation &&
    (isPending || isConfirmed) &&
    !(isPending && booking.paymentMethod === "paypal")
      ? bookedPolicyBlocks(details.cancellation, {
          today: hotelToday(details.cancellation.timeZone, new Date(serverNow())),
          request: isPending && !isManualPricingPaymentMethod(booking.paymentMethod),
          card: booking.paymentMethod === "card",
          bankTransfer:
            booking.paymentMethod === "bank_transfer" &&
            !["paid", "partially_paid"].includes(booking.paymentStatus ?? ""),
        })
      : [];
  const policyCurrency = details?.cancellation?.currency ?? booking?.currency ?? "";
  const perks = isConfirmed ? directPerks(benefits, (key) => t(`perk.${key}`)) : [];
  // Each room's own terms show whenever the ticket has no cancellation line.
  const roomTerms = stayKnown && policyBlocks.length === 0;
  const bookedRoom = booking?.bookedRooms?.length === 1 ? booking.bookedRooms[0] : undefined;
  const meal = !booking
    ? null
    : bookedRoom
      ? roomLine(bookedRoom, {
          checkIn: booking.checkIn,
          timezone: hotel.timezone,
          terms: roomTerms,
        }) || null
      : bookedMeal(singleRoomMeal(booking), {
          noMeals: t("noMeals"),
          meal: (plan) => th(`choice.meal.${plan}`),
        });

  const stayDates =
    booking && [booking.checkIn, booking.checkOut].every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      ? { checkIn: booking.checkIn, checkOut: booking.checkOut }
      : null;
  // VAY-2307: the stay as an .ics file made here in the browser; nothing new on the server.
  const addToCalendar = () => {
    if (!stayDates) return;
    const file = stayCalendarFile({
      reference,
      title: hotel.name,
      location: hotel.location || undefined,
      ...stayDates,
      notes: [
        checkInTime && `${t("checkIn")}: ${checkInTime}`,
        checkOutTime && `${t("checkOut")}: ${checkOutTime}`,
        `${t("bookingReference")}: ${reference}`,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    const url = URL.createObjectURL(new Blob([file], { type: "text/calendar;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${reference}.ics`;
    link.click();
    // iOS Safari asks before it downloads and reads the file only then, so keep it a minute.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const contact = contactLinks.length > 0 && (
    <div className="flex items-start gap-3.5 px-5 py-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700">
        <Icon name="mail" className="h-5 w-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col">
          <span className="font-semibold text-gray-900">
            {t("contactHotel", { hotel: hotel.name })}
          </span>
          <span className="text-sm text-gray-500">{t("contactHint")}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {contactLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              {...(link.href.startsWith("https:")
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
              className="flex h-8 items-center rounded-full border border-gray-300 px-3 text-sm font-semibold text-primary-700 transition-colors hover:bg-gray-50"
            >
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );

  let steps: ReactNode;
  if (isPending) {
    steps = (
      <>
        {canEdit && (
          <StepRow
            icon="pencil"
            title={editing ? t("opening") : t("editRequest")}
            hint={t("editRequestHint")}
            onClick={handleEdit}
            disabled={editing || withdrawing}
          />
        )}
        <StepRow
          icon="cross"
          danger
          title={t("withdrawRequest")}
          hint={booking?.paymentMethod === "card" ? t("withdrawHint") : undefined}
          onClick={() => {
            setWithdrawError("");
            setConfirmingWithdraw(true);
          }}
          disabled={withdrawing || editing}
        />
        {contact}
      </>
    );
  } else if (isEnded) {
    steps = (
      <>
        <StepRow
          icon="home"
          title={t("bookAgain")}
          hint={t("bookAgainHint", { hotel: hotel.name })}
          href="/"
        />
        {contact}
      </>
    );
  } else {
    steps = (
      <>
        {isConfirmed && stayDates && (
          <StepRow icon="calendar" title={t("addToCalendar")} onClick={addToCalendar} />
        )}
        {contact}
        {/* No "Request changes": guest date changes can't be repriced online yet (VAY-2110). */}
        <StepRow
          icon="ticket"
          title={isConfirmed ? t("manageOrCancel") : t("manageBooking")}
          hint={isConfirmed ? t("manageHint") : undefined}
          href={manageBookingHref}
        />
      </>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-accent">
      <BookingNavigation solid />

      {/* VAY-2360: one 1440×900 screen on a desktop; on a phone the ticket, then the hotel and next steps. */}
      <main className="mx-auto grid w-full max-w-[1104px] flex-1 items-start gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_1fr] lg:gap-x-10 lg:gap-y-5 lg:px-8 lg:py-9">
        <div className="flex min-w-0 flex-col gap-5">
          {/* Status */}
          {!heading && <h1 className="sr-only">{t("bookingReference")}</h1>}
          {(statusPill || heading) && (
            <div className="flex flex-col gap-3">
              {(statusPill || perks.length > 0) && (
                <div className="flex flex-wrap items-center gap-2">
                  {statusPill && (
                    <p
                      className={`flex items-center gap-2 rounded-full px-3 py-1 text-[13px] font-semibold tracking-[0.02em] ${statusPill.tone}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 rounded-full ${statusPill.dot}`}
                      />
                      {statusPill.text}
                    </p>
                  )}
                  {perks.length > 0 && (
                    <p
                      className="flex items-start gap-1.5 rounded-[14px] border border-success-200 bg-success-50 px-3 py-[5px] text-[13px] font-semibold leading-[18px] text-success-800 sm:rounded-full"
                      data-testid="direct-perks"
                    >
                      <svg
                        aria-hidden="true"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        viewBox="0 0 24 24"
                      >
                        <path d="m4.5 12.75 6 6 9-13.5" />
                      </svg>
                      <span>{[t("bookedDirect"), ...perks].join(" · ")}</span>
                    </p>
                  )}
                </div>
              )}
              {heading && (
                <h1 className="font-heading text-[34px] font-bold leading-10 tracking-[-0.02em] text-gray-900 sm:text-5xl lg:text-[48px] lg:leading-[56px]">
                  {heading}
                </h1>
              )}
              {subtitle && (
                <p className="text-base text-gray-600 sm:text-[17px] sm:leading-[26px]">
                  {subtitle}
                </p>
              )}
            </div>
          )}

          {/* Ticket */}
          <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white sm:rounded-[20px]">
            {!booking ? (
              <p className="px-5 py-8 text-center text-sm text-gray-600 sm:px-9">
                {hydrateError
                  ? t("detailsUnavailable") || "We couldn't load your booking details here."
                  : t("loadingDetails") || "Loading booking details…"}
              </p>
            ) : (
              <>
                <StayDates
                  checkIn={booking.checkIn}
                  checkOut={booking.checkOut}
                  checkInTime={
                    checkInTime
                      ? hotel.checkInUntil
                        ? checkInTime
                        : t("fromTime", { time: checkInTime })
                      : undefined
                  }
                  checkOutTime={
                    checkOutTime
                      ? hotel.checkOutFrom
                        ? checkOutTime
                        : t("untilTime", { time: checkOutTime })
                      : undefined
                  }
                  nights={displayedNights}
                  ended={isEnded}
                  labelClass={labelClass}
                />

                <div className="flex flex-col gap-4 border-t border-dashed border-gray-300 px-[18px] py-4 sm:px-7 sm:py-[18px]">
                  {/* VAY-2320: a group's rooms, each with its own guests and terms. */}
                  {booking.bookedRooms && booking.bookedRooms.length > 1 ? (
                    <BookedRoomsList
                      rooms={booking.bookedRooms}
                      checkIn={booking.checkIn}
                      timezone={hotel.timezone}
                      labelClass={labelClass}
                      terms={roomTerms}
                    />
                  ) : (
                    <div className="flex flex-col gap-4 sm:flex-row sm:gap-8">
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className={labelClass}>{t("room")}</span>
                        <span className="truncate font-semibold text-gray-900 sm:text-base">
                          {`${!booking.roomSelection && displayedRooms > 1 ? `${displayedRooms}× ` : ""}${booking.roomName || t("room")}`}
                        </span>
                        {meal && <span className="text-sm text-gray-600">{meal}</span>}
                      </div>
                      <div className="flex flex-col gap-1 sm:w-44 sm:shrink-0">
                        <span className={labelClass}>{t("guests")}</span>
                        <span className="font-semibold text-gray-900 sm:text-[17px]">
                          {displayedAdults !== null
                            ? `${tc("adults", { count: displayedAdults })}${displayedChildren > 0 ? `, ${tc("children", { count: displayedChildren })}` : ""}`
                            : "—"}
                        </span>
                        {displayedRooms > 1 && (
                          <span className="text-sm text-gray-600">
                            {tc("room", { count: displayedRooms })}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {booking.roomLines && (
                    <RoomSelectionSummary
                      lines={booking.roomLines}
                      currency={booking.currency}
                      checkIn={booking.checkIn}
                      country={hotel.country}
                    />
                  )}
                  {booking.addonIds && booking.addonIds.length > 0 && (
                    <div className="flex flex-col gap-1" data-testid="confirmation-addons">
                      <span className={labelClass}>{t("addons") || "Add-ons"}</span>
                      <ul className="space-y-1">
                        {booking.addonIds.map((addonId, idx) => {
                          const qty =
                            (booking.addonQuantities?.[addonId] ?? 1) *
                            (booking.addonPackageQuantities?.[addonId] ?? 1);
                          const name = booking.addonNames?.[idx] || addonId;
                          return (
                            <li key={addonId} className="font-medium text-gray-900">
                              {name}
                              {qty && qty > 1 ? (
                                <span className="ml-2 font-normal text-gray-500">× {qty}</span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-3 border-t border-gray-100 px-[18px] py-4 sm:px-7 sm:py-[18px]">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                    <div className="flex items-baseline justify-between gap-3 sm:order-last sm:flex-col sm:items-end sm:gap-0.5">
                      <span className={labelClass}>{amountLabel}</span>
                      <span
                        className={`font-heading text-2xl font-semibold lining-nums tabular-nums sm:text-[28px] sm:leading-[34px] ${isEnded ? "text-gray-500" : "text-gray-900"}`}
                      >
                        {amount !== undefined ? formatPrice(amount, booking.currency) : "—"}
                      </span>
                    </div>
                    {(paymentTitle || paymentDetail) && (
                      <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
                        <span className="flex h-8 w-11 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 sm:h-9 sm:w-12">
                          <Icon name={way === "card" ? "card" : "cash"} className="h-5 w-5" />
                        </span>
                        <span className="flex min-w-0 flex-col">
                          {paymentTitle && (
                            <span className="font-semibold text-gray-900 sm:text-[17px]">
                              {paymentTitle}
                            </span>
                          )}
                          {paymentDetail && (
                            <span className="text-sm text-gray-600 sm:text-[15px]">
                              {paymentDetail}
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                  {(isPending || isConfirmed) && (partlyPaid || booking.depositRequired) && (
                    <div className="space-y-2 rounded-xl bg-gray-50 p-4 text-sm">
                      <div className="flex justify-between gap-4">
                        <span className="text-gray-600">
                          {partlyPaid || paid
                            ? t("depositPaid")
                            : booking.paymentStatus === "refunded"
                              ? t("depositRefunded")
                              : t("depositPending")}
                        </span>
                        <span className="font-semibold text-gray-900">
                          {formatPrice(
                            partlyPaid && owed !== undefined
                              ? booking.totalAmount - owed
                              : booking.depositAmount || 0,
                            booking.currency,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-gray-600">{t("balanceDueAtCheckIn")}</span>
                        <span className="font-semibold text-gray-900">
                          {formatPrice(booking.balanceAmount || 0, booking.currency)}
                        </span>
                      </div>
                    </div>
                  )}
                  <ApproximateAmountsNote currency={booking.currency} />
                </div>
                {policyBlocks.length > 0 && (
                  <ConfirmationCancellation
                    blocks={policyBlocks}
                    formatMoney={(minor) =>
                      formatPrice(quoteMoneyAmount(minor, policyCurrency), policyCurrency)
                    }
                    lineMoney={(minor) =>
                      new Intl.NumberFormat("en-GB", {
                        style: "currency",
                        currency: policyCurrency,
                        minimumFractionDigits: 0,
                      }).format(quoteMoneyAmount(minor, policyCurrency))
                    }
                    manageHref={manageBookingHref}
                  />
                )}
              </>
            )}

            <div className="flex items-end gap-3 border-t border-dashed border-gray-300 bg-gray-50 px-[18px] py-3.5 sm:items-center sm:gap-4 sm:px-7">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className={labelClass}>{t("bookingReference")}</span>
                <span className="break-words text-base font-semibold tabular-nums tracking-[0.06em] text-primary-700 sm:text-lg">
                  {groupReference(reference)}
                </span>
              </div>
              <button
                type="button"
                onClick={copyReference}
                aria-label={t("copyReference")}
                className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-gray-300 bg-white px-4 text-sm font-semibold text-primary-700 transition-colors hover:bg-gray-50"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                >
                  <rect x="9" y="9" width="12" height="12" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span aria-live="polite">{copied ? t("copied") : t("copy")}</span>
              </button>
            </div>
          </section>

          {/* VAY-2360 part 3: extras the guest asks us for after booking. */}
          {booking && isConfirmed && details?.extras && (
            <ConfirmationExtras
              extras={details.extras}
              formatMoney={(minor, currency) =>
                formatPrice(quoteMoneyAmount(minor, currency), currency)
              }
              onRequest={(addonIds) =>
                bookingService.requestExtras(
                  slug,
                  booking.id,
                  stayEmail,
                  addonIds,
                  typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                )
              }
              onStale={() => setStayReads((reads) => reads + 1)}
            />
          )}

          {(isPending || isConfirmed) &&
            booking?.paymentMethod === "bank_transfer" &&
            ["unpaid", "pending", "partially_paid"].includes(booking.paymentStatus ?? "") && (
              <div className="rounded-2xl border border-info-200 bg-info-50 p-5">
                <p className="text-sm font-semibold text-info-800">{t("bankTransferPending")}</p>
                {booking.bankTransferDetails ? (
                  <p className="mt-2 whitespace-pre-line text-sm text-info-800">
                    {booking.bankTransferDetails}
                  </p>
                ) : (
                  <Link
                    href={manageBookingHref}
                    className="mt-2 inline-block text-sm text-info-800 underline"
                  >
                    {t("manageBooking")}
                  </Link>
                )}
                {booking.paymentDeadline && (
                  <p className="mt-3 text-xs text-info-700">
                    {t("paymentDeadline")}:{" "}
                    {formatPropertyDateTime(booking.paymentDeadline, locale, hotel.timezone)}
                  </p>
                )}
              </div>
            )}

          {isPending && booking?.paymentMethod === "paypal" && paypalInfo && (
            <div className="rounded-2xl border border-info-200 bg-info-50 p-5">
              <p className="text-sm font-semibold text-info-800">{t("paypalPending")}</p>
              <p className="mt-1 text-xs text-info-700">
                {t("paypalInstructions", {
                  amount: formatPrice(booking.totalAmount, booking.currency),
                  email: paypalInfo.email,
                  reference: booking.bookingReference,
                  hours: paypalInfo.windowHours,
                })}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(paypalInfo.email)}
                  className="rounded-lg border border-info-200 bg-white px-3 py-1.5 text-xs font-semibold text-info-700"
                >
                  {t("copyEmail")}
                </button>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(booking.bookingReference)}
                  className="rounded-lg border border-info-200 bg-white px-3 py-1.5 text-xs font-semibold text-info-700"
                >
                  {t("copyReference")}
                </button>
              </div>
            </div>
          )}

          {/* Change request status (VAY-379) */}
          {changeRequest && changeRequest.status === "pending" && (
            <div className="rounded-2xl border border-info-200 bg-info-50 p-5">
              <p className="text-sm font-semibold text-info-800">
                {t("changePending") || "Change request pending approval"}
              </p>
              <p className="mt-1 text-xs text-info-700">
                {t("changePendingDesc") ||
                  "We'll review your requested change and email you once we respond."}
              </p>
              <p className="mt-2 text-xs text-info-700">
                <StayRange
                  checkIn={changeRequest.requestedCheckIn}
                  checkOut={changeRequest.requestedCheckOut}
                  locale={locale}
                />
                {" · "}
                {changeRequest.priceDifference > 0
                  ? `+${formatPrice(changeRequest.priceDifference, changeRequest.currency)}`
                  : formatPrice(changeRequest.priceDifference, changeRequest.currency)}
              </p>
            </div>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-5 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <ConfirmationHotelCard
            name={hotel.name}
            heroImage={hotel.heroImage}
            aroundHref={
              hasTips && !isEnded ? `/booking/${encodeURIComponent(reference)}/around` : undefined
            }
            places={details?.places ?? []}
            fallback={{
              address:
                [hotel.location, hotelCountryName(hotel.country, locale)]
                  .filter(Boolean)
                  .join(", ") || null,
              directionsUrl:
                !isEnded && hotel.mapPin
                  ? directionsUrl(hotel.mapPin, hotel.name, hotel.location)
                  : null,
            }}
          />
          <div className="flex flex-col gap-2">
            <h2 className={`${labelClass} px-1 pb-1`}>{t("nextSteps")}</h2>
            <div className="flex flex-col divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white py-1.5 lg:rounded-[20px]">
              {steps}
              {withdrawError && !confirmingWithdraw && (
                <p role="alert" className="px-5 py-3 text-sm text-error-700">
                  {withdrawError}
                </p>
              )}
            </div>
          </div>
        </aside>
        {!isEnded && (
          <Link
            href="/"
            className="flex items-center gap-2 self-start pl-1 font-semibold text-primary-700 hover:underline lg:col-start-1 lg:row-start-2"
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"
              />
            </svg>
            {t("backToHotel", { property: hotel.name })}
          </Link>
        )}
      </main>

      {/* Withdraw asks first, like My Booking (VAY-2163) */}
      <dialog
        ref={withdrawDialog}
        aria-labelledby={withdrawTitleId}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl bg-white p-6 shadow-xl backdrop:bg-black/50"
        onCancel={(event) => {
          if (withdrawing) event.preventDefault();
        }}
        onClose={() => {
          setConfirmingWithdraw(false);
          setWithdrawError("");
        }}
      >
        <h3 id={withdrawTitleId} className="text-lg font-bold text-gray-900 mb-3">
          {tm("withdrawConfirmTitle")}
        </h3>
        {withdrawError && (
          <p role="alert" className="mb-4 text-sm text-red-700">
            {withdrawError}
          </p>
        )}
        <div className="flex gap-3 mt-6">
          <button
            type="button"
            autoFocus
            onClick={() => withdrawDialog.current?.close()}
            disabled={withdrawing}
            className="flex-1 py-3 border border-gray-300 text-gray-700 font-semibold rounded-full hover:bg-gray-50 transition-colors"
          >
            {tm("goBack")}
          </button>
          <button
            type="button"
            onClick={handleWithdraw}
            disabled={withdrawing}
            className="flex-1 py-3 bg-red-600 text-white font-semibold rounded-full hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {withdrawing ? t("withdrawing") : tm("confirmWithdraw")}
          </button>
        </div>
      </dialog>

      <BookingFooter />
    </div>
  );
}
