import { createHash } from "node:crypto";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { PmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import {
  PMS_OPERATIONS_CONTRACT_VERSION,
  type PmsAssignmentCommand,
  type PmsAssignmentCommandConflictCode,
  type PmsAssignmentCommandResult,
  type PmsCommandMeta,
  type PmsOperationsCommandRepository,
} from "../routes/pmsOperations.js";

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
