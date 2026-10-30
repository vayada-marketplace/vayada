import {
  parseBookingStay,
  parseExtrasRequest,
  type BookingStay,
  type StayExtrasRequest,
} from "@/lib/bookingStay";
import { Booking } from "@/lib/types";
import { bookingWebPublic } from "./client";

export interface BookingLookupResponse extends Booking {
  confirmationToken: string;
  confirmationTokenExpiresAt: string;
}

export interface BankDetails {
  accountHolder: string;
  accountType?: "iban" | "account_number";
  iban: string;
  accountNumber?: string;
  bankName: string;
  swift: string;
}

export interface PaymentSettings {
  payAtPropertyEnabled: boolean;
  onlineCardPayment?: boolean;
  bankTransfer?: boolean;
  paypalEnabled?: boolean;
  paypalEmail?: string;
  paypalPaymentWindowHours?: number;
  bankDetails?: BankDetails;
  xenditPaymentsEnabled?: boolean;
  payAtHotelMethods?: string[];
  freeCancellationDays: number;
  specialRequestsEnabled?: boolean;
  arrivalTimeEnabled?: boolean;
  guestCountEnabled?: boolean;
  phoneRequired?: boolean;
  adultAgeThreshold?: number;
  childrenEnabled?: boolean;
  sameDayBookingsEnabled?: boolean;
  sameDayBookingCutoffTime?: string | null;
  termsText?: string;
  cancellationPolicyText?: string;
  /** Book Direct Benefits (VAY-2072), in the hotel's order. */
  benefits?: string[];
}

export interface BookingStatus {
  status: string;
  paymentStatus: string | null;
  hostResponseDeadline: string | null;
}

export interface CancelPreview {
  amountPaid?: number;
  cancellationFeeAmount?: number;
  refundAmount: number;
  refundPercentage: number;
  freeCancellationDays: number;
  daysUntilCheckIn: number;
  currency: string;
  /** Pricing-v2 stays: what the booked terms keep, in minor units; sent back to confirm the fee. */
  bookedTermsOutcome?: { retainedMinor: string };
  /** VAY-2320: a booking's several rooms, each with what its own terms give back and keep. */
  rooms?: CancelPreviewRoom[];
}

export interface CancelPreviewRoom {
  roomName: string | null;
  rule: "non_refundable" | "free_until_deadline" | "partial_refund";
  refundPercent: number;
  refundAmount: number;
  keptAmount: number;
}

export const bookingService = {
  async withdraw(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    const body = { guestEmail };
    await bookingWebPublic.post(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/withdraw`,
      body,
    );
  },

  async cancelPreview(
    slug: string,
    bookingId: string,
    guestEmail: string,
    signal?: AbortSignal,
  ): Promise<CancelPreview> {
    const body = { guestEmail };
    return bookingWebPublic.post(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/cancel-preview`,
      body,
      { signal },
    );
  },

  async cancel(
    slug: string,
    bookingId: string,
    guestEmail: string,
    expectedCancellationFeeMinor?: string,
  ): Promise<void> {
    const body = {
      guestEmail,
      ...(expectedCancellationFeeMinor ? { expectedCancellationFeeMinor } : {}),
    };
    await bookingWebPublic.post(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/cancel`,
      body,
    );
  },

  async getStatus(slug: string, reference: string, email: string): Promise<BookingStatus> {
    const params = new URLSearchParams({ reference, email });
    return bookingWebPublic.get(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/status?${params}`,
    );
  },

  /** VAY-2360: the booked cancellation terms and, once confirmed, where the guest stays. By the booking's id
   * only. */
  async stay(slug: string, bookingId: string, guestEmail: string): Promise<BookingStay> {
    return parseBookingStay(
      await bookingWebPublic.post(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/stay`,
        { guestEmail },
      ),
    );
  },

  /** VAY-2360 part 3: asks the hotel for these extras; it confirms by email, nothing is charged
   * online. One key per attempt; a second request while one waits is refused (409), never stored twice. */
  async requestExtras(
    slug: string,
    bookingId: string,
    guestEmail: string,
    addonIds: string[],
    attemptKey: string,
  ): Promise<StayExtrasRequest | null> {
    return parseExtrasRequest(
      await bookingWebPublic.post(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/extras-request`,
        { guestEmail, addonIds },
        { headers: { "Idempotency-Key": `booking.extras:${attemptKey}` } },
      ),
    );
  },

  async getPaymentSettings(slug: string): Promise<PaymentSettings> {
    return bookingWebPublic.get<PaymentSettings>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/checkout-config`,
    );
  },

  async getPaymentInstructions(
    slug: string,
    bookingHandle: string,
  ): Promise<{
    paypal: { enabled: boolean; email: string | null; paymentWindowHours: number | null };
  }> {
    return bookingWebPublic.get(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingHandle)}/payment-instructions`,
    );
  },

  async lookup(
    slug: string,
    bookingReference: string,
    guestEmail: string,
  ): Promise<BookingLookupResponse> {
    const body = { bookingReference, guestEmail };
    return bookingWebPublic.post(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/lookup`,
      body,
    );
  },

  async confirmation(
    slug: string,
    bookingReference: string,
    confirmationToken: string,
  ): Promise<Booking> {
    return bookingWebPublic.post(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/confirmation`,
      { bookingReference, confirmationToken },
    );
  },

  // Guest-initiated booking change requests (VAY-379)
  async previewChangeRequest(
    slug: string,
    bookingId: string,
    payload: ChangeRequestPayload,
  ): Promise<ChangeRequestPreview> {
    return bookingWebPublic.post(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/change-request/preview`,
      payload,
    );
  },

  async submitChangeRequest(
    slug: string,
    bookingId: string,
    payload: ChangeRequestPayload,
  ): Promise<BookingChangeRequest> {
    return bookingWebPublic.post(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/change-request`,
      payload,
    );
  },

  async getChangeRequest(
    slug: string,
    bookingId: string,
    email: string,
  ): Promise<BookingChangeRequest | null> {
    const params = new URLSearchParams({ email });
    return bookingWebPublic.get(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/change-request?${params}`,
    );
  },
};

export interface ChangeRequestPayload {
  guestEmail: string;
  checkIn: string;
  checkOut: string;
  addonIds: string[];
  addonQuantities: Record<string, number>;
  addonDates: Record<string, string[]>;
}

export interface ChangeRequestPreview {
  oldTotal: number;
  newTotal: number;
  priceDifference: number;
  currency: string;
  blocked: boolean;
  blockReason: string | null;
  available: boolean;
}

export interface BookingChangeRequest {
  id: string;
  bookingId: string;
  status: "pending" | "approved" | "declined" | "cancelled";
  oldCheckIn: string;
  oldCheckOut: string;
  oldAddonIds: string[];
  oldAddonQuantities: Record<string, number>;
  oldAddonDates: Record<string, string[]>;
  oldTotal: number;
  requestedCheckIn: string;
  requestedCheckOut: string;
  requestedAddonIds: string[];
  requestedAddonQuantities: Record<string, number>;
  requestedAddonDates: Record<string, string[]>;
  requestedAddonNames: string[];
  newTotal: number;
  priceDifference: number;
  currency: string;
  declineReason: string | null;
  decidedAt: string | null;
  createdAt: string;
}
