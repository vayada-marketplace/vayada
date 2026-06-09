import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

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

export const BOOKING_RESERVATION_LIST_DEFAULT_LIMIT = 50;
export const BOOKING_RESERVATION_LIST_MIN_LIMIT = 1;
export const BOOKING_RESERVATION_LIST_MAX_LIMIT = 500;
export const BOOKING_RESERVATION_LIST_DEFAULT_OFFSET = 0;

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

export type BookingReservationsReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type CompatibilityPmsBookingReservationRow = BookingReservationReadModel;

export function createCompatibilityPmsBookingReservationsReadRepository(config: {
  connectionString: string;
  max?: number;
  pool?: BookingReservationsReadPool;
}): BookingReservationsReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Booking reservations repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async listReservationsByHotelId(hotelId, filters) {
      const { whereSql, params } = toCompatibilityPmsReservationWhere(hotelId, filters);
      const listParams = [...params, filters.limit, filters.offset];
      const limitParam = params.length + 1;
      const offsetParam = params.length + 2;

      const [reservationResult, countResult] = await Promise.all([
        pool.query<CompatibilityPmsBookingReservationRow>(
          `SELECT
             b.id::text AS "id",
             b.booking_reference AS "bookingReference",
             b.room_type_id::text AS "roomTypeId",
             rt.name AS "roomName",
             rt.max_occupancy AS "roomMaxOccupancy",
             b.guest_first_name AS "guestFirstName",
             b.guest_last_name AS "guestLastName",
             b.guest_email AS "guestEmail",
             b.guest_phone AS "guestPhone",
             b.guest_country AS "guestCountry",
             b.guest_gender AS "guestGender",
             b.guest_date_of_birth AS "guestDateOfBirth",
             b.guest_passport_number AS "guestPassportNumber",
             b.special_requests AS "specialRequests",
             b.estimated_arrival_time AS "estimatedArrivalTime",
             b.number_of_guests AS "numberOfGuests",
             b.check_in AS "checkIn",
             b.check_out AS "checkOut",
             b.adults,
             b.children,
             b.nightly_rate AS "nightlyRate",
             b.number_of_rooms AS "numberOfRooms",
             b.total_amount AS "totalAmount",
             b.currency,
             b.status,
             rm.id::text AS "roomId",
             rm.room_number AS "roomNumber",
             (
               SELECT COALESCE(
                 jsonb_agg(
                   jsonb_build_object(
                     'roomId', br.room_id::text,
                     'roomNumber', brm.room_number,
                     'position', br.position
                   )
                   ORDER BY br.position
                 ),
                 '[]'::jsonb
               )
               FROM booking_rooms br
               JOIN rooms brm ON brm.id = br.room_id AND brm.hotel_id = b.hotel_id
               WHERE br.booking_id = b.id
             ) AS "assignedRooms",
             b.channel,
             b.payment_method AS "paymentMethod",
             b.payment_status AS "paymentStatus",
             b.deposit_required AS "depositRequired",
             b.deposit_percentage AS "depositPercentage",
             b.deposit_amount AS "depositAmount",
             b.balance_amount AS "balanceAmount",
             b.check_in_pending_flags AS "checkInPendingFlags",
             b.checked_in_at AS "checkedInAt",
             b.checked_out_at AS "checkedOutAt",
             b.host_response_deadline AS "hostResponseDeadline",
             b.platform_fee_amount AS "platformFeeAmount",
             b.affiliate_commission_amount AS "affiliateCommissionAmount",
             b.property_payout_amount AS "propertyPayoutAmount",
             b.addon_ids AS "addonIds",
             b.addon_names AS "addonNames",
             b.addon_total AS "addonTotal",
             b.addon_quantities AS "addonQuantities",
             b.addon_dates AS "addonDates",
             b.guest_withdrawn AS "guestWithdrawn",
             b.promo_code AS "promoCode",
             b.promo_discount AS "promoDiscount",
             b.last_minute_discount_percent AS "lastMinuteDiscountPercent",
             b.last_minute_discount_amount AS "lastMinuteDiscountAmount",
             b.created_at AS "createdAt",
             b.updated_at AS "updatedAt"
           FROM bookings b
           JOIN room_types rt ON rt.id = b.room_type_id AND rt.hotel_id = b.hotel_id
           LEFT JOIN rooms rm ON rm.id = b.room_id AND rm.hotel_id = b.hotel_id
           WHERE ${whereSql}
           ORDER BY b.created_at DESC
           LIMIT $${limitParam} OFFSET $${offsetParam}`,
          listParams,
        ),
        pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total
           FROM bookings b
           JOIN room_types rt ON rt.id = b.room_type_id AND rt.hotel_id = b.hotel_id
           WHERE ${whereSql}`,
          params,
        ),
      ]);

      return {
        reservations: reservationResult.rows,
        total: parseCount(countResult.rows[0]?.total),
      };
    },
    async close() {
      await pool.end();
    },
  };
}

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
  }>("/hotels/:hotelId/reservations", async (request, reply) => {
    const { hotelId } = request.params;

    try {
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
    } catch (error) {
      const contractError = toBookingReservationListAccessError(error, request, hotelId);
      if (contractError) {
        return sendBookingReservationListError(reply, contractError);
      }
      throw error;
    }

    const filters = toReservationFilters(request.query);
    let result: BookingReservationListResult;
    try {
      result = await repository.listReservationsByHotelId(hotelId, filters);
    } catch {
      return sendBookingReservationListError(reply, {
        statusCode: 500,
        code: "read_model_unavailable",
        category: "read_model",
        message: "Booking reservations are unavailable.",
      });
    }

    return {
      bookings: result.reservations.map(toReservationResponse),
      total: result.total,
      limit: filters.limit,
      offset: filters.offset,
    } satisfies BookingReservationListResponse;
  });
}

function toCompatibilityPmsReservationWhere(
  hotelId: string,
  filters: BookingReservationListFilters,
): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [hotelId];
  const conditions = ["b.hotel_id = $1"];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`b.status = $${params.length}`);
  }

  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(
      `(b.guest_first_name ILIKE $${params.length}
        OR b.guest_last_name ILIKE $${params.length}
        OR CONCAT(b.guest_first_name, ' ', b.guest_last_name) ILIKE $${params.length}
        OR b.booking_reference ILIKE $${params.length}
        OR b.guest_email ILIKE $${params.length}
        OR rt.name ILIKE $${params.length})`,
    );
  }

  return {
    whereSql: conditions.join(" AND "),
    params,
  };
}

function parseCount(value: string | undefined): number {
  if (!value) return 0;
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? count : 0;
}

function sendBookingReservationListError(
  reply: FastifyReply,
  error: BookingReservationListError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function toBookingReservationListAccessError(
  error: unknown,
  request: FastifyRequest,
  hotelId: string,
): BookingReservationListError | null {
  if (!isStatusError(error)) return null;

  if (error.statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }

  if (error.statusCode !== 403) return null;

  const code = toBookingReservationAuthorizationErrorCode(error.message, request, hotelId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toBookingReservationAuthorizationMessage(code),
  };
}

function toBookingReservationAuthorizationErrorCode(
  message: string,
  request: FastifyRequest,
  hotelId: string,
): Exclude<
  BookingReservationListErrorCode,
  "unauthenticated" | "invalid_token" | "invalid_query" | "read_model_unavailable"
> {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (normalized.includes("entitlement")) {
    return hasInactiveBookingReservationEntitlement(request, hotelId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "missing_resource_access";
}

function toBookingReservationAuthorizationMessage(
  code: Exclude<
    BookingReservationListErrorCode,
    "unauthenticated" | "invalid_token" | "invalid_query" | "read_model_unavailable"
  >,
): string {
  switch (code) {
    case "missing_permission":
      return "Missing required booking reservation permission.";
    case "inactive_entitlement":
      return "Booking engine entitlement is not active.";
    case "missing_entitlement":
      return "Missing active booking engine entitlement.";
    case "missing_resource_access":
      return "Missing booking hotel access.";
  }
}

function hasInactiveBookingReservationEntitlement(
  request: FastifyRequest,
  hotelId: string,
): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (entitlement.product !== "booking" || entitlement.key !== "booking-engine") {
        return false;
      }
      if (entitlement.status === "active") return false;
      if (!entitlement.resource) return true;
      return (
        entitlement.resource.product === "booking" &&
        entitlement.resource.resourceType === "booking_hotel" &&
        entitlement.resource.resourceId === hotelId
      );
    }) ?? false
  );
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
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
    limit: clampInteger(
      query.limit,
      BOOKING_RESERVATION_LIST_DEFAULT_LIMIT,
      BOOKING_RESERVATION_LIST_MIN_LIMIT,
      BOOKING_RESERVATION_LIST_MAX_LIMIT,
    ),
    offset: clampInteger(
      query.offset,
      BOOKING_RESERVATION_LIST_DEFAULT_OFFSET,
      BOOKING_RESERVATION_LIST_DEFAULT_OFFSET,
      Number.MAX_SAFE_INTEGER,
    ),
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
