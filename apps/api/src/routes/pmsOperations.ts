import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  PmsCalendarDay,
  PmsOperationsReadRepository,
  PmsOperationalReservation,
  PmsReservationListFilters,
  PmsRoomBlockSummary,
  PmsRoom,
  PmsRoomType,
  PmsSourceFreshness,
} from "../domains/pmsOperationsReadModel.js";
import { enforceRoutePolicy } from "./policy.js";

export const PMS_OPERATIONS_CONTRACT_VERSION = "pms-operations.v1" as const;

export type PmsOperationsContractVersion = typeof PMS_OPERATIONS_CONTRACT_VERSION;
export type {
  PmsCalendarDay,
  PmsOperationsReadRepository,
  PmsOperationalReservation,
  PmsRoomBlockSummary,
  PmsRoom,
  PmsRoomType,
} from "../domains/pmsOperationsReadModel.js";

export const PMS_RESERVATION_LIST_DEFAULT_LIMIT = 50;
export const PMS_RESERVATION_LIST_MIN_LIMIT = 1;
export const PMS_RESERVATION_LIST_MAX_LIMIT = 500;
export const PMS_RESERVATION_LIST_DEFAULT_OFFSET = 0;
export const PMS_CALENDAR_MAX_RANGE_DAYS = 370;

export type PmsRoomsResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: PmsRoom[];
  sourceFreshness: PmsSourceFreshness;
};

export type PmsRoomTypesResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: PmsRoomType[];
  sourceFreshness: PmsSourceFreshness;
};

export type PmsRoomTypeDetailResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  item: PmsRoomType;
  sourceFreshness: PmsSourceFreshness;
};

export type PmsCalendarResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  days: PmsCalendarDay[];
  sourceFreshness: PmsSourceFreshness;
};

export type PmsRoomBlocksResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: PmsRoomBlockSummary[];
  sourceFreshness: PmsSourceFreshness;
};

export type PmsReservationListResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: PmsOperationalReservation[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
  sourceFreshness: PmsSourceFreshness;
};

export type PmsReservationDetailResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  item: PmsOperationalReservation;
  sourceFreshness: PmsSourceFreshness;
};

export type PmsAssignmentCommandAction = "assign" | "move" | "unassign" | "swap";
export type PmsAssignmentCommandSideEffect = "calendar_refresh" | "ari_changed" | "audit_event";

export type PmsCommandMeta = {
  contractVersion: PmsOperationsContractVersion;
  commandId: string;
  idempotencyKey: string;
  acceptedAt: string;
  sideEffects: PmsAssignmentCommandSideEffect[];
};

export type PmsAssignmentCommandRequest = {
  commandId: string;
  idempotencyKey: string;
  expectedVersion?: string;
  action?: PmsAssignmentCommandAction;
  assignmentId?: string;
  position?: number;
  roomId?: string | null;
  targetAssignmentId?: string;
  targetPosition?: number;
};

export type PmsAssignmentCommand = PmsAssignmentCommandRequest & {
  propertyId: string;
  guestBookingId: string;
  action: PmsAssignmentCommandAction;
};

export type PmsAssignmentCommandResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  reservation: PmsOperationalReservation;
  commandMeta: PmsCommandMeta;
};

export type PmsAssignmentCommandConflictCode =
  | "version_conflict"
  | "room_unavailable"
  | "assignment_conflict"
  | "idempotency_conflict";

export type PmsAssignmentCommandResult =
  | {
      ok: true;
      reservation: PmsOperationalReservation;
      commandMeta: PmsCommandMeta;
      replayed?: boolean;
    }
  | {
      ok: false;
      statusCode: 404;
      code: "reservation_not_found";
      message: string;
    }
  | {
      ok: false;
      statusCode: 409;
      code: PmsAssignmentCommandConflictCode;
      message: string;
    };

export type PmsOperationsCommandRepository = {
  executeAssignmentCommand(command: PmsAssignmentCommand): Promise<PmsAssignmentCommandResult>;
  close?(): Promise<void>;
};

export type PmsOperationsRoutesOptions = {
  repository: PmsOperationsReadRepository;
  checkoutChargeMarkPaidFreezeEnabled?: boolean;
  commandRepository?: PmsOperationsCommandRepository;
  allowedOrigins?: string[];
};

type PmsPropertyParams = {
  propertyId: string;
};

type PmsRoomTypeParams = PmsPropertyParams & {
  roomTypeId: string;
};

type PmsReservationParams = PmsPropertyParams & {
  guestBookingId: string;
};

type PmsCheckoutChargeParams = PmsReservationParams & {
  chargeId: string;
};

type PmsCalendarQuery = {
  from?: string;
  to?: string;
};

type PmsRoomBlocksQuery = {
  from?: string;
  to?: string;
};

type PmsReservationListQuery = {
  status?: string;
  arrivalFrom?: string;
  arrivalTo?: string;
  search?: string;
  limit?: string;
  offset?: string;
};

type PmsCheckoutChargeMarkPaidBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
};

type PmsOperationsErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "conflict"
  | "read_model"
  | "not_found";

type PmsOperationsErrorCode =
  | "unauthenticated"
  | "invalid_token"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "invalid_query"
  | "invalid_body"
  | "invalid_date_range"
  | "finance_bridge_required"
  | PmsAssignmentCommandConflictCode
  | "read_model_unavailable"
  | "room_type_not_found"
  | "reservation_not_found";

type PmsOperationsError = {
  statusCode: 400 | 401 | 403 | 404 | 409 | 500;
  code: PmsOperationsErrorCode;
  category: PmsOperationsErrorCategory;
  message: string;
};

type PmsOperationsAuthorizationErrorCode = Exclude<
  PmsOperationsErrorCode,
  | "unauthenticated"
  | "invalid_token"
  | "invalid_query"
  | "invalid_body"
  | "invalid_date_range"
  | "finance_bridge_required"
  | PmsAssignmentCommandConflictCode
  | "read_model_unavailable"
  | "room_type_not_found"
  | "reservation_not_found"
>;

export async function registerPmsOperationsRoutes(
  app: FastifyInstance,
  options: PmsOperationsRoutesOptions,
): Promise<void> {
  const { repository, commandRepository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
    await commandRepository?.close?.();
  });

  for (const path of [
    "/properties/:propertyId/rooms",
    "/properties/:propertyId/room-types",
    "/properties/:propertyId/room-types/:roomTypeId",
    "/properties/:propertyId/calendar",
    "/properties/:propertyId/room-blocks",
    "/properties/:propertyId/reservations",
    "/properties/:propertyId/reservations/:guestBookingId",
    "/properties/:propertyId/reservations/:guestBookingId/checkout-charges/:chargeId/paid",
    "/properties/:propertyId/reservations/:guestBookingId/assignments",
  ]) {
    app.options(path, async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      return reply.code(204).send();
    });
  }

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/rooms",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      try {
        const result = await repository.listRoomsByPropertyId(propertyId);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsRoomsResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS rooms read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/room-types",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      try {
        const result = await repository.listRoomTypesByPropertyId(propertyId);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsRoomTypesResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS room types read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsRoomTypeParams }>(
    "/properties/:propertyId/room-types/:roomTypeId",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId, roomTypeId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      try {
        const item = await repository.findRoomTypeById(propertyId, roomTypeId);
        if (!item) {
          return sendPmsOperationsError(reply, {
            statusCode: 404,
            code: "room_type_not_found",
            category: "not_found",
            message: "PMS room type not found.",
          });
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          item,
          sourceFreshness: {},
        } satisfies PmsRoomTypeDetailResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS room types read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsPropertyParams; Querystring: PmsCalendarQuery }>(
    "/properties/:propertyId/calendar",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      const range = toCalendarRange(request.query);
      if ("error" in range) return sendPmsOperationsError(reply, range.error);

      try {
        const result = await repository.listCalendarDaysByPropertyId(propertyId, range.value);
        if (!result.items.every(hasBalancedCalendarCounts)) {
          return sendPmsOperationsError(
            reply,
            readModelUnavailable("PMS calendar read model is unavailable."),
          );
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          days: result.items,
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsCalendarResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS calendar read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsPropertyParams; Querystring: PmsRoomBlocksQuery }>(
    "/properties/:propertyId/room-blocks",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      const range = toOptionalDateRange(request.query);
      if ("error" in range) return sendPmsOperationsError(reply, range.error);

      try {
        const result = await repository.listRoomBlocksByPropertyId(propertyId, range.value);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsRoomBlocksResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS room blocks read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsPropertyParams; Querystring: PmsReservationListQuery }>(
    "/properties/:propertyId/reservations",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      const filters = toReservationFilters(request.query);
      if ("error" in filters) return sendPmsOperationsError(reply, filters.error);

      try {
        const result = await repository.listReservationsByPropertyId(propertyId, filters.value);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          pagination: {
            total: result.total,
            limit: filters.value.limit,
            offset: filters.value.offset,
          },
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsReservationListResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS reservations read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsReservationParams }>(
    "/properties/:propertyId/reservations/:guestBookingId",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId, guestBookingId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      try {
        const item = await repository.findReservationByGuestBookingId(propertyId, guestBookingId);
        if (!item) {
          return sendPmsOperationsError(reply, {
            statusCode: 404,
            code: "reservation_not_found",
            category: "not_found",
            message: "PMS reservation not found.",
          });
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          item,
          sourceFreshness: {},
        } satisfies PmsReservationDetailResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS reservations read model is unavailable."),
        );
      }
    },
  );

  app.post<{ Params: PmsCheckoutChargeParams; Body: PmsCheckoutChargeMarkPaidBody }>(
    "/properties/:propertyId/reservations/:guestBookingId/checkout-charges/:chargeId/paid",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

      const commandInput = toCheckoutChargeMarkPaidCommandMetadata(request.body);
      if ("error" in commandInput) return sendPmsOperationsError(reply, commandInput.error);

      const freezeEnabled = options.checkoutChargeMarkPaidFreezeEnabled ?? true;
      if (freezeEnabled) {
        return sendPmsOperationsError(reply, {
          statusCode: 409,
          code: "finance_bridge_required",
          category: "conflict",
          message: "Finance settlement bridge is required before marking checkout charges paid.",
        });
      }

      return sendPmsOperationsError(reply, {
        statusCode: 500,
        code: "read_model_unavailable",
        category: "read_model",
        message:
          "PMS checkout charge mark-paid must be wired to a durable command service before the freeze can be disabled.",
      });
    },
  );

  if (commandRepository) {
    app.patch<{ Params: PmsReservationParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/assignments",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toAssignmentCommand(propertyId, guestBookingId, request.body);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await commandRepository.executeAssignmentCommand(command.value);
        if (!result.ok) {
          return sendPmsOperationsError(reply, {
            statusCode: result.statusCode,
            code: result.code,
            category: result.statusCode === 404 ? "not_found" : "conflict",
            message: result.message,
          });
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          reservation: result.reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsAssignmentCommandResponse;
      },
    );
  }
}

function enforcePmsOperationsReadPolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
): boolean {
  try {
    enforceRoutePolicy(request, {
      permission: "pms.operations.read",
      entitlement: {
        product: "pms",
        key: "property-management",
        resource: {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
        },
      },
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator", "front_desk"],
      },
    });
    return true;
  } catch (error) {
    const contractError = toPmsOperationsAccessError(error, request, propertyId);
    if (!contractError) throw error;
    sendPmsOperationsError(reply, contractError);
    return false;
  }
}

function enforcePmsOperationsManagePolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
): boolean {
  try {
    enforceRoutePolicy(request, {
      permission: "pms.operations.manage",
      entitlement: {
        product: "pms",
        key: "property-management",
        resource: {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
        },
      },
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator", "front_desk"],
      },
    });
    return true;
  } catch (error) {
    const contractError = toPmsOperationsAccessError(error, request, propertyId);
    if (!contractError) throw error;
    sendPmsOperationsError(reply, contractError);
    return false;
  }
}

function sendPmsOperationsError(reply: FastifyReply, error: PmsOperationsError): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function writePmsOperationsCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: string[],
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.includes(origin)) return false;
  reply
    .header("Access-Control-Allow-Origin", origin)
    .header("Access-Control-Allow-Headers", "authorization,content-type,x-hotel-id")
    .header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS")
    .header("Vary", "Origin");
  return true;
}

function toCheckoutChargeMarkPaidCommandMetadata(body: PmsCheckoutChargeMarkPaidBody):
  | {
      value: {
        commandId: string;
        idempotencyKey: string;
      };
    }
  | { error: PmsOperationsError } {
  const commandId = nonEmptyString(body.commandId);
  const idempotencyKey = nonEmptyString(body.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return { error: invalidBody("Checkout charge mark-paid requires command metadata.") };
  }

  return {
    value: {
      commandId,
      idempotencyKey,
    },
  };
}

function invalidBody(message: string): PmsOperationsError {
  return {
    statusCode: 400,
    code: "invalid_body",
    category: "validation",
    message,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readModelUnavailable(message: string): PmsOperationsError {
  return {
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    message,
  };
}

function toCalendarRange(
  query: PmsCalendarQuery,
): { value: { from: string; to: string } } | { error: PmsOperationsError } {
  if (!query.from || !query.to) {
    return {
      error: {
        statusCode: 400,
        code: "invalid_query",
        category: "validation",
        message: "Calendar requires from and to date query parameters.",
      },
    };
  }

  const range = toRequiredDateRange(query.from, query.to);
  if ("error" in range) return range;

  const days = daysInclusive(range.value.from, range.value.to);
  if (days > PMS_CALENDAR_MAX_RANGE_DAYS) {
    return {
      error: {
        statusCode: 400,
        code: "invalid_date_range",
        category: "validation",
        message: "Calendar date range cannot exceed 370 days.",
      },
    };
  }

  return range;
}

function toOptionalDateRange(
  query: PmsRoomBlocksQuery,
): { value: { from?: string; to?: string } | undefined } | { error: PmsOperationsError } {
  const from = query.from?.trim() || undefined;
  const to = query.to?.trim() || undefined;
  if (!from && !to) return { value: undefined };

  if (from && !isDateOnly(from)) {
    return { error: invalidDateRangeError() };
  }
  if (to && !isDateOnly(to)) {
    return { error: invalidDateRangeError() };
  }
  if (from && to && daysInclusive(from, to) < 1) {
    return { error: invalidDateRangeError() };
  }

  return { value: { from, to } };
}

function toRequiredDateRange(
  rawFrom: string,
  rawTo: string,
): { value: { from: string; to: string } } | { error: PmsOperationsError } {
  const from = rawFrom.trim();
  const to = rawTo.trim();
  if (!isDateOnly(from) || !isDateOnly(to) || daysInclusive(from, to) < 1) {
    return { error: invalidDateRangeError() };
  }

  return { value: { from, to } };
}

function invalidDateRangeError(): PmsOperationsError {
  return {
    statusCode: 400,
    code: "invalid_date_range",
    category: "validation",
    message: "Invalid PMS operations date range.",
  };
}

function toReservationFilters(
  query: PmsReservationListQuery,
): { value: PmsReservationListFilters } | { error: PmsOperationsError } {
  const arrivalFrom = query.arrivalFrom?.trim() || undefined;
  const arrivalTo = query.arrivalTo?.trim() || undefined;

  if (arrivalFrom && !isDateOnly(arrivalFrom)) {
    return { error: invalidReservationQueryError() };
  }
  if (arrivalTo && !isDateOnly(arrivalTo)) {
    return { error: invalidReservationQueryError() };
  }
  if (arrivalFrom && arrivalTo && daysInclusive(arrivalFrom, arrivalTo) < 1) {
    return { error: invalidReservationQueryError() };
  }

  return {
    value: {
      status: query.status?.trim() || undefined,
      arrivalFrom,
      arrivalTo,
      search: query.search?.trim() || undefined,
      limit: clampInteger(
        query.limit,
        PMS_RESERVATION_LIST_DEFAULT_LIMIT,
        PMS_RESERVATION_LIST_MIN_LIMIT,
        PMS_RESERVATION_LIST_MAX_LIMIT,
      ),
      offset: clampInteger(
        query.offset,
        PMS_RESERVATION_LIST_DEFAULT_OFFSET,
        PMS_RESERVATION_LIST_DEFAULT_OFFSET,
        Number.MAX_SAFE_INTEGER,
      ),
    },
  };
}

function invalidReservationQueryError(): PmsOperationsError {
  return {
    statusCode: 400,
    code: "invalid_query",
    category: "validation",
    message: "Invalid PMS reservations query.",
  };
}

function toAssignmentCommand(
  propertyId: string,
  guestBookingId: string,
  body: unknown,
): { value: PmsAssignmentCommand } | { error: PmsOperationsError } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: invalidAssignmentBodyError("Assignment command body must be an object.") };
  }

  const raw = body as Record<string, unknown>;
  const commandId = stringField(raw.commandId);
  const idempotencyKey = stringField(raw.idempotencyKey);
  const expectedVersion = optionalStringField(raw.expectedVersion);
  const explicitAction = optionalStringField(raw.action);
  const inferredAction = inferAssignmentAction(raw, explicitAction);

  if (!commandId || !idempotencyKey || !inferredAction) {
    return {
      error: invalidAssignmentBodyError(
        "Assignment command requires commandId, idempotencyKey, and a valid action.",
      ),
    };
  }

  const assignmentId = optionalStringField(raw.assignmentId);
  const targetAssignmentId = optionalStringField(raw.targetAssignmentId);
  const position = optionalPositiveInteger(raw.position);
  const targetPosition = optionalPositiveInteger(raw.targetPosition);
  const roomId = nullableStringField(raw.roomId);

  for (const [field, value] of [
    ["assignmentId", assignmentId],
    ["targetAssignmentId", targetAssignmentId],
    ["roomId", roomId],
  ] as const) {
    if (value !== undefined && value !== null && !isUuid(value)) {
      return { error: invalidAssignmentBodyError(`${field} must be a UUID.`) };
    }
  }

  if ((inferredAction === "assign" || inferredAction === "move") && !roomId) {
    return { error: invalidAssignmentBodyError("Assign and move commands require roomId.") };
  }
  if (inferredAction === "unassign" && roomId !== null) {
    return { error: invalidAssignmentBodyError("Unassign commands must not include roomId.") };
  }
  if (inferredAction === "swap" && !targetAssignmentId && !targetPosition) {
    return {
      error: invalidAssignmentBodyError(
        "Swap commands require targetAssignmentId or targetPosition.",
      ),
    };
  }

  return {
    value: {
      propertyId,
      guestBookingId,
      commandId,
      idempotencyKey,
      expectedVersion,
      action: inferredAction,
      assignmentId,
      position,
      roomId,
      targetAssignmentId,
      targetPosition,
    },
  };
}

function inferAssignmentAction(
  raw: Record<string, unknown>,
  explicitAction: string | undefined,
): PmsAssignmentCommandAction | undefined {
  if (
    explicitAction === "assign" ||
    explicitAction === "move" ||
    explicitAction === "unassign" ||
    explicitAction === "swap"
  ) {
    return explicitAction;
  }
  if (raw.roomId === null) return "unassign";
  if (typeof raw.targetAssignmentId === "string" || typeof raw.targetPosition === "number") {
    return "swap";
  }
  if (typeof raw.roomId === "string" && raw.roomId.trim()) return "assign";
  return undefined;
}

function invalidAssignmentBodyError(message: string): PmsOperationsError {
  return {
    statusCode: 400,
    code: "invalid_body",
    category: "validation",
    message,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringField(value: unknown): string | undefined {
  return value === undefined ? undefined : stringField(value);
}

function nullableStringField(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalStringField(value);
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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

function hasBalancedCalendarCounts(day: PmsCalendarDay): boolean {
  return day.availableCount + day.assignedCount + day.blockedCount === day.totalCount;
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysInclusive(from: string, to: string): number {
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const toTime = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return 0;
  return Math.floor((toTime - fromTime) / 86_400_000) + 1;
}

function toPmsOperationsAccessError(
  error: unknown,
  request: FastifyRequest,
  propertyId: string,
): PmsOperationsError | null {
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

  const code = toPmsOperationsAuthorizationCode(error.message, request, propertyId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toPmsOperationsAuthorizationMessage(code),
  };
}

function toPmsOperationsAuthorizationCode(
  message: string,
  request: FastifyRequest,
  propertyId: string,
): PmsOperationsAuthorizationErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (normalized.includes("entitlement")) {
    return hasInactivePmsOperationsEntitlement(request, propertyId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "missing_resource_access";
}

function toPmsOperationsAuthorizationMessage(code: PmsOperationsAuthorizationErrorCode): string {
  switch (code) {
    case "missing_permission":
      return "Missing required PMS operations permission.";
    case "inactive_entitlement":
      return "PMS property-management entitlement is not active.";
    case "missing_entitlement":
      return "Missing active PMS property-management entitlement.";
    case "missing_resource_access":
      return "Missing PMS property access.";
  }
}

function hasInactivePmsOperationsEntitlement(request: FastifyRequest, propertyId: string): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (entitlement.product !== "pms" || entitlement.key !== "property-management") {
        return false;
      }
      if (entitlement.status === "active") return false;
      if (!entitlement.resource) return true;
      return (
        entitlement.resource.product === "pms" &&
        entitlement.resource.resourceType === "pms_property" &&
        entitlement.resource.resourceId === propertyId
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
