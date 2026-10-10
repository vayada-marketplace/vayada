import { Booking, RoomSelection, RoomSelectionSnapshot } from "@/lib/types";
import { bookingWebPublic } from "./client";

export interface BookingRequestResponse {
  // For card payments (VAY-388) `booking` is a placeholder preview —
  // status === 'draft' and id is empty until Stripe authorizes the card.
  // For other payment methods it's a real persisted booking.
  booking: Booking;
  clientSecret: string | null;
  stripeAccountId?: string;
  xenditInvoiceUrl: string | null;
  paymentMethod: string;
  // Soft-hold draft id, present when paymentMethod === 'card'. Pass it
  // to confirmAuthorization() after Stripe.confirmPayment resolves.
  draftId?: string;
  bookingReference?: string;
  authorizationComplete?: boolean;
  authorizationExpired?: boolean;
  confirmationToken?: string;
  confirmationTokenExpiresAt?: string;
}

export interface BookingLookupResponse extends Booking {
  confirmationToken: string;
  confirmationTokenExpiresAt: string;
}

export type BookingCreateRequest = {
  roomSelection?: RoomSelection;
  currency?: string;
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
  addonPackageQuantities?: Record<string, number>;
  addonDates?: Record<string, string[]>;
  promoCode?: string;
  quoteId?: string;
  expectedTotalAmount?: number;
  balanceAmount?: number;
};

export interface BookingQuote extends RoomSelectionSnapshot {
  promotion?: { name: string; discountAmount: number; discountPercent: number } | null;
  promotionDiscount?: number;
  quoteId?: string;
  expiresAt?: string;
  roomTypeId: string;
  roomName: string;
  rateType: string;
  paymentMethod: string;
  nightlyRate: number;
  numberOfRooms: number;
  roomTotal: number;
  addonTotal: number;
  promoCode?: string | null;
  promoDiscount: number;
  lastMinuteDiscountPercent: number;
  lastMinuteDiscountAmount: number;
  totalAmount: number;
  currency: string;
  depositRequired: boolean;
  depositPercentage?: number | null;
  depositAmount: number;
  balanceAmount: number;
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
}

export interface BookingStatus {
  canEditRequest?: boolean;
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
}

export const bookingService = {
  async withdraw(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    const body = { guestEmail };
    await bookingWebPublic.post(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/withdraw`,
      body,
    );
  },

  async cancelPreview(slug: string, bookingId: string, guestEmail: string): Promise<CancelPreview> {
    const body = { guestEmail };
    return bookingWebPublic.post(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/cancel-preview`,
      body,
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
