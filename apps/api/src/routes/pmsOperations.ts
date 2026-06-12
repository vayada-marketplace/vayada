import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import pg, { type QueryResult, type QueryResultRow } from "pg";

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

export type PmsOperationsCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsOperationsCommandPool = {
  connect(): Promise<PmsOperationsCommandClient>;
  end(): Promise<void>;
};

export type TargetPmsOperationsCommandRepositoryConfig = {
  connectionString: string;
  max?: number;
  pool?: PmsOperationsCommandPool;
  readRepository: PmsOperationsReadRepository;
  now?: () => Date;
};

export type PmsOperationsRoutesOptions = {
  repository: PmsOperationsReadRepository;
  checkoutChargeMarkPaidFreezeEnabled?: boolean;
  commandRepository?: PmsOperationsCommandRepository;
  allowedOrigins?: string[];
};

type PmsAssignmentRow = {
  assignmentId: string;
  guestBookingId: string;
  roomTypeId: string;
  roomId: string | null;
  position: number;
  assignmentStatus: string;
  version: string | null;
  updatedAt: Date | string;
  checkIn: string;
  checkOut: string;
};

type PmsRoomAvailabilityRow = {
  roomId: string;
  roomTypeId: string;
  status: string;
};

type PmsIdempotencyRow = {
  status: string;
  requestFingerprintHash: string;
  idempotencyMetadata: Record<string, unknown> | null;
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

export function createTargetPmsOperationsCommandRepository(
  config: TargetPmsOperationsCommandRepositoryConfig,
): PmsOperationsCommandRepository {
  if (!config.connectionString.trim()) {
    throw new Error("PMS operations command repository connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool: PmsOperationsCommandPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });
  const now = config.now ?? (() => new Date());

  return {
    async executeAssignmentCommand(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(command));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["calendar_refresh", "audit_event"],
      };

      try {
        await client.query("BEGIN");

        const replay = await findAssignmentCommandReplay(
          client,
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          if ("ok" in replay) {
            await client.query("ROLLBACK");
            return replay;
          }
          await client.query("COMMIT");
          const reservation = await config.readRepository.findReservationByGuestBookingId(
            command.propertyId,
            command.guestBookingId,
          );
          return reservation
            ? { ok: true, reservation, commandMeta: replay, replayed: true }
            : reservationNotFound(command.guestBookingId);
        }

        const insertedIdempotencyKey = await recordAssignmentCommandIdempotency(
          client,
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          const existing = await findAssignmentCommandReplay(
            client,
            command,
            keyHash,
            requestFingerprintHash,
          );
          if (existing) {
            await client.query("ROLLBACK");
            if ("ok" in existing) return existing;
            const reservation = await config.readRepository.findReservationByGuestBookingId(
              command.propertyId,
              command.guestBookingId,
            );
            return reservation
              ? { ok: true, reservation, commandMeta: existing, replayed: true }
              : reservationNotFound(command.guestBookingId);
          }
          await client.query("ROLLBACK");
          return assignmentConflict(
            "idempotency_conflict",
            "Assignment command idempotency key could not be reserved.",
          );
        }

        const mutation = await applyAssignmentCommandMutation(client, command);
        if (!mutation.ok) {
          await client.query("ROLLBACK");
          return mutation;
        }

        await enqueueAssignmentCommandSideEffects(
          client,
          command,
          commandMeta,
          keyHash,
          acceptedAt,
        );
        await completeAssignmentCommandIdempotency(
          client,
          command,
          keyHash,
          commandMeta,
          acceptedAt,
        );
        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return {
            ok: false,
            statusCode: 409,
            code: "assignment_conflict",
            message: "Assignment command conflicts with the current reservation state.",
          };
        }
        throw error;
      } finally {
        client.release();
      }

      const reservation = await config.readRepository.findReservationByGuestBookingId(
        command.propertyId,
        command.guestBookingId,
      );
      return reservation
        ? { ok: true, reservation, commandMeta }
        : reservationNotFound(command.guestBookingId);
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function findAssignmentCommandReplay(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsCommandMeta | Exclude<PmsAssignmentCommandResult, { ok: true }> | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = 'assignment_command'
       AND key_hash = $1
       AND tenant_scope = 'property'
       AND property_id = $2::uuid
     FOR UPDATE`,
    [keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return assignmentConflict(
      "idempotency_conflict",
      "Idempotency key was used with a different assignment command.",
    );
  }
  if (existing.status !== "completed") {
    return assignmentConflict("idempotency_conflict", "Assignment command is already in progress.");
  }

  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  return isPmsCommandMeta(commandMeta) ? commandMeta : null;
}

async function recordAssignmentCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  keyHash: string,
  requestFingerprintHash: string,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       property_id,
       correlation_id,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'pms',
       'assignment_command',
       $1,
       $2,
       'in_progress',
       'property',
       $3::uuid,
       $4,
       $5::timestamptz + interval '24 hours',
       $6::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.commandId,
      acceptedAt,
      JSON.stringify({ commandId: command.commandId }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function applyAssignmentCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
): Promise<{ ok: true } | Exclude<PmsAssignmentCommandResult, { ok: true }>> {
  const source = await findAssignmentForCommand(client, command);
  if (!source) return reservationNotFound(command.guestBookingId);

  if (command.expectedVersion && !assignmentVersionMatches(source, command.expectedVersion)) {
    return assignmentConflict("version_conflict", "Reservation assignment version is stale.");
  }

  if (command.action === "swap") {
    return applySwapAssignmentCommand(client, command, source);
  }

  if (command.action === "unassign") {
    const nextVersion = nextAssignmentVersion(source);
    await client.query(
      `UPDATE pms.operational_booking_assignments
       SET room_id = NULL,
           assignment_status = 'pending',
           assigned_at = NULL,
           assignment_payload = jsonb_set(
             COALESCE(assignment_payload, '{}'::jsonb),
             '{version}',
             to_jsonb($4::text),
             true
           ),
           updated_at = now()
       WHERE id = $1::uuid
         AND property_id = $2::uuid
         AND guest_booking_id = $3::uuid`,
      [source.assignmentId, command.propertyId, command.guestBookingId, nextVersion],
    );
    return { ok: true };
  }

  if (!command.roomId) {
    return assignmentConflict("room_unavailable", "Requested room is unavailable for this stay.");
  }

  await lockRoomTypeRoomsForAssignment(client, command.propertyId, source.roomTypeId);
  const room = await findAvailableRoomForAssignment(client, command.propertyId, command.roomId);
  if (!room || room.roomTypeId !== source.roomTypeId) {
    return assignmentConflict("room_unavailable", "Requested room is unavailable for this stay.");
  }

  if (!(await isRoomAvailableForStay(client, command, source))) {
    return assignmentConflict("room_unavailable", "Requested room is unavailable for this stay.");
  }

  const nextVersion = nextAssignmentVersion(source);
  await client.query(
    `UPDATE pms.operational_booking_assignments
     SET room_id = $1::uuid,
         assignment_status = 'assigned',
         assigned_at = COALESCE(assigned_at, now()),
         assignment_payload = jsonb_set(
           COALESCE(assignment_payload, '{}'::jsonb),
           '{version}',
           to_jsonb($5::text),
           true
         ),
         updated_at = now()
     WHERE id = $2::uuid
       AND property_id = $3::uuid
       AND guest_booking_id = $4::uuid`,
    [command.roomId, source.assignmentId, command.propertyId, command.guestBookingId, nextVersion],
  );
  return { ok: true };
}

async function applySwapAssignmentCommand(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  source: PmsAssignmentRow,
): Promise<{ ok: true } | Exclude<PmsAssignmentCommandResult, { ok: true }>> {
  const target = await findTargetAssignmentForSwap(client, command);
  if (!target || target.assignmentId === source.assignmentId) {
    return assignmentConflict(
      "assignment_conflict",
      "Target assignment does not belong to this reservation.",
    );
  }
  if (target.roomTypeId !== source.roomTypeId) {
    return assignmentConflict(
      "assignment_conflict",
      "Target assignment room type is incompatible.",
    );
  }

  const nextVersion = nextAssignmentVersion(source);
  await client.query(
    `UPDATE pms.operational_booking_assignments
     SET room_id = CASE id
         WHEN $1::uuid THEN $4::uuid
         WHEN $2::uuid THEN $3::uuid
       END,
       assignment_status = CASE
         WHEN CASE id WHEN $1::uuid THEN $4::uuid WHEN $2::uuid THEN $3::uuid END IS NULL
           THEN 'pending'
         ELSE 'assigned'
       END,
       assigned_at = CASE
         WHEN CASE id WHEN $1::uuid THEN $4::uuid WHEN $2::uuid THEN $3::uuid END IS NULL
           THEN NULL
         ELSE COALESCE(assigned_at, now())
       END,
       assignment_payload = jsonb_set(
         COALESCE(assignment_payload, '{}'::jsonb),
         '{version}',
         to_jsonb($7::text),
         true
       ),
       updated_at = now()
     WHERE property_id = $5::uuid
       AND guest_booking_id = $6::uuid
       AND id IN ($1::uuid, $2::uuid)`,
    [
      source.assignmentId,
      target.assignmentId,
      source.roomId,
      target.roomId,
      command.propertyId,
      command.guestBookingId,
      nextVersion,
    ],
  );
  return { ok: true };
}

async function findAssignmentForCommand(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
): Promise<PmsAssignmentRow | null> {
  const result = await client.query<PmsAssignmentRow>(
    `SELECT
       id::text AS "assignmentId",
       guest_booking_id::text AS "guestBookingId",
       room_type_id::text AS "roomTypeId",
       room_id::text AS "roomId",
       position,
       assignment_status AS "assignmentStatus",
       assignment_payload ->> 'version' AS version,
       assignment.updated_at AS "updatedAt",
       booking.check_in::text AS "checkIn",
       booking.check_out::text AS "checkOut"
     FROM pms.operational_booking_assignments assignment
     JOIN booking.guest_bookings booking
       ON booking.id = assignment.guest_booking_id
      AND booking.property_id = assignment.property_id
     WHERE assignment.property_id = $1::uuid
       AND assignment.guest_booking_id = $2::uuid
       AND (
         ($3::uuid IS NOT NULL AND assignment.id = $3::uuid)
         OR ($3::uuid IS NULL AND assignment.position = COALESCE($4::integer, 1))
       )
     LIMIT 1
     FOR UPDATE OF assignment`,
    [
      command.propertyId,
      command.guestBookingId,
      command.assignmentId ?? null,
      command.position ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

async function findTargetAssignmentForSwap(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
): Promise<PmsAssignmentRow | null> {
  const result = await client.query<PmsAssignmentRow>(
    `SELECT
       id::text AS "assignmentId",
       guest_booking_id::text AS "guestBookingId",
       room_type_id::text AS "roomTypeId",
       room_id::text AS "roomId",
       position,
       assignment_status AS "assignmentStatus",
       assignment_payload ->> 'version' AS version,
       assignment.updated_at AS "updatedAt",
       booking.check_in::text AS "checkIn",
       booking.check_out::text AS "checkOut"
     FROM pms.operational_booking_assignments assignment
     JOIN booking.guest_bookings booking
       ON booking.id = assignment.guest_booking_id
      AND booking.property_id = assignment.property_id
     WHERE assignment.property_id = $1::uuid
       AND assignment.guest_booking_id = $2::uuid
       AND (
         ($3::uuid IS NOT NULL AND assignment.id = $3::uuid)
         OR ($3::uuid IS NULL AND assignment.position = $4::integer)
       )
     LIMIT 1
     FOR UPDATE OF assignment`,
    [
      command.propertyId,
      command.guestBookingId,
      command.targetAssignmentId ?? null,
      command.targetPosition ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

async function findAvailableRoomForAssignment(
  client: PmsOperationsCommandClient,
  propertyId: string,
  roomId: string,
): Promise<PmsRoomAvailabilityRow | null> {
  const result = await client.query<PmsRoomAvailabilityRow>(
    `SELECT
       id::text AS "roomId",
       room_type_id::text AS "roomTypeId",
       status
     FROM pms.rooms
     WHERE property_id = $1::uuid
       AND id = $2::uuid
       AND status = 'available'
     LIMIT 1`,
    [propertyId, roomId],
  );
  return result.rows[0] ?? null;
}

async function lockRoomTypeRoomsForAssignment(
  client: PmsOperationsCommandClient,
  propertyId: string,
  roomTypeId: string,
): Promise<void> {
  await client.query(
    `SELECT id
     FROM pms.rooms
     WHERE property_id = $1::uuid
       AND room_type_id = $2::uuid
     ORDER BY id
     FOR UPDATE`,
    [propertyId, roomTypeId],
  );
}

async function isRoomAvailableForStay(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  source: PmsAssignmentRow,
): Promise<boolean> {
  if (!command.roomId) return false;
  const result = await client.query(
    `WITH stay_dates AS (
       SELECT generate_series($4::date, $5::date - interval '1 day', interval '1 day')::date AS stay_date
     ),
     overlapping_assignments AS (
       SELECT 1
       FROM pms.operational_booking_assignments other_assignment
       JOIN booking.guest_bookings other_booking
         ON other_booking.id = other_assignment.guest_booking_id
        AND other_booking.property_id = other_assignment.property_id
       WHERE other_assignment.property_id = $1::uuid
         AND other_assignment.room_id = $2::uuid
         AND other_assignment.id <> $3::uuid
         AND other_assignment.assignment_status IN ('assigned', 'checked_in', 'in_house')
         AND daterange(other_booking.check_in, other_booking.check_out, '[)') &&
             daterange($4::date, $5::date, '[)')
       LIMIT 1
     ),
     room_specific_blocks AS (
       SELECT 1
       FROM pms.room_blocks block
       WHERE block.property_id = $1::uuid
         AND block.room_type_id = $6::uuid
         AND block.status = 'active'
         AND block.room_id = $2::uuid
         AND daterange(block.starts_on, block.ends_on + 1, '[)') &&
             daterange($4::date, $5::date, '[)')
       LIMIT 1
     ),
     room_type_capacity AS (
       SELECT COUNT(*)::integer AS total_count
       FROM pms.rooms room
       WHERE room.property_id = $1::uuid
         AND room.room_type_id = $6::uuid
         AND room.status = 'available'
     ),
     assigned_by_date AS (
       SELECT
         stay_dates.stay_date,
         COUNT(DISTINCT CASE
           WHEN other_booking.id IS NOT NULL THEN other_assignment.room_id
         END)::integer AS assigned_count
       FROM stay_dates
       LEFT JOIN pms.operational_booking_assignments other_assignment
         ON other_assignment.property_id = $1::uuid
        AND other_assignment.room_type_id = $6::uuid
        AND other_assignment.room_id IS NOT NULL
        AND other_assignment.id <> $3::uuid
        AND other_assignment.assignment_status IN ('assigned', 'checked_in', 'in_house')
       LEFT JOIN booking.guest_bookings other_booking
         ON other_booking.id = other_assignment.guest_booking_id
        AND other_booking.property_id = other_assignment.property_id
        AND daterange(other_booking.check_in, other_booking.check_out, '[)') @> stay_dates.stay_date
       GROUP BY stay_dates.stay_date
     ),
     type_blocked_by_date AS (
       SELECT
         stay_dates.stay_date,
         COALESCE(SUM(block.blocked_count), 0)::integer AS blocked_count
       FROM stay_dates
       LEFT JOIN pms.room_blocks block
         ON block.property_id = $1::uuid
        AND block.room_type_id = $6::uuid
        AND block.room_id IS NULL
        AND block.status = 'active'
        AND daterange(block.starts_on, block.ends_on + 1, '[)') @> stay_dates.stay_date
       GROUP BY stay_dates.stay_date
     ),
     type_capacity_sold_out AS (
       SELECT 1
       FROM stay_dates
       CROSS JOIN room_type_capacity
       JOIN assigned_by_date USING (stay_date)
       JOIN type_blocked_by_date USING (stay_date)
       WHERE assigned_by_date.assigned_count + type_blocked_by_date.blocked_count >=
             room_type_capacity.total_count
       LIMIT 1
     )
     SELECT 1
     WHERE NOT EXISTS (SELECT 1 FROM overlapping_assignments)
       AND NOT EXISTS (SELECT 1 FROM room_specific_blocks)
       AND NOT EXISTS (SELECT 1 FROM type_capacity_sold_out)`,
    [
      command.propertyId,
      command.roomId,
      source.assignmentId,
      source.checkIn,
      source.checkOut,
      source.roomTypeId,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function enqueueAssignmentCommandSideEffects(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  commandMeta: PmsCommandMeta,
  keyHash: string,
  acceptedAt: string,
): Promise<void> {
  const domainEvent = await client.query<{ eventId: string }>(
    `WITH inserted AS (
       INSERT INTO platform.domain_events (
         source_system,
         event_key,
         event_type,
         event_version,
         occurred_at,
         tenant_scope,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         causation_id,
         idempotency_key_hash,
         payload,
         event_metadata
       )
       VALUES (
         'pms',
         $1,
         'pms.assignment.changed',
         1,
         $2::timestamptz,
         'property',
         $3::uuid,
         'pms',
         'operational_booking_assignment',
         $4,
         $5,
         $6,
         $7,
         $8::jsonb,
         $9::jsonb
       )
       ON CONFLICT (source_system, event_key) DO NOTHING
       RETURNING id::text AS "eventId"
     )
     SELECT "eventId" FROM inserted
     UNION ALL
     SELECT id::text AS "eventId"
     FROM platform.domain_events
     WHERE source_system = 'pms'
       AND event_key = $1
     LIMIT 1`,
    [
      `pms.assignment.${command.idempotencyKey}.v1`,
      acceptedAt,
      command.propertyId,
      command.assignmentId ?? command.guestBookingId,
      command.commandId,
      command.commandId,
      keyHash,
      JSON.stringify({ command, commandMeta }),
      JSON.stringify({ contractVersion: PMS_OPERATIONS_CONTRACT_VERSION }),
    ],
  );

  await client.query(
    `INSERT INTO platform.outbox_events (
       domain_event_id,
       outbox_key,
       destination,
       event_type,
       tenant_scope,
       property_id,
       resource_product,
       resource_type,
       resource_id,
       correlation_id,
       idempotency_key_hash,
       payload,
       outbox_metadata
     )
     VALUES (
       $1::uuid,
       $2,
       'pms.calendar-projection',
       'pms.calendar.refresh_requested',
       'property',
       $3::uuid,
       'pms',
       'operational_booking',
       $4,
       $5,
       $6,
       $7::jsonb,
       $8::jsonb
     )
     ON CONFLICT (destination, outbox_key) DO NOTHING`,
    [
      domainEvent.rows[0]!.eventId,
      `pms.calendar_refresh.${command.idempotencyKey}.v1`,
      command.propertyId,
      command.guestBookingId,
      command.commandId,
      keyHash,
      JSON.stringify({
        propertyId: command.propertyId,
        guestBookingId: command.guestBookingId,
        action: command.action,
      }),
      JSON.stringify({ sideEffects: commandMeta.sideEffects }),
    ],
  );
}

async function completeAssignmentCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  keyHash: string,
  commandMeta: PmsCommandMeta,
  acceptedAt: string,
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = 200,
         response_resource_product = 'pms',
         response_resource_type = 'operational_booking',
         response_resource_id = $1,
         response_body_hash = $2,
         completed_at = $3::timestamptz,
         last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms'
       AND operation = 'assignment_command'
       AND key_hash = $5
       AND tenant_scope = 'property'
       AND property_id = $6::uuid`,
    [
      command.guestBookingId,
      sha256(stableJson(commandMeta)),
      acceptedAt,
      JSON.stringify({ commandMeta }),
      keyHash,
      command.propertyId,
    ],
  );
}

function assignmentVersionMatches(row: PmsAssignmentRow, expectedVersion: string): boolean {
  const updatedAt =
    row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt);
  return expectedVersion === row.version || expectedVersion === updatedAt;
}

function nextAssignmentVersion(row: PmsAssignmentRow): string {
  const match = /^reservation-v(\d+)$/.exec(row.version ?? "");
  return `reservation-v${match ? Number(match[1]) + 1 : 1}`;
}

function reservationNotFound(
  guestBookingId: string,
): Exclude<PmsAssignmentCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "reservation_not_found",
    message: `PMS reservation ${guestBookingId} was not found.`,
  };
}

function assignmentConflict(
  code: PmsAssignmentCommandConflictCode,
  message: string,
): Exclude<PmsAssignmentCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code,
    message,
  };
}

function isPmsCommandMeta(value: unknown): value is PmsCommandMeta {
  return (
    !!value &&
    typeof value === "object" &&
    (value as PmsCommandMeta).contractVersion === PMS_OPERATIONS_CONTRACT_VERSION &&
    typeof (value as PmsCommandMeta).commandId === "string" &&
    typeof (value as PmsCommandMeta).idempotencyKey === "string" &&
    typeof (value as PmsCommandMeta).acceptedAt === "string" &&
    Array.isArray((value as PmsCommandMeta).sideEffects)
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rollbackQuietly(client: PmsOperationsCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}

function isPgUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: string }).code === "23505";
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
