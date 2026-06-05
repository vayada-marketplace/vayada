import type { FastifyInstance } from "fastify";
import pg from "pg";

import { enforceRoutePolicy } from "./policy.js";

export type BookingReservationQuery = {
  status?: string;
  search?: string;
  limit?: string;
  offset?: string;
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
 * Legacy compatibility contract for PMS `GET /admin/bookings`.
 *
 * The TypeScript route keeps the same list envelope (`bookings`, `total`,
 * `limit`, `offset`) and the camelCase `BookingAdminResponse` row shape used by
 * the PMS admin frontend. Authorized hotels with no matching rows return a
 * successful empty list rather than a 404.
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

type BookingHotelParams = {
  hotelId: string;
};

type BookingReservationRow = {
  id: string;
  booking_reference: string;
  room_type_id: string;
  room_name: string;
  room_max_occupancy: number | string | null;
  guest_first_name: string;
  guest_last_name: string;
  guest_email: string;
  guest_phone: string;
  guest_country: string | null;
  guest_gender: string | null;
  guest_date_of_birth: Date | string | null;
  guest_passport_number: string | null;
  special_requests: string;
  estimated_arrival_time: string | null;
  number_of_guests: number | null;
  check_in: Date | string;
  check_out: Date | string;
  adults: number;
  children: number;
  nightly_rate: number | string;
  number_of_rooms: number | null;
  total_amount: number | string;
  currency: string;
  status: string;
  room_id: string | null;
  room_number: string | null;
  extra_assigned_rooms: BookingAssignedRoomResponse[] | string | null;
  channel: string | null;
  payment_method: string | null;
  payment_status: string | null;
  deposit_required: boolean | null;
  deposit_percentage: number | null;
  deposit_amount: number | string | null;
  balance_amount: number | string | null;
  check_in_pending_flags: string[] | string | null;
  checked_in_at: Date | string | null;
  checked_out_at: Date | string | null;
  host_response_deadline: Date | string | null;
  platform_fee_amount: number | string | null;
  affiliate_commission_amount: number | string | null;
  property_payout_amount: number | string | null;
  addon_ids: string[] | string | null;
  addon_names: string[] | string | null;
  addon_total: number | string | null;
  addon_quantities: Record<string, number> | string | null;
  addon_dates: Record<string, string[]> | string | null;
  guest_withdrawn: boolean | null;
  promo_code: string | null;
  promo_discount: number | string | null;
  last_minute_discount_percent: number | string | null;
  last_minute_discount_amount: number | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export function createPgBookingReservationsReadRepository(config: {
  connectionString: string;
  max?: number;
}): BookingReservationsReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Booking reservations repository connectionString must not be empty");
  }

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async listReservationsByHotelId(hotelId, filters) {
      const conditions = ["b.hotel_id = $1"];
      const args: Array<string | number> = [hotelId];
      let nextIndex = 2;

      if (filters.status) {
        conditions.push(`b.status = $${nextIndex}`);
        args.push(filters.status);
        nextIndex += 1;
      }

      if (filters.search) {
        conditions.push(
          `(b.guest_first_name ILIKE $${nextIndex}
            OR b.guest_last_name ILIKE $${nextIndex}
            OR CONCAT(b.guest_first_name, ' ', b.guest_last_name) ILIKE $${nextIndex}
            OR b.booking_reference ILIKE $${nextIndex}
            OR b.guest_email ILIKE $${nextIndex}
            OR rt.name ILIKE $${nextIndex})`,
        );
        args.push(`%${filters.search}%`);
        nextIndex += 1;
      }

      const where = conditions.join(" AND ");
      const listArgs = [...args, filters.limit, filters.offset];
      const result = await pool.query<BookingReservationRow>(
        `WITH extra_rooms AS (
           SELECT
             br.booking_id,
             jsonb_agg(
               jsonb_build_object(
                 'roomId', br.room_id::text,
                 'roomNumber', extra_rm.room_number,
                 'position', br.position
               )
               ORDER BY br.position
             ) AS rooms
           FROM booking_rooms br
           LEFT JOIN rooms extra_rm ON extra_rm.id = br.room_id
           GROUP BY br.booking_id
         )
         SELECT
           b.id::text,
           b.booking_reference,
           b.room_type_id::text,
           rt.name AS room_name,
           rt.max_occupancy AS room_max_occupancy,
           b.guest_first_name,
           b.guest_last_name,
           b.guest_email,
           b.guest_phone,
           b.guest_country,
           b.guest_gender,
           b.guest_date_of_birth,
           b.guest_passport_number,
           b.special_requests,
           b.estimated_arrival_time,
           b.number_of_guests,
           b.check_in,
           b.check_out,
           b.adults,
           b.children,
           b.nightly_rate,
           b.number_of_rooms,
           b.total_amount,
           b.currency,
           b.status,
           b.room_id::text,
           rm.room_number,
           COALESCE(extra_rooms.rooms, '[]'::jsonb) AS extra_assigned_rooms,
           b.channel,
           b.payment_method,
           b.payment_status,
           b.deposit_required,
           b.deposit_percentage,
           b.deposit_amount,
           b.balance_amount,
           b.check_in_pending_flags,
           b.checked_in_at,
           b.checked_out_at,
           b.host_response_deadline,
           b.platform_fee_amount,
           b.affiliate_commission_amount,
           b.property_payout_amount,
           b.addon_ids,
           b.addon_names,
           b.addon_total,
           b.addon_quantities,
           b.addon_dates,
           b.guest_withdrawn,
           b.promo_code,
           b.promo_discount,
           b.last_minute_discount_percent,
           b.last_minute_discount_amount,
           b.created_at,
           b.updated_at
         FROM bookings b
         JOIN room_types rt ON rt.id = b.room_type_id
         LEFT JOIN rooms rm ON rm.id = b.room_id
         LEFT JOIN extra_rooms ON extra_rooms.booking_id = b.id
         WHERE ${where}
         ORDER BY b.created_at DESC
         LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
        listArgs,
      );

      const countConditions = ["hotel_id = $1"];
      const countArgs: string[] = [hotelId];
      if (filters.status) {
        countConditions.push("status = $2");
        countArgs.push(filters.status);
      }
      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM bookings
         WHERE ${countConditions.join(" AND ")}`,
        countArgs,
      );

      return {
        reservations: result.rows.map(toReadModel),
        total: Number(countResult.rows[0]?.count ?? 0),
      };
    },
    async close() {
      await pool.end();
    },
  };
}

export async function registerBookingReservationRoutes(
  app: FastifyInstance,
  repository: BookingReservationsReadRepository,
): Promise<void> {
  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{ Params: BookingHotelParams; Querystring: BookingReservationQuery }>(
    "/hotels/:hotelId/reservations",
    async (request) => {
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
    },
  );
}

export function toReservationResponse(
  reservation: BookingReservationReadModel,
): BookingReservationResponse {
  const checkIn = toDateOnly(reservation.checkIn);
  const checkOut = toDateOnly(reservation.checkOut);
  const numberOfRooms = Math.max(1, reservation.numberOfRooms ?? 1);
  const roomMaxOccupancy = Math.max(1, Number(reservation.roomMaxOccupancy || 1));
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

function toReservationFilters(query: BookingReservationQuery): BookingReservationListFilters {
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

function toReadModel(row: BookingReservationRow): BookingReservationReadModel {
  return {
    id: row.id,
    bookingReference: row.booking_reference,
    roomTypeId: row.room_type_id,
    roomName: row.room_name,
    roomMaxOccupancy: Number(row.room_max_occupancy ?? 1),
    guestFirstName: row.guest_first_name,
    guestLastName: row.guest_last_name,
    guestEmail: row.guest_email,
    guestPhone: row.guest_phone,
    guestCountry: row.guest_country,
    guestGender: row.guest_gender,
    guestDateOfBirth: row.guest_date_of_birth,
    guestPassportNumber: row.guest_passport_number,
    specialRequests: row.special_requests,
    estimatedArrivalTime: row.estimated_arrival_time,
    numberOfGuests: row.number_of_guests,
    checkIn: row.check_in,
    checkOut: row.check_out,
    adults: row.adults,
    children: row.children,
    nightlyRate: row.nightly_rate,
    numberOfRooms: row.number_of_rooms,
    totalAmount: row.total_amount,
    currency: row.currency,
    status: row.status,
    roomId: row.room_id,
    roomNumber: row.room_number,
    assignedRooms: row.extra_assigned_rooms,
    channel: row.channel,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    depositRequired: row.deposit_required,
    depositPercentage: row.deposit_percentage,
    depositAmount: row.deposit_amount,
    balanceAmount: row.balance_amount,
    checkInPendingFlags: row.check_in_pending_flags,
    checkedInAt: row.checked_in_at,
    checkedOutAt: row.checked_out_at,
    hostResponseDeadline: row.host_response_deadline,
    platformFeeAmount: row.platform_fee_amount,
    affiliateCommissionAmount: row.affiliate_commission_amount,
    propertyPayoutAmount: row.property_payout_amount,
    addonIds: row.addon_ids,
    addonNames: row.addon_names,
    addonTotal: row.addon_total,
    addonQuantities: row.addon_quantities,
    addonDates: row.addon_dates,
    guestWithdrawn: row.guest_withdrawn,
    promoCode: row.promo_code,
    promoDiscount: row.promo_discount,
    lastMinuteDiscountPercent: row.last_minute_discount_percent,
    lastMinuteDiscountAmount: row.last_minute_discount_amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  return typeof value === "number" ? value : Number(value);
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  return toNumber(value);
}

function toDateOnly(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return value.slice(0, 10);
}

function toIsoDateTime(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function toIsoDateTimeOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return toIsoDateTime(value);
}

function daysBetween(start: string, end: string): number {
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  return Math.max(0, Math.round((endTime - startTime) / 86_400_000));
}
