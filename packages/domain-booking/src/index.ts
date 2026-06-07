import {
  PMS_RESERVATION_CONTRACT_VERSION,
  type CreatePmsReservationCommand,
  type PmsAuditContext,
  type PmsExternalReference,
  type PmsGuest,
  type PmsMoney,
  type PmsProviderKey,
  type PmsReservationError,
  type PmsReservationHandoffResult,
  type PmsReservationSink,
} from "@vayada/domain-pms";

export type BookingUtcDateTime = string;
export type BookingDate = string;
export type BookingMoney = PmsMoney;

export type BookingPrimaryGuest = PmsGuest;

export type CommittedGuestBooking = {
  guestBookingId: string;
  bookingReference: string;
  propertyId: string;
  organizationId: string;
  createdAt: BookingUtcDateTime;
  locale: string;
  stay: {
    checkInDate: BookingDate;
    checkOutDate: BookingDate;
    adults: number;
    children: number;
    numberOfRooms: number;
    estimatedArrivalTime?: string | null;
    specialRequests?: string | null;
  };
  guests: {
    primary: BookingPrimaryGuest;
    additional?: BookingPrimaryGuest[];
  };
  bookedOffer: {
    roomTypeId: string;
    ratePlanId?: string | null;
    roomName: string;
    roomTypeExternalRef?: PmsExternalReference;
    ratePlanExternalRef?: PmsExternalReference;
  };
  pricing: {
    roomTotal: BookingMoney;
    taxesAndFees?: BookingMoney;
    discounts?: BookingMoney;
    addonsTotal?: BookingMoney;
    grandTotal: BookingMoney;
  };
  payment: CreatePmsReservationCommand["payment"];
  policy: CreatePmsReservationCommand["policy"];
};

export type PmsReservationConnection = {
  provider: PmsProviderKey;
  connectionId: string;
};

export type BookingHandoffActor = Pick<PmsAuditContext, "actorType" | "actorId" | "source">;

export type BookingPmsReservationHandoffInput = {
  booking: CommittedGuestBooking;
  connection: PmsReservationConnection;
  requestId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: BookingUtcDateTime;
  actor?: BookingHandoffActor;
};

export type BookingPmsHandoffStatus =
  | "pending_handoff"
  | "synced"
  | "accepted_async"
  | "duplicate_replayed"
  | "manual_review_required"
  | "retry_pending";

export type BookingPmsHandoffState = {
  guestBookingId: string;
  bookingReference: string;
  propertyId: string;
  commandId: string;
  idempotencyKey: string;
  status: BookingPmsHandoffStatus;
  outcome: PmsReservationHandoffResult["outcome"];
  pmsReservationRef?: string;
  operationalReservationId?: string;
  providerRequestId?: string;
  auditEventId: string;
  retryAfter?: BookingUtcDateTime;
  error?: PmsReservationError;
};

export class BookingPmsHandoffContractError extends Error {
  readonly code = "PMS_HANDOFF_CONTRACT_MISMATCH";

  constructor(message: string) {
    super(message);
    this.name = "BookingPmsHandoffContractError";
  }
}

export function buildCreatePmsReservationCommand(
  input: BookingPmsReservationHandoffInput,
): CreatePmsReservationCommand {
  const { booking, connection } = input;
  const idempotencyKey = buildCreateReservationIdempotencyKey({
    propertyId: booking.propertyId,
    guestBookingId: booking.guestBookingId,
  });

  return {
    contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
    commandId: buildCreateReservationCommandId(idempotencyKey),
    idempotencyKey,
    audit: {
      requestId: input.requestId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      organizationId: booking.organizationId,
      propertyId: booking.propertyId,
      actorType: input.actor?.actorType ?? "guest",
      actorId: input.actor?.actorId,
      source: input.actor?.source ?? "booking_engine",
      occurredAt: input.occurredAt,
    },
    target: {
      propertyId: booking.propertyId,
      provider: connection.provider,
      connectionId: connection.connectionId,
      requiredCapabilities: ["create_reservation"],
    },
    guestBooking: {
      guestBookingId: booking.guestBookingId,
      bookingReference: booking.bookingReference,
      status: "confirmed",
      createdAt: booking.createdAt,
      source: "direct_booking",
      locale: booking.locale,
    },
    stay: booking.stay,
    guests: booking.guests,
    bookedOffer: booking.bookedOffer,
    pricing: booking.pricing,
    payment: booking.payment,
    policy: booking.policy,
  };
}

export async function handOffCommittedBookingToPms(
  sink: Pick<PmsReservationSink, "createReservation">,
  input: BookingPmsReservationHandoffInput,
): Promise<BookingPmsHandoffState> {
  const command = buildCreatePmsReservationCommand(input);
  const result = await sink.createReservation(command);
  assertPmsResultMatchesCommand(command, result);
  return mapPmsHandoffResultToBookingState({
    booking: input.booking,
    result,
  });
}

function mapPmsHandoffResultToBookingState(input: {
  booking: Pick<CommittedGuestBooking, "guestBookingId" | "bookingReference" | "propertyId">;
  result: PmsReservationHandoffResult;
}): BookingPmsHandoffState {
  const { booking, result } = input;
  return {
    guestBookingId: booking.guestBookingId,
    bookingReference: booking.bookingReference,
    propertyId: booking.propertyId,
    commandId: result.commandId,
    idempotencyKey: result.idempotencyKey,
    status: bookingStatusForResult(result),
    outcome: result.outcome,
    pmsReservationRef: result.pmsReservationRef,
    operationalReservationId: result.operationalReservationId,
    providerRequestId: result.providerRequestId,
    auditEventId: result.auditEventId,
    retryAfter: result.retryAfter,
    error: result.outcome === "failed" ? result.error : undefined,
  };
}

export function buildCreateReservationIdempotencyKey(input: {
  propertyId: string;
  guestBookingId: string;
}): string {
  return `pms.reservation.create:property:${input.propertyId}:booking:${input.guestBookingId}:v1`;
}

function buildCreateReservationCommandId(idempotencyKey: string): string {
  return `cmd_pms_create_${stableHash(idempotencyKey).slice(0, 24)}`;
}

function stableHash(value: string): string {
  const seeds = [0x811c9dc5, 0x811c9dc5 ^ 0x9e3779b9, 0x811c9dc5 ^ 0x85ebca6b];

  return seeds
    .map((seed) => {
      let hash = seed;
      for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
      }
      return hash.toString(16).padStart(8, "0");
    })
    .join("");
}

function bookingStatusForResult(result: PmsReservationHandoffResult): BookingPmsHandoffStatus {
  switch (result.outcome) {
    case "succeeded":
      return "synced";
    case "accepted":
      return "accepted_async";
    case "duplicate_replayed":
      return "duplicate_replayed";
    case "noop":
      return "synced";
    case "failed":
      return isRetryableFailure(result.error) ? "retry_pending" : "manual_review_required";
  }
}

function assertPmsResultMatchesCommand(
  command: CreatePmsReservationCommand,
  result: PmsReservationHandoffResult,
): void {
  const mismatches: string[] = [];
  if (result.contractVersion !== command.contractVersion) {
    mismatches.push("contractVersion");
  }
  if (result.commandId !== command.commandId) {
    mismatches.push("commandId");
  }
  if (result.idempotencyKey !== command.idempotencyKey) {
    mismatches.push("idempotencyKey");
  }
  if (result.guestBookingId !== command.guestBooking.guestBookingId) {
    mismatches.push("guestBookingId");
  }

  if (mismatches.length > 0) {
    throw new BookingPmsHandoffContractError(
      `PMS reservation handoff result did not match command fields: ${mismatches.join(", ")}`,
    );
  }
}

function isRetryableFailure(error: PmsReservationError): boolean {
  if (
    error.code === "PMS_DISCONNECTED" ||
    error.code === "UNSUPPORTED_CAPABILITY" ||
    error.code === "DUPLICATE_RESERVATION" ||
    error.code === "MAPPING_MISSING" ||
    error.code === "IDEMPOTENCY_CONFLICT" ||
    error.code === "VALIDATION_FAILED" ||
    error.code === "PROVIDER_REJECTED"
  ) {
    return false;
  }

  return error.retryable;
}
