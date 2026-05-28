import { pmsClient } from "../api/pmsClient";
import { buildQueryString } from "@/lib/utils/queryString";

export interface AssignedRoom {
  roomId: string | null;
  roomNumber: string | null;
  position: number;
}

export interface Booking {
  id: string;
  bookingReference: string;
  roomTypeId: string;
  roomName: string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  guestCountry: string;
  guestGender: string;
  guestDateOfBirth: string | null;
  guestPassportNumber: string;
  specialRequests: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  nightlyRate: number;
  numberOfRooms: number;
  totalAmount: number;
  depositRequired: boolean;
  depositPercentage: number | null;
  depositAmount: number;
  balanceAmount: number;
  currency: string;
  status:
    | "pending"
    | "confirmed"
    | "checked_in"
    | "in_house"
    | "cancelled"
    | "declined"
    | "expired";
  roomId: string | null;
  roomNumber: string | null;
  // VAY-403: every physical room the booking occupies — the primary
  // (position 0) plus any extra rooms of a multi-room reservation.
  assignedRooms: AssignedRoom[];
  channel: string;
  paymentMethod: string | null;
  paymentStatus: string | null;
  checkInPendingFlags: string[];
  checkedInAt: string | null;
  hostResponseDeadline: string | null;
  platformFeeAmount: number | null;
  affiliateCommissionAmount: number | null;
  propertyPayoutAmount: number | null;
  addonIds: string[];
  addonNames: string[];
  addonTotal: number;
  addonQuantities: Record<string, number>;
  addonDates: Record<string, string[]>;
  estimatedArrivalTime: string | null;
  numberOfGuests: number | null;
  guestWithdrawn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BookingAddon {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  perPerson?: boolean | null;
  perNight?: boolean | null;
}

export interface BookingListResponse {
  bookings: Booking[];
  total: number;
  limit: number;
  offset: number;
}

export type BookingListParams = Record<string, string | number | undefined> & {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

export interface PaymentSettings {
  stripeConnectAccountId: string | null;
  stripeConnectOnboarded: boolean;
  platformFeeType: string;
  platformFeeValue: number;
  platformFeeWithAffiliate: number;
  payAtPropertyEnabled: boolean;
  onlineCardPayment: boolean;
  bankTransfer: boolean;
  xenditPaymentsEnabled: boolean;
  paymentProvider: "stripe" | "xendit";
  xenditChannelCode: string | null;
  xenditAccountNumber: string | null;
  xenditAccountHolderName: string | null;
  defaultCurrency: string;
}

export interface CancellationPolicy {
  freeCancellationDays: number;
  partialRefundPct: number;
}

export interface PaymentSettingsResponse {
  paymentSettings: PaymentSettings;
  cancellationPolicy: CancellationPolicy;
}

export interface BookingNote {
  id: string;
  bookingId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface BookingAdditionalGuest {
  id: string;
  bookingId: string;
  position: number;
  firstName: string;
  lastName: string;
  gender: string;
  nationality: string;
  dateOfBirth: string | null;
  email: string;
  phone: string;
  passportNumber: string;
  /** Which of the booking's rooms this guest is assigned to.
   * 0 = primary room, 1..N-1 = extras, null = unassigned. */
  roomPosition: number | null;
  createdAt: string;
  updatedAt: string;
}

export type BookingAdditionalGuestPayload = Partial<
  Omit<BookingAdditionalGuest, "id" | "bookingId" | "position" | "createdAt" | "updatedAt">
>;

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

export const bookingsService = {
  list: (params?: BookingListParams) => {
    const qs = buildQueryString(params);
    return pmsClient.get<BookingListResponse>(`/admin/bookings${qs}`);
  },

  listAll: async (params?: Omit<BookingListParams, "limit" | "offset">) => {
    const limit = 500;
    let offset = 0;
    const bookings: Booking[] = [];

    while (true) {
      const page = await bookingsService.list({ ...params, limit, offset });
      bookings.push(...page.bookings);

      if (bookings.length >= page.total || page.bookings.length < limit) {
        return bookings;
      }

      offset += page.bookings.length;
    }
  },

  get: (id: string) => pmsClient.get<Booking>(`/admin/bookings/${id}`),

  update: (
    id: string,
    data: Partial<{
      checkIn: string;
      checkOut: string;
      guestFirstName: string;
      guestLastName: string;
      guestEmail: string;
      guestPhone: string;
      guestCountry: string;
      guestGender: string;
      guestDateOfBirth: string | null;
      guestPassportNumber: string;
      adults: number;
      children: number;
      nightlyRate: number;
      addonIds: string[];
      addonQuantities: Record<string, number>;
      addonDates: Record<string, string[]>;
      specialRequests: string;
    }>,
  ) => pmsClient.patch<Booking>(`/admin/bookings/${id}`, data),

  updateStatus: (id: string, status: "confirmed" | "cancelled") =>
    pmsClient.patch<Booking>(`/admin/bookings/${id}/status`, { status }),

  completeCheckIn: (id: string, pendingFlags: string[]) =>
    pmsClient.post<Booking>(`/admin/bookings/${id}/check-in`, { pendingFlags }),

  markPaid: (id: string) => pmsClient.post<Booking>(`/admin/bookings/${id}/mark-paid`, {}),

  addArrivalCharge: (id: string, amount: number, description?: string) =>
    pmsClient.post<Booking>(`/admin/bookings/${id}/arrival-charge`, { amount, description }),

  acceptBooking: (id: string) => pmsClient.post<Booking>(`/admin/bookings/${id}/accept`, {}),

  rejectBooking: (id: string, reason?: string) =>
    pmsClient.post<Booking>(`/admin/bookings/${id}/reject`, { reason }),

  assignRoom: (id: string, roomId: string) =>
    pmsClient.patch<Booking>(`/admin/bookings/${id}/assign-room`, { roomId }),

  moveRoom: (id: string, roomId: string, fromRoomId?: string) =>
    pmsClient.patch<Booking>(`/admin/bookings/${id}/move-room`, {
      roomId,
      ...(fromRoomId ? { fromRoomId } : {}),
    }),

  swapRoom: (id: string, partnerBookingId: string, partnerDestinationRoomId?: string) =>
    pmsClient.patch<Booking>(`/admin/bookings/${id}/swap-room`, {
      partnerBookingId,
      ...(partnerDestinationRoomId ? { partnerDestinationRoomId } : {}),
    }),

  unassignRoom: (id: string) => pmsClient.patch<Booking>(`/admin/bookings/${id}/unassign-room`, {}),

  getPaymentSettings: () => pmsClient.get<PaymentSettingsResponse>("/admin/payment-settings"),

  updatePaymentSettings: (data: Partial<PaymentSettings>) =>
    pmsClient.patch("/admin/payment-settings", data),

  updateCancellationPolicy: (data: Partial<CancellationPolicy>) =>
    pmsClient.patch("/admin/cancellation-policy", data),

  createStripeAccount: (email: string, country: string) =>
    pmsClient.post<{ accountId: string }>("/admin/stripe/connect-account", { email, country }),

  getStripeOnboardingLink: () =>
    pmsClient.get<{ url: string }>("/admin/stripe/connect-onboarding-link"),

  // Guest-initiated booking change requests (VAY-379)
  getChangeRequest: (id: string) =>
    pmsClient.get<BookingChangeRequest | null>(`/admin/bookings/${id}/change-request`),

  approveChangeRequest: (id: string) =>
    pmsClient.post<BookingChangeRequest>(`/admin/bookings/${id}/change-request/approve`, {}),

  declineChangeRequest: (id: string, reason?: string) =>
    pmsClient.post<BookingChangeRequest>(`/admin/bookings/${id}/change-request/decline`, {
      reason,
    }),

  // VAY-495 booking detail — internal notes, additional guests, cancel-with-reason.
  listNotes: (id: string) => pmsClient.get<{ notes: BookingNote[] }>(`/admin/bookings/${id}/notes`),

  createNote: (id: string, body: string) =>
    pmsClient.post<BookingNote>(`/admin/bookings/${id}/notes`, { body }),

  deleteNote: (id: string, noteId: string) =>
    pmsClient.delete<void>(`/admin/bookings/${id}/notes/${noteId}`),

  listAdditionalGuests: (id: string) =>
    pmsClient.get<{ guests: BookingAdditionalGuest[] }>(`/admin/bookings/${id}/additional-guests`),

  listAvailableAddons: (id: string) =>
    pmsClient.get<BookingAddon[]>(`/admin/bookings/${id}/addons`),

  createAdditionalGuest: (id: string, data: BookingAdditionalGuestPayload) =>
    pmsClient.post<BookingAdditionalGuest>(`/admin/bookings/${id}/additional-guests`, data),

  updateAdditionalGuest: (id: string, guestId: string, data: BookingAdditionalGuestPayload) =>
    pmsClient.patch<BookingAdditionalGuest>(
      `/admin/bookings/${id}/additional-guests/${guestId}`,
      data,
    ),

  deleteAdditionalGuest: (id: string, guestId: string) =>
    pmsClient.delete<void>(`/admin/bookings/${id}/additional-guests/${guestId}`),

  cancelWithReason: (id: string, reason: string) =>
    pmsClient.post<Booking>(`/admin/bookings/${id}/cancel`, { reason }),
};
