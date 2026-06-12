import { Booking } from "@/lib/types";
import { ApiError, bookingWebPublic, pmsApi } from "./client";

export interface BookingRequestResponse {
  // For card payments (VAY-388) `booking` is a placeholder preview —
  // status === 'draft' and id is empty until Stripe authorizes the card.
  // For other payment methods it's a real persisted booking.
  booking: Booking;
  clientSecret: string | null;
  xenditInvoiceUrl: string | null;
  paymentMethod: string;
  // Soft-hold draft id, present when paymentMethod === 'card'. Pass it
  // to confirmAuthorization() after Stripe.confirmPayment resolves.
  draftId?: string;
  bookingReference?: string;
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
  sameDayBookingsEnabled?: boolean;
  sameDayBookingCutoffTime?: string | null;
  termsText?: string;
  cancellationPolicyText?: string;
}

export interface BookingStatus {
  status: string;
  paymentStatus: string | null;
  hostResponseDeadline: string | null;
}

export interface CancelPreview {
  refundAmount: number;
  refundPercentage: number;
  freeCancellationDays: number;
  daysUntilCheckIn: number;
  currency: string;
}

export const bookingService = {
  async create(
    slug: string,
    data: {
      roomTypeId: string;
      guestFirstName: string;
      guestLastName: string;
      guestEmail: string;
      guestPhone: string;
      guestCountry?: string;
      specialRequests?: string;
      estimatedArrivalTime?: string;
      numberOfGuests?: number;
      checkIn: string;
      checkOut: string;
      adults: number;
      children: number;
      numberOfRooms?: number;
      referralCode?: string;
      paymentMethod?: string;
      rateType?: string;
      addonIds?: string[];
      addonQuantities?: Record<string, number>;
      addonDates?: Record<string, string[]>;
      promoCode?: string;
    },
  ): Promise<BookingRequestResponse> {
    try {
      return await bookingWebPublic.post(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings`,
        data,
      );
    } catch (err) {
      if (!shouldFallbackToPms(err)) throw err;
      return pmsApi.post(`/api/hotels/${encodeURIComponent(slug)}/bookings`, data);
    }
  },

  // Materializes the soft-hold draft into a real booking row after
  // Stripe authorizes the card. Returns the booking so the caller can
  // redirect with a real reference. Idempotent: a second call after the
  // Stripe webhook has already materialized the draft returns the same
  // booking. Accepts a draft id (VAY-388) or a legacy booking id.
  async confirmAuthorization(slug: string, handle: string): Promise<Booking> {
    try {
      return await bookingWebPublic.post(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(handle)}/confirm-authorization`,
      );
    } catch (err) {
      if (!shouldFallbackToPms(err)) throw err;
      return pmsApi.post(
        `/api/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(handle)}/confirm-authorization`,
      );
    }
  },

  async withdraw(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    const body = { guestEmail };
    try {
      await bookingWebPublic.post(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/withdraw`,
        body,
      );
    } catch (err) {
      if (!shouldFallbackToPms(err)) throw err;
      await pmsApi.post(
        `/api/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/withdraw`,
        body,
      );
    }
  },

  async cancelPreview(slug: string, bookingId: string, guestEmail: string): Promise<CancelPreview> {
    const body = { guestEmail };
    try {
      return await bookingWebPublic.post(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/cancel-preview`,
        body,
      );
    } catch (err) {
      if (!shouldFallbackToPms(err)) throw err;
      return pmsApi.post(
        `/api/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/cancel-preview`,
        body,
      );
    }
  },

  async cancel(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    const body = { guestEmail };
    try {
      await bookingWebPublic.post(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/cancel`,
        body,
      );
    } catch (err) {
      if (!shouldFallbackToPms(err)) throw err;
      await pmsApi.post(
        `/api/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/cancel`,
        body,
      );
    }
  },

  async getStatus(slug: string, reference: string, email: string): Promise<BookingStatus> {
    const params = new URLSearchParams({ reference, email });
    try {
      return await bookingWebPublic.get(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/status?${params}`,
      );
    } catch {
      return pmsApi.get(`/api/hotels/${encodeURIComponent(slug)}/bookings/status?${params}`);
    }
  },

  async getPaymentSettings(slug: string): Promise<PaymentSettings> {
    try {
      return await bookingWebPublic.get<PaymentSettings>(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/checkout-config`,
      );
    } catch {
      try {
        return await pmsApi.get<PaymentSettings>(
          `/api/hotels/${encodeURIComponent(slug)}/payment-settings`,
        );
      } catch {
        // Settings endpoint is best-effort — return a permissive default so the
        // checkout form still renders if the backend is briefly unreachable.
        return { payAtPropertyEnabled: false, freeCancellationDays: 7 };
      }
    }
  },

  async lookup(slug: string, bookingReference: string, guestEmail: string): Promise<Booking> {
    const body = { bookingReference, guestEmail };
    try {
      return await bookingWebPublic.post(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/lookup`,
        body,
      );
    } catch (err) {
      if (!shouldFallbackToPms(err)) throw err;
      return pmsApi.post(`/api/hotels/${encodeURIComponent(slug)}/bookings/lookup`, body);
    }
  },

  // Guest-initiated booking change requests (VAY-379)
  async previewChangeRequest(
    slug: string,
    bookingId: string,
    payload: ChangeRequestPayload,
  ): Promise<ChangeRequestPreview> {
    try {
      return await bookingWebPublic.post(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/change-request/preview`,
        payload,
      );
    } catch (err) {
      if (!shouldFallbackToPms(err)) throw err;
      return pmsApi.post(
        `/api/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/change-request/preview`,
        payload,
      );
    }
  },

  async submitChangeRequest(
    slug: string,
    bookingId: string,
    payload: ChangeRequestPayload,
  ): Promise<BookingChangeRequest> {
    try {
      return await bookingWebPublic.post(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/change-request`,
        payload,
      );
    } catch (err) {
      if (!shouldFallbackToPms(err)) throw err;
      return pmsApi.post(
        `/api/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/change-request`,
        payload,
      );
    }
  },

  async getChangeRequest(
    slug: string,
    bookingId: string,
    email: string,
  ): Promise<BookingChangeRequest | null> {
    const params = new URLSearchParams({ email });
    try {
      return await bookingWebPublic.get(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/change-request?${params}`,
      );
    } catch {
      return pmsApi.get(
        `/api/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/change-request?${params}`,
      );
    }
  },
};

function shouldFallbackToPms(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

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
