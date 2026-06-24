import { pmsClient } from "../api/pmsClient";
import {
  isPmsOperationsReadModelEnabled,
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "../api/pmsOperationsClient";
import { propertyEndpoint, resolveSelectedPmsPropertyId } from "../api/pmsPropertyClient";
import { buildQueryString } from "@/lib/utils/queryString";
import type { CheckinStepType } from "@/services/settings";

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
  roomMaxOccupancy: number;
  totalRoomCapacity: number;
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
    | "checked_out"
    | "cancelled"
    | "declined"
    | "expired"
    | "no_show";
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
  checkedOutAt: string | null;
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

type PmsOperationsMoney = {
  amountDecimal: string;
  currency: string;
};

type PmsOperationsRoomType = {
  roomTypeId: string;
  name: string;
  occupancyLimits: Record<string, number>;
  baseRate: PmsOperationsMoney;
};

type PmsOperationalReservation = {
  guestBookingId: string;
  bookingReference: string;
  status: string;
  source: "direct_booking" | "channel" | "manual" | "migration";
  stay: { checkIn: string; checkOut: string; adults: number; children: number };
  primaryGuest: { displayName: string; email: string | null; phone: string | null };
  assignments: Array<{
    roomTypeId: string;
    roomId: string | null;
    roomNumber: string | null;
    position: number;
    channel: string;
  }>;
  checkin: { completedAt: string | null; pendingFlags: string[] };
  checkout: { completedAt: string | null; pendingFlags: string[] };
};

type PmsOperationsListResponse<T> = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  items: T[];
  sourceFreshness: Record<string, string | number | boolean | null>;
};

type PmsOperationsReservationListResponse = PmsOperationsListResponse<PmsOperationalReservation> & {
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
};

type PmsOperationsReservationDetailResponse = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  item: PmsOperationalReservation;
  sourceFreshness: Record<string, string | number | boolean | null>;
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
  paymentProvider: "stripe" | "xendit" | "vayada";
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
  source: "check-in" | "check-out" | "booking-detail" | null;
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

export interface CheckinStepResult {
  stepId: string;
  label: string;
  type: CheckinStepType;
  value: string | number | boolean | null;
  completedAt: string | null;
}

export interface CheckinPendingFlag {
  stepId: string;
  label: string;
}

export type CheckoutInspectionStatus = "ok" | "issue" | "neutral";

export interface CheckoutInspectionResult {
  stepId: string;
  label: string;
  status: CheckoutInspectionStatus;
  note: string | null;
  completedAt: string | null;
}

export interface CheckoutCharge {
  id: string;
  bookingId: string;
  label: string;
  amount: number;
  originalAmount: number;
  status: "pending" | "paid" | "waived";
  createdAt: string;
  settledAt: string | null;
  waivedAt: string | null;
}

export interface CheckoutRecord {
  id: string;
  bookingId: string;
  completedAt: string;
  completedBy: string | null;
  inspectionResults: CheckoutInspectionResult[];
  chargesSettled: CheckoutCharge[];
  pendingFlags: CheckoutInspectionResult[];
  checkoutNotes: string | null;
}

export const bookingsService = {
  list: async (params?: BookingListParams) => {
    if (!isPmsOperationsReadModelEnabled()) {
      const qs = buildQueryString(params);
      return pmsClient.get<BookingListResponse>(`/admin/bookings${qs}`);
    }

    return pmsOperationsBookingsReadService.list(params);
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

  get: async (id: string) => {
    if (!isPmsOperationsReadModelEnabled()) {
      return pmsClient.get<Booking>(`/admin/bookings/${id}`);
    }

    return pmsOperationsBookingsReadService.get(id);
  },

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

  completeCheckIn: (
    id: string,
    pendingFlags: string[],
    stepResults: CheckinStepResult[] = [],
    pendingFlagDetails: CheckinPendingFlag[] = [],
  ) =>
    pmsClient.post<Booking>(`/admin/bookings/${id}/check-in`, {
      pendingFlags,
      stepResults,
      pendingFlagDetails,
    }),

  listCheckoutCharges: (id: string) =>
    pmsClient.get<{ charges: CheckoutCharge[] }>(`/admin/bookings/${id}/checkout-charges`),

  addCheckoutCharge: (id: string, label: string, amount: number) =>
    pmsClient.post<CheckoutCharge>(`/admin/bookings/${id}/checkout-charges`, { label, amount }),

  markCheckoutChargePaid: (id: string, chargeId: string) =>
    pmsClient.post<CheckoutCharge>(`/admin/bookings/${id}/checkout-charges/${chargeId}/paid`, {}),

  waiveCheckoutCharge: (id: string, chargeId: string) =>
    pmsClient.post<CheckoutCharge>(`/admin/bookings/${id}/checkout-charges/${chargeId}/waive`, {}),

  getCheckoutRecord: (id: string) =>
    pmsClient.get<CheckoutRecord | null>(`/admin/bookings/${id}/checkout-record`),

  completeCheckOut: (
    id: string,
    inspectionResults: CheckoutInspectionResult[],
    pendingFlags: CheckoutInspectionResult[],
    checkoutNotes?: string,
  ) =>
    pmsClient.post<Booking>(`/admin/bookings/${id}/check-out`, {
      inspectionResults,
      pendingFlags,
      checkoutNotes,
    }),

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

  getPaymentSettings: async () => {
    if (!isPmsOperationsReadModelEnabled()) {
      return pmsClient.get<PaymentSettingsResponse>("/admin/payment-settings");
    }

    const propertyId = await resolveSelectedPmsPropertyId("loading payment settings");
    return pmsOperationsClient.get<PaymentSettingsResponse>(
      propertyEndpoint(propertyId, "payment-settings"),
      pmsOperationsRequestOptions,
    );
  },

  updatePaymentSettings: async (data: Partial<PaymentSettings>) => {
    if (!isPmsOperationsReadModelEnabled()) {
      return pmsClient.patch("/admin/payment-settings", data);
    }

    const propertyId = await resolveSelectedPmsPropertyId("saving payment settings");
    return pmsOperationsClient.patch(
      propertyEndpoint(propertyId, "payment-settings"),
      data,
      pmsOperationsRequestOptions,
    );
  },

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

  createNote: (id: string, body: string, source?: BookingNote["source"]) =>
    pmsClient.post<BookingNote>(`/admin/bookings/${id}/notes`, { body, source }),

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

  markNoShow: (id: string) => pmsClient.post<Booking>(`/admin/bookings/${id}/no-show`, {}),
};

const pmsOperationsBookingsReadService = {
  list: async (params?: BookingListParams): Promise<BookingListResponse> => {
    const propertyId = await resolveSelectedPmsPropertyId("loading bookings");
    const query = buildPmsReservationsQuery(params);
    const [reservations, roomTypes] = await Promise.all([
      pmsOperationsClient.get<PmsOperationsReservationListResponse>(
        `${propertyEndpoint(propertyId, "reservations")}${query}`,
        pmsOperationsRequestOptions,
      ),
      pmsOperationsClient.get<PmsOperationsListResponse<PmsOperationsRoomType>>(
        propertyEndpoint(propertyId, "room-types"),
        pmsOperationsRequestOptions,
      ),
    ]);
    const roomTypesById = new Map(
      roomTypes.items.map((roomType) => [roomType.roomTypeId, roomType]),
    );
    return {
      bookings: reservations.items.map((reservation) => toBooking(reservation, roomTypesById)),
      total: reservations.pagination.total,
      limit: reservations.pagination.limit,
      offset: reservations.pagination.offset,
    };
  },

  get: async (id: string): Promise<Booking> => {
    const propertyId = await resolveSelectedPmsPropertyId("loading booking details");
    const [reservation, roomTypes] = await Promise.all([
      pmsOperationsClient.get<PmsOperationsReservationDetailResponse>(
        propertyEndpoint(propertyId, `reservations/${encodeURIComponent(id)}`),
        pmsOperationsRequestOptions,
      ),
      pmsOperationsClient.get<PmsOperationsListResponse<PmsOperationsRoomType>>(
        propertyEndpoint(propertyId, "room-types"),
        pmsOperationsRequestOptions,
      ),
    ]);
    const roomTypesById = new Map(
      roomTypes.items.map((roomType) => [roomType.roomTypeId, roomType]),
    );
    return toBooking(reservation.item, roomTypesById);
  },
};

function buildPmsReservationsQuery(params?: BookingListParams): string {
  const query = new URLSearchParams();
  appendQueryParam(query, "status", params?.status);
  appendQueryParam(query, "search", params?.search);
  appendQueryParam(query, "limit", params?.limit);
  appendQueryParam(query, "offset", params?.offset);
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function appendQueryParam(
  query: URLSearchParams,
  key: string,
  value: string | number | undefined,
): void {
  if (value === undefined || value === "") return;
  query.set(key, String(value));
}

function toBooking(
  reservation: PmsOperationalReservation,
  roomTypesById: Map<string, PmsOperationsRoomType>,
): Booking {
  const primaryAssignment = reservation.assignments[0] ?? null;
  const roomType = primaryAssignment ? roomTypesById.get(primaryAssignment.roomTypeId) : undefined;
  const nightlyRate = moneyAmount(roomType?.baseRate);
  const numberOfRooms = Math.max(reservation.assignments.length, 1);
  const nights = daysBetweenDateOnly(reservation.stay.checkIn, reservation.stay.checkOut);
  const totalAmount = nightlyRate * Math.max(nights, 1) * numberOfRooms;
  const [guestFirstName, guestLastName] = splitGuestName(reservation.primaryGuest.displayName);

  return {
    id: reservation.guestBookingId,
    bookingReference: reservation.bookingReference,
    roomTypeId: primaryAssignment?.roomTypeId ?? "",
    roomName: roomType?.name ?? "",
    roomMaxOccupancy: maxOccupancy(roomType),
    totalRoomCapacity: maxOccupancy(roomType),
    guestFirstName,
    guestLastName,
    guestEmail: reservation.primaryGuest.email ?? "",
    guestPhone: reservation.primaryGuest.phone ?? "",
    guestCountry: "",
    guestGender: "",
    guestDateOfBirth: null,
    guestPassportNumber: "",
    specialRequests: "",
    checkIn: reservation.stay.checkIn,
    checkOut: reservation.stay.checkOut,
    nights,
    adults: reservation.stay.adults,
    children: reservation.stay.children,
    nightlyRate,
    numberOfRooms,
    totalAmount,
    depositRequired: false,
    depositPercentage: null,
    depositAmount: 0,
    balanceAmount: totalAmount,
    currency: roomType?.baseRate.currency ?? "EUR",
    status: toBookingStatus(reservation.status),
    roomId: primaryAssignment?.roomId ?? null,
    roomNumber: primaryAssignment?.roomNumber ?? null,
    assignedRooms: reservation.assignments.map((assignment) => ({
      roomId: assignment.roomId,
      roomNumber: assignment.roomNumber,
      position: assignment.position,
    })),
    channel: primaryAssignment?.channel ?? reservationSource(reservation.source),
    paymentMethod: null,
    paymentStatus: null,
    checkInPendingFlags: reservation.checkin.pendingFlags,
    checkedInAt: reservation.checkin.completedAt,
    checkedOutAt: reservation.checkout.completedAt,
    hostResponseDeadline: null,
    platformFeeAmount: null,
    affiliateCommissionAmount: null,
    propertyPayoutAmount: null,
    addonIds: [],
    addonNames: [],
    addonTotal: 0,
    addonQuantities: {},
    addonDates: {},
    estimatedArrivalTime: null,
    numberOfGuests: reservation.stay.adults + reservation.stay.children,
    guestWithdrawn: false,
    createdAt: `${reservation.stay.checkIn}T00:00:00.000Z`,
    updatedAt: `${reservation.stay.checkIn}T00:00:00.000Z`,
  };
}

function splitGuestName(displayName: string): [string, string] {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ["", ""];
  const [firstName, ...rest] = parts;
  return [firstName, rest.join(" ")];
}

function daysBetweenDateOnly(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

function moneyAmount(money: PmsOperationsMoney | undefined): number {
  const amount = Number.parseFloat(money?.amountDecimal ?? "0");
  return Number.isFinite(amount) ? amount : 0;
}

function maxOccupancy(roomType: PmsOperationsRoomType | undefined): number {
  if (!roomType) return 0;
  const total = roomType.occupancyLimits.total;
  if (typeof total === "number") return total;
  return Object.values(roomType.occupancyLimits).reduce((sum, value) => sum + value, 0);
}

function reservationSource(source: PmsOperationalReservation["source"]): string {
  return source === "direct_booking" ? "direct" : source;
}

function toBookingStatus(status: string): Booking["status"] {
  switch (status) {
    case "pending":
    case "confirmed":
    case "checked_in":
    case "in_house":
    case "checked_out":
    case "declined":
    case "expired":
    case "no_show":
      return status;
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return "confirmed";
  }
}
