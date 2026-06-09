import type { FastifyInstance } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

export const BOOKING_RESERVATION_LIST_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/reservations",
  permission: "booking.reservation.read",
  entitlement: {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export type BookingReservationListPathParams = {
  hotelId: string;
};

export type BookingReservationListQuery = {
  status?: string;
  search?: string;
  limit?: string;
  offset?: string;
};

export type BookingReservationQuery = BookingReservationListQuery;

export type BookingReservationListRequest = {
  params: BookingReservationListPathParams;
  query: BookingReservationListQuery;
};

export type BookingAssignedRoomResponse = {
  roomId: string | null;
  roomNumber: string | null;
  position: number;
};

export type BookingReservationReadModel = {
  id: string;
  bookingReference: string;
  roomTypeId: string;
  roomName: string;
  roomMaxOccupancy: number;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  guestCountry?: string | null;
  guestGender?: string | null;
  guestDateOfBirth?: Date | string | null;
  guestPassportNumber?: string | null;
  specialRequests: string;
  estimatedArrivalTime?: string | null;
  numberOfGuests?: number | null;
  checkIn: Date | string;
  checkOut: Date | string;
  adults: number;
  children: number;
  nightlyRate: number | string;
  numberOfRooms?: number | null;
  totalAmount: number | string;
  currency: string;
  status: string;
  roomId?: string | null;
  roomNumber?: string | null;
  assignedRooms?: BookingAssignedRoomResponse[] | string | null;
  channel?: string | null;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  depositRequired?: boolean | null;
  depositPercentage?: number | null;
  depositAmount?: number | string | null;
  balanceAmount?: number | string | null;
  checkInPendingFlags?: string[] | string | null;
  checkedInAt?: Date | string | null;
  checkedOutAt?: Date | string | null;
  hostResponseDeadline?: Date | string | null;
  platformFeeAmount?: number | string | null;
  affiliateCommissionAmount?: number | string | null;
  propertyPayoutAmount?: number | string | null;
  addonIds?: string[] | string | null;
  addonNames?: string[] | string | null;
  addonTotal?: number | string | null;
  addonQuantities?: Record<string, number> | string | null;
  addonDates?: Record<string, string[]> | string | null;
  guestWithdrawn?: boolean | null;
  promoCode?: string | null;
  promoDiscount?: number | string | null;
  lastMinuteDiscountPercent?: number | string | null;
  lastMinuteDiscountAmount?: number | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type BookingReservationListResult = {
  reservations: BookingReservationReadModel[];
  total: number;
};

export type BookingReservationListFilters = {
  status?: string;
  search?: string;
  limit: number;
  offset: number;
};

export type BookingReservationsReadRepository = {
  listReservationsByHotelId(
    hotelId: string,
    filters: BookingReservationListFilters,
  ): Promise<BookingReservationListResult>;
  close?(): Promise<void>;
};

/**
 * Booking Engine reservation read contract.
 *
 * The HTTP route depends on this product-level shape, not on Vayada PMS tables
 * or any specific external PMS schema. Authorized hotels with no matching rows
 * return a successful empty list rather than a 404.
 */
export type BookingReservationResponse = {
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
  estimatedArrivalTime: string | null;
  numberOfGuests: number | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  nightlyRate: number;
  numberOfRooms: number;
  totalAmount: number;
  currency: string;
  status: string;
  roomId: string | null;
  roomNumber: string | null;
  assignedRooms: BookingAssignedRoomResponse[];
  channel: string;
  paymentMethod: string | null;
  paymentStatus: string | null;
  depositRequired: boolean;
  depositPercentage: number | null;
  depositAmount: number;
  balanceAmount: number;
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
  guestWithdrawn: boolean;
  promoCode: string | null;
  promoDiscount: number;
  lastMinuteDiscountPercent: number;
  lastMinuteDiscountAmount: number;
  createdAt: string;
  updatedAt: string;
};

export type BookingReservationListResponse = {
  bookings: BookingReservationResponse[];
  total: number;
  limit: number;
  offset: number;
};

export type BookingReservation = BookingReservationResponse;

export type BookingReservationListErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "read_model";

export type BookingReservationListErrorCode =
  | "unauthenticated"
  | "invalid_token"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "invalid_query"
  | "read_model_unavailable";

export type BookingReservationListError = {
  statusCode: 400 | 401 | 403 | 500;
  code: BookingReservationListErrorCode;
  category: BookingReservationListErrorCategory;
  message: string;
};

export type BookingReservationList = BookingReservationListResponse;

export type BookingReservationListContract = {
  method: typeof BOOKING_RESERVATION_LIST_CONTRACT.method;
  path: typeof BOOKING_RESERVATION_LIST_CONTRACT.path;
  request: BookingReservationListRequest;
  response: BookingReservationListResponse;
  error: BookingReservationListError;
};

export async function registerBookingReservationRoutes(
  app: FastifyInstance,
  repository: BookingReservationsReadRepository,
): Promise<void> {
  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{
    Params: BookingReservationListPathParams;
    Querystring: BookingReservationListQuery;
  }>("/hotels/:hotelId/reservations", async (request) => {
    const { hotelId } = request.params;

    enforceRoutePolicy(request, {
      permission: "booking.reservation.read",
      entitlement: {
        product: "booking",
        key: "booking-engine",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: hotelId,
        },
      },
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: hotelId,
        allowedRelationships: ["owner", "operator"],
      },
    });

    const filters = toReservationFilters(request.query);
    const result = await repository.listReservationsByHotelId(hotelId, filters);

    return {
      bookings: result.reservations.map(toReservationResponse),
      total: result.total,
      limit: filters.limit,
      offset: filters.offset,
    } satisfies BookingReservationListResponse;
  });
}

export function toReservationResponse(
  reservation: BookingReservationReadModel,
): BookingReservationResponse {
  const checkIn = toDateOnly(reservation.checkIn);
  const checkOut = toDateOnly(reservation.checkOut);
  const numberOfRooms = Math.max(1, reservation.numberOfRooms ?? 1);
  const roomMaxOccupancy = Math.max(1, toNumber(reservation.roomMaxOccupancy));
  const primaryRoom = reservation.roomId
    ? [
        {
          roomId: reservation.roomId,
          roomNumber: reservation.roomNumber ?? null,
          position: 0,
        },
      ]
    : [];

  return {
    id: reservation.id,
    bookingReference: reservation.bookingReference,
    roomTypeId: reservation.roomTypeId,
    roomName: reservation.roomName,
    roomMaxOccupancy,
    totalRoomCapacity: roomMaxOccupancy * numberOfRooms,
    guestFirstName: reservation.guestFirstName,
    guestLastName: reservation.guestLastName,
    guestEmail: reservation.guestEmail,
    guestPhone: reservation.guestPhone,
    guestCountry: reservation.guestCountry ?? "",
    guestGender: reservation.guestGender ?? "",
    guestDateOfBirth: reservation.guestDateOfBirth
      ? toDateOnly(reservation.guestDateOfBirth)
      : null,
    guestPassportNumber: reservation.guestPassportNumber ?? "",
    specialRequests: reservation.specialRequests,
    estimatedArrivalTime: reservation.estimatedArrivalTime ?? null,
    numberOfGuests: reservation.numberOfGuests ?? null,
    checkIn,
    checkOut,
    nights: daysBetween(checkIn, checkOut),
    adults: reservation.adults,
    children: reservation.children,
    nightlyRate: toNumber(reservation.nightlyRate),
    numberOfRooms,
    totalAmount: toNumber(reservation.totalAmount),
    currency: reservation.currency,
    status: reservation.status,
    roomId: reservation.roomId ?? null,
    roomNumber: reservation.roomNumber ?? null,
    assignedRooms: [
      ...primaryRoom,
      ...parseJson<BookingAssignedRoomResponse[]>(reservation.assignedRooms, []),
    ],
    channel: reservation.channel ?? "direct",
    paymentMethod: reservation.paymentMethod ?? null,
    paymentStatus: reservation.paymentStatus ?? null,
    depositRequired: reservation.depositRequired ?? false,
    depositPercentage: reservation.depositPercentage ?? null,
    depositAmount: toNumber(reservation.depositAmount ?? 0),
    balanceAmount: toNumber(reservation.balanceAmount ?? reservation.totalAmount),
    checkInPendingFlags: parseJson<string[]>(reservation.checkInPendingFlags, []),
    checkedInAt: toIsoDateTimeOrNull(reservation.checkedInAt),
    checkedOutAt: toIsoDateTimeOrNull(reservation.checkedOutAt),
    hostResponseDeadline: toIsoDateTimeOrNull(reservation.hostResponseDeadline),
    platformFeeAmount: toNullableNumber(reservation.platformFeeAmount),
    affiliateCommissionAmount: toNullableNumber(reservation.affiliateCommissionAmount),
    propertyPayoutAmount: toNullableNumber(reservation.propertyPayoutAmount),
    addonIds: parseJson<string[]>(reservation.addonIds, []),
    addonNames: parseJson<string[]>(reservation.addonNames, []),
    addonTotal: toNumber(reservation.addonTotal ?? 0),
    addonQuantities: parseJson<Record<string, number>>(reservation.addonQuantities, {}),
    addonDates: parseJson<Record<string, string[]>>(reservation.addonDates, {}),
    guestWithdrawn: reservation.guestWithdrawn ?? false,
    promoCode: reservation.promoCode ?? null,
    promoDiscount: toNumber(reservation.promoDiscount ?? 0),
    lastMinuteDiscountPercent: toNumber(reservation.lastMinuteDiscountPercent ?? 0),
    lastMinuteDiscountAmount: toNumber(reservation.lastMinuteDiscountAmount ?? 0),
    createdAt: toIsoDateTime(reservation.createdAt),
    updatedAt: toIsoDateTime(reservation.updatedAt),
  };
}

function toReservationFilters(query: BookingReservationListQuery): BookingReservationListFilters {
  return {
    status: query.status?.trim() || undefined,
    search: query.search?.trim() || undefined,
    limit: clampInteger(query.limit, 50, 1, 500),
    offset: clampInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function clampInteger(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

function parseJson<T>(value: T | string | null | undefined, defaultValue: T): T {
  if (value == null) return defaultValue;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value) as T;
  } catch {
    return defaultValue;
  }
}

function toNumber(value: number | string): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  return toNumber(value);
}

function toDateOnly(value: Date | string): string {
  const date = toValidDate(value);
  if (date) {
    return date.toISOString().slice(0, 10);
  }

  return typeof value === "string" ? value.slice(0, 10) : "";
}

function toIsoDateTime(value: Date | string): string {
  return toIsoDateTimeOrNull(value) ?? "";
}

function toIsoDateTimeOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function toValidDate(value: Date | string): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function daysBetween(start: string, end: string): number {
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return 0;
  }

  return Math.max(0, Math.round((endTime - startTime) / 86_400_000));
}
