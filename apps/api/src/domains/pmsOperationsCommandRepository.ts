import { createHash } from "node:crypto";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { PmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import {
  PMS_OPERATIONS_CONTRACT_VERSION,
  type PmsCheckInCommand,
  type PmsAssignmentCommand,
  type PmsAssignmentCommandConflictCode,
  type PmsAssignmentCommandResult,
  type PmsCommandMeta,
  type PmsNoShowCommand,
  type PmsOperationalCommandResult,
  type PmsOperationalStatus,
  type PmsOperationalStatusCommand,
  type PmsOperationalTemplate,
  type PmsOperationalTemplateCommandResult,
  type PmsOperationalTemplateKind,
  type PmsOperationalTemplateUpdateCommand,
  type PmsTemplateStep,
  type PmsOperationsCommandSideEffect,
  type PmsOperationsCommandRepository,
  type PmsPrivateNote,
  type PmsPrivateNoteCommandResult,
  type PmsPrivateNoteCreateCommand,
  type PmsPrivateNoteDeleteCommand,
  type PmsPrivateNoteDeleteResult,
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

type PmsOperationalCommand = PmsOperationalStatusCommand | PmsCheckInCommand | PmsNoShowCommand;

type PmsOperationalCommandOperation = "status_command" | "checkin_command" | "no_show_command";
type PmsOperationalTemplateOperation =
  | "checkin_checklist_template_update"
  | "checkout_inspection_template_update";

const ALLOWED_OPERATIONAL_STATUS_TRANSITIONS: ReadonlyMap<
  string,
  ReadonlySet<PmsOperationalStatus>
> = new Map<string, ReadonlySet<PmsOperationalStatus>>([
  ["pending", new Set<PmsOperationalStatus>(["assigned"])],
  ["assigned", new Set<PmsOperationalStatus>(["checked_in", "in_house"])],
  ["checked_in", new Set<PmsOperationalStatus>(["in_house"])],
  ["in_house", new Set<PmsOperationalStatus>(["checked_out"])],
]);

type PmsPrivateNoteReplay = {
  commandMeta: PmsCommandMeta;
  noteId: string;
  note?: PmsPrivateNote;
};

type PmsPrivateNoteRow = {
  noteId: string;
  body: string;
  authorUserId: string | null;
  authorDisplayName: string;
  source: "pms" | "migration" | "system";
  createdAt: Date | string;
};

type PmsOperationalTemplateRow = {
  propertyId: string;
  steps: unknown;
  updatedByUserId: string | null;
  updatedAt: Date | string;
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
    async listPrivateNotes(propertyId, guestBookingId) {
      const client = await pool.connect();
      try {
        if (!(await reservationExists(client, propertyId, guestBookingId))) return null;
        const result = await client.query<PmsPrivateNoteRow>(
          `SELECT
             note.id::text AS "noteId",
             note.body,
             note.author_user_id::text AS "authorUserId",
             note.author_display_name AS "authorDisplayName",
             note.source,
             note.created_at AS "createdAt"
           FROM pms.booking_notes_private note
           WHERE note.property_id = $1::uuid
             AND note.guest_booking_id = $2::uuid
           ORDER BY note.created_at DESC, note.id DESC`,
          [propertyId, guestBookingId],
        );
        return result.rows.map(toPmsPrivateNote);
      } finally {
        client.release();
      }
    },

    async createPrivateNote(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(command));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["audit_event"],
      };

      try {
        await client.query("BEGIN");
        const replay = await findPrivateNoteCommandReplay(
          client,
          "private_note_create",
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          if (!replay.ok) return replay;
          return replay.note
            ? { ok: true, note: replay.note, commandMeta: replay.commandMeta, replayed: true }
            : privateNoteConflict("Private note create replay metadata is unavailable.");
        }

        if (!(await reservationExists(client, command.propertyId, command.guestBookingId))) {
          await client.query("ROLLBACK");
          return privateNoteReservationNotFound(command.guestBookingId);
        }

        const insertedIdempotencyKey = await recordPrivateNoteCommandIdempotency(
          client,
          "private_note_create",
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          await client.query("ROLLBACK");
          return privateNoteConflict(
            "Idempotency key was already used for a private note command.",
          );
        }

        const noteResult = await client.query<PmsPrivateNoteRow>(
          `INSERT INTO pms.booking_notes_private (
             property_id,
             guest_booking_id,
             author_user_id,
             author_display_name,
             body,
             source,
             created_at
           )
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'pms', $6::timestamptz)
           RETURNING
             id::text AS "noteId",
             body,
             author_user_id::text AS "authorUserId",
             author_display_name AS "authorDisplayName",
             source,
             created_at AS "createdAt"`,
          [
            command.propertyId,
            command.guestBookingId,
            command.actorUserId,
            command.authorDisplayName,
            command.body,
            acceptedAt,
          ],
        );
        const note = toPmsPrivateNote(noteResult.rows[0]!);

        await insertPrivateNoteAuditEvent(client, {
          action: "pms.private_note.created",
          auditKey: privateNoteAuditKey("created", command.propertyId, note.noteId, keyHash),
          command,
          keyHash,
          noteId: note.noteId,
          occurredAt: acceptedAt,
          privatePayload: { bodyRedacted: true, bodyLength: command.body.length },
        });
        await completePrivateNoteCommandIdempotency(
          client,
          "private_note_create",
          command.propertyId,
          keyHash,
          commandMeta,
          acceptedAt,
          note.noteId,
          note,
        );
        await client.query("COMMIT");
        return { ok: true, note, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return privateNoteConflict("Private note command conflicts with current note state.");
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async deletePrivateNote(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(command));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["audit_event"],
      };

      try {
        await client.query("BEGIN");
        const replay = await findPrivateNoteCommandReplay(
          client,
          "private_note_delete",
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          return replay.ok
            ? {
                ok: true,
                noteId: replay.noteId,
                commandMeta: replay.commandMeta,
                replayed: true,
              }
            : replay;
        }

        if (!(await reservationExists(client, command.propertyId, command.guestBookingId))) {
          await client.query("ROLLBACK");
          return privateNoteReservationNotFound(command.guestBookingId);
        }

        const insertedIdempotencyKey = await recordPrivateNoteCommandIdempotency(
          client,
          "private_note_delete",
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          await client.query("ROLLBACK");
          return privateNoteConflict(
            "Idempotency key was already used for a private note command.",
          );
        }

        const deleted = await client.query<{ noteId: string }>(
          `DELETE FROM pms.booking_notes_private
           WHERE id = $1::uuid
             AND property_id = $2::uuid
             AND guest_booking_id = $3::uuid
           RETURNING id::text AS "noteId"`,
          [command.noteId, command.propertyId, command.guestBookingId],
        );
        const noteId = deleted.rows[0]?.noteId;
        if (!noteId) {
          await client.query("ROLLBACK");
          return noteNotFound(command.noteId);
        }

        await insertPrivateNoteAuditEvent(client, {
          action: "pms.private_note.deleted",
          auditKey: privateNoteAuditKey("deleted", command.propertyId, noteId, keyHash),
          command,
          keyHash,
          noteId,
          occurredAt: acceptedAt,
          privatePayload: { deleted: true },
        });
        await completePrivateNoteCommandIdempotency(
          client,
          "private_note_delete",
          command.propertyId,
          keyHash,
          commandMeta,
          acceptedAt,
          noteId,
        );
        await client.query("COMMIT");
        return { ok: true, noteId, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return privateNoteConflict("Private note command conflicts with current note state.");
        }
        throw error;
      } finally {
        client.release();
      }
    },

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
    async executeOperationalStatusCommand(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "status_command",
        sideEffects: ["audit_event"],
        mutate: applyOperationalStatusCommandMutation,
      });
    },
    async executeCheckInCommand(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "checkin_command",
        sideEffects: ["audit_event"],
        mutate: applyCheckInCommandMutation,
      });
    },
    async executeNoShowCommand(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "no_show_command",
        sideEffects: ["audit_event"],
        mutate: applyNoShowCommandMutation,
      });
    },
    async getOperationalTemplate(propertyId, templateKind) {
      const client = await pool.connect();
      try {
        return readOperationalTemplate(client, propertyId, templateKind);
      } finally {
        client.release();
      }
    },
    async updateOperationalTemplate(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const operation = operationalTemplateOperation(command.templateKind);
      const requestFingerprintHash = sha256(stableJson(command));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["audit_event"],
      };

      try {
        await client.query("BEGIN");
        const replay = await findOperationalTemplateCommandReplay(
          client,
          command,
          operation,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          return replay;
        }

        const insertedIdempotencyKey = await recordOperationalTemplateCommandIdempotency(
          client,
          command,
          operation,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          await client.query("ROLLBACK");
          return operationalTemplateConflict(
            "Operational template idempotency key could not be reserved.",
          );
        }

        const template = await upsertOperationalTemplate(client, command, acceptedAt);
        await insertOperationalTemplateAuditEvent(client, command, template, commandMeta, keyHash);
        await completeOperationalTemplateCommandIdempotency(
          client,
          command,
          operation,
          keyHash,
          commandMeta,
          acceptedAt,
          template,
        );
        await client.query("COMMIT");
        return { ok: true, template, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return operationalTemplateConflict(
            "Operational template update conflicts with the current template state.",
          );
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function executeOperationalCommand<TCommand extends PmsOperationalCommand>(
  config: TargetPmsOperationsCommandRepositoryConfig,
  pool: PmsOperationsCommandPool,
  now: () => Date,
  options: {
    command: TCommand;
    operation: PmsOperationalCommandOperation;
    sideEffects: PmsOperationsCommandSideEffect[];
    mutate: (
      client: PmsOperationsCommandClient,
      command: TCommand,
      acceptedAt: string,
    ) => Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>>;
  },
): Promise<PmsOperationalCommandResult> {
  const { command, operation, sideEffects, mutate } = options;
  const client = await pool.connect();
  const acceptedAt = now().toISOString();
  const keyHash = sha256(command.idempotencyKey);
  const requestFingerprintHash = sha256(stableJson(operationalCommandFingerprint(command)));
  const commandMeta: PmsCommandMeta = {
    contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    acceptedAt,
    sideEffects,
  };

  try {
    await client.query("BEGIN");

    const replay = await findOperationalCommandReplay(
      client,
      command,
      operation,
      keyHash,
      requestFingerprintHash,
    );
    if (replay) {
      if ("ok" in replay) {
        await client.query("ROLLBACK");
        return replay;
      }
      await client.query("COMMIT");
      return reservationResultForCommand(config, command, replay, true);
    }

    const insertedIdempotencyKey = await recordOperationalCommandIdempotency(
      client,
      command,
      operation,
      keyHash,
      requestFingerprintHash,
      acceptedAt,
    );
    if (!insertedIdempotencyKey) {
      const existing = await findOperationalCommandReplay(
        client,
        command,
        operation,
        keyHash,
        requestFingerprintHash,
      );
      if (existing) {
        await client.query("ROLLBACK");
        if ("ok" in existing) return existing;
        return reservationResultForCommand(config, command, existing, true);
      }
      await client.query("ROLLBACK");
      return operationalConflict(
        "idempotency_conflict",
        "Operational command idempotency key could not be reserved.",
      );
    }

    const mutation = await mutate(client, command, acceptedAt);
    if (!mutation.ok) {
      await client.query("ROLLBACK");
      return mutation;
    }

    await recordOperationalCommandAuditEvent(client, command, operation, commandMeta, keyHash);
    await completeOperationalCommandIdempotency(
      client,
      command,
      operation,
      keyHash,
      commandMeta,
      acceptedAt,
    );
    await client.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(client);
    if (isPgUniqueViolation(error)) {
      return operationalConflict(
        "idempotency_conflict",
        "Operational command conflicts with the current reservation state.",
      );
    }
    throw error;
  } finally {
    client.release();
  }

  return reservationResultForCommand(config, command, commandMeta, false);
}

async function reservationExists(
  client: PmsOperationsCommandClient,
  propertyId: string,
  guestBookingId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM booking.guest_bookings booking
     WHERE booking.property_id = $1::uuid
       AND booking.id = $2::uuid
     LIMIT 1`,
    [propertyId, guestBookingId],
  );
  return (result.rowCount ?? 0) > 0;
}

function toPmsPrivateNote(row: PmsPrivateNoteRow): PmsPrivateNote {
  const createdAt =
    row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
  return {
    noteId: row.noteId,
    body: row.body,
    authorUserId: row.authorUserId,
    authorDisplayName: row.authorDisplayName,
    createdAt,
    auditMetadata: {
      source: row.source,
      createdByUserId: row.authorUserId,
      createdByDisplayName: row.authorDisplayName,
      createdAt,
      privacyScope: "internal",
    },
  };
}

async function readOperationalTemplate(
  client: PmsOperationsCommandClient,
  propertyId: string,
  templateKind: PmsOperationalTemplateKind,
): Promise<PmsOperationalTemplate> {
  const result = await client.query<PmsOperationalTemplateRow>(
    `SELECT
       property_id::text AS "propertyId",
       steps,
       updated_by_user_id::text AS "updatedByUserId",
       updated_at AS "updatedAt"
     FROM ${operationalTemplateTable(templateKind)}
     WHERE property_id = $1::uuid`,
    [propertyId],
  );
  const row = result.rows[0];
  return row
    ? toPmsOperationalTemplate(templateKind, row)
    : {
        propertyId,
        templateKind,
        steps: [],
        updatedByUserId: null,
        updatedAt: null,
      };
}

async function upsertOperationalTemplate(
  client: PmsOperationsCommandClient,
  command: PmsOperationalTemplateUpdateCommand,
  acceptedAt: string,
): Promise<PmsOperationalTemplate> {
  const result = await client.query<PmsOperationalTemplateRow>(
    `INSERT INTO ${operationalTemplateTable(command.templateKind)} (
       property_id,
       steps,
       updated_by_user_id,
       updated_at
     )
     VALUES ($1::uuid, $2::jsonb, $3::uuid, $4::timestamptz)
     ON CONFLICT (property_id) DO UPDATE
     SET steps = EXCLUDED.steps,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = EXCLUDED.updated_at
     RETURNING
       property_id::text AS "propertyId",
       steps,
       updated_by_user_id::text AS "updatedByUserId",
       updated_at AS "updatedAt"`,
    [command.propertyId, JSON.stringify(command.steps), command.actorUserId, acceptedAt],
  );
  return toPmsOperationalTemplate(command.templateKind, result.rows[0]!);
}

function operationalTemplateTable(templateKind: PmsOperationalTemplateKind): string {
  return templateKind === "check_in_checklist"
    ? "pms.checkin_checklist_templates"
    : "pms.checkout_inspection_templates";
}

function operationalTemplateOperation(
  templateKind: PmsOperationalTemplateKind,
): PmsOperationalTemplateOperation {
  return templateKind === "check_in_checklist"
    ? "checkin_checklist_template_update"
    : "checkout_inspection_template_update";
}

function toPmsOperationalTemplate(
  templateKind: PmsOperationalTemplateKind,
  row: PmsOperationalTemplateRow,
): PmsOperationalTemplate {
  const updatedAt =
    row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt);
  return {
    propertyId: row.propertyId,
    templateKind,
    steps: toPmsTemplateSteps(row.steps),
    updatedByUserId: row.updatedByUserId,
    updatedAt,
  };
}

function toPmsTemplateSteps(value: unknown): PmsTemplateStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): PmsTemplateStep | null => {
      if (!item || typeof item !== "object") return null;
      const step = item as Partial<PmsTemplateStep>;
      if (typeof step.stepId !== "string" || typeof step.label !== "string") return null;
      return {
        stepId: step.stepId,
        label: step.label,
        required: step.required === true,
      };
    })
    .filter((step): step is PmsTemplateStep => step !== null);
}

async function insertOperationalTemplateAuditEvent(
  client: PmsOperationsCommandClient,
  command: PmsOperationalTemplateUpdateCommand,
  template: PmsOperationalTemplate,
  commandMeta: PmsCommandMeta,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'pms',
       $2,
       1,
       $3::timestamptz,
       'property',
       $4::uuid,
       'user',
       $5::uuid,
       'pms',
       'operational_template',
       $6,
       $7,
       $8::jsonb,
       $9::jsonb,
       $10::jsonb,
       'standard',
       'internal'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `pms.${command.templateKind}.updated.property.${command.propertyId}.key.${keyHash}.v1`,
      `pms.${command.templateKind}.updated`,
      commandMeta.acceptedAt,
      command.propertyId,
      command.actorUserId,
      command.templateKind,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        templateKind: command.templateKind,
        stepCount: template.steps.length,
      }),
      JSON.stringify({ steps: template.steps }),
      JSON.stringify({
        commandMeta,
        idempotencyKeyHash: keyHash,
        targetOwner: operationalTemplateTable(command.templateKind),
      }),
    ],
  );
}

async function findOperationalTemplateCommandReplay(
  client: PmsOperationsCommandClient,
  command: PmsOperationalTemplateUpdateCommand,
  operation: PmsOperationalTemplateOperation,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsOperationalTemplateCommandResult | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return operationalTemplateConflict(
      "Idempotency key was used with a different operational template command.",
    );
  }
  if (existing.status !== "completed") {
    return operationalTemplateConflict("Operational template command is already in progress.");
  }

  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  const template = existing.idempotencyMetadata?.["template"];
  if (!isPmsCommandMeta(commandMeta) || !isPmsOperationalTemplate(template)) {
    return operationalTemplateConflict(
      "Operational template command replay metadata is unavailable.",
    );
  }
  return { ok: true, template, commandMeta };
}

async function recordOperationalTemplateCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsOperationalTemplateUpdateCommand,
  operation: PmsOperationalTemplateOperation,
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
       $1,
       $2,
       $3,
       'in_progress',
       'property',
       $4::uuid,
       $5,
       $6::timestamptz + interval '24 hours',
       $7::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      operation,
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.commandId,
      acceptedAt,
      JSON.stringify({ commandId: command.commandId, templateKind: command.templateKind }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function completeOperationalTemplateCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsOperationalTemplateUpdateCommand,
  operation: PmsOperationalTemplateOperation,
  keyHash: string,
  commandMeta: PmsCommandMeta,
  acceptedAt: string,
  template: PmsOperationalTemplate,
): Promise<void> {
  const idempotencyMetadata = { commandMeta, template };
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = 200,
         response_resource_product = 'pms',
         response_resource_type = 'operational_template',
         response_resource_id = $1,
         response_body_hash = $2,
         completed_at = $3::timestamptz,
         last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms'
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'property'
       AND property_id = $7::uuid`,
    [
      command.templateKind,
      sha256(stableJson(idempotencyMetadata)),
      acceptedAt,
      JSON.stringify(idempotencyMetadata),
      operation,
      keyHash,
      command.propertyId,
    ],
  );
}

async function findPrivateNoteCommandReplay(
  client: PmsOperationsCommandClient,
  operation: "private_note_create" | "private_note_delete",
  command: PmsPrivateNoteCreateCommand | PmsPrivateNoteDeleteCommand,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<
  | ({ ok: true } & PmsPrivateNoteReplay)
  | Exclude<PmsPrivateNoteCommandResult | PmsPrivateNoteDeleteResult, { ok: true }>
  | null
> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return privateNoteConflict("Idempotency key was used with a different private note command.");
  }
  if (existing.status !== "completed") {
    return privateNoteConflict("Private note command is already in progress.");
  }

  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  const noteId = existing.idempotencyMetadata?.["noteId"];
  const note = existing.idempotencyMetadata?.["note"];
  if (!isPmsCommandMeta(commandMeta) || typeof noteId !== "string") {
    return privateNoteConflict("Private note command replay metadata is unavailable.");
  }
  return isPmsPrivateNote(note)
    ? { ok: true, commandMeta, noteId, note }
    : { ok: true, commandMeta, noteId };
}

async function recordPrivateNoteCommandIdempotency(
  client: PmsOperationsCommandClient,
  operation: "private_note_create" | "private_note_delete",
  command: PmsPrivateNoteCreateCommand | PmsPrivateNoteDeleteCommand,
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
       $1,
       $2,
       $3,
       'in_progress',
       'property',
       $4::uuid,
       $5,
       $6::timestamptz + interval '24 hours',
       $7::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      operation,
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

async function insertPrivateNoteAuditEvent(
  client: PmsOperationsCommandClient,
  input: {
    action: "pms.private_note.created" | "pms.private_note.deleted";
    auditKey: string;
    command: PmsPrivateNoteCreateCommand | PmsPrivateNoteDeleteCommand;
    keyHash: string;
    noteId: string;
    occurredAt: string;
    privatePayload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       secondary_resource_product,
       secondary_resource_type,
       secondary_resource_id,
       correlation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'pms',
       $2,
       1,
       $3::timestamptz,
       'property',
       $4::uuid,
       'user',
       $5::uuid,
       'pms',
       'booking_note_private',
       $6,
       'booking',
       'guest_booking',
       $7,
       $8,
       $9::jsonb,
       $10::jsonb,
       $11::jsonb,
       'standard',
       'internal'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      input.auditKey,
      input.action,
      input.occurredAt,
      input.command.propertyId,
      input.command.actorUserId,
      input.noteId,
      input.command.guestBookingId,
      input.command.commandId,
      JSON.stringify({
        propertyId: input.command.propertyId,
        guestBookingId: input.command.guestBookingId,
        noteId: input.noteId,
        bodyRedacted: true,
      }),
      JSON.stringify(input.privatePayload),
      JSON.stringify({
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        idempotencyKeyHash: input.keyHash,
        visibility: "pms_private_only",
      }),
    ],
  );
}

async function completePrivateNoteCommandIdempotency(
  client: PmsOperationsCommandClient,
  operation: "private_note_create" | "private_note_delete",
  propertyId: string,
  keyHash: string,
  commandMeta: PmsCommandMeta,
  acceptedAt: string,
  noteId: string,
  note?: PmsPrivateNote,
): Promise<void> {
  const idempotencyMetadata = note ? { commandMeta, noteId, note } : { commandMeta, noteId };
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = 200,
         response_resource_product = 'pms',
         response_resource_type = 'booking_note_private',
         response_resource_id = $1,
         response_body_hash = $2,
         completed_at = $3::timestamptz,
         last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms'
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'property'
       AND property_id = $7::uuid`,
    [
      noteId,
      sha256(stableJson(idempotencyMetadata)),
      acceptedAt,
      JSON.stringify(idempotencyMetadata),
      operation,
      keyHash,
      propertyId,
    ],
  );
}

function privateNoteAuditKey(
  action: "created" | "deleted",
  propertyId: string,
  noteId: string,
  keyHash: string,
): string {
  return `pms.private_note.${action}.property.${propertyId}.note.${noteId}.key.${keyHash}.v1`;
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

async function findOperationalCommandReplay(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand,
  operation: PmsOperationalCommandOperation,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsCommandMeta | Exclude<PmsOperationalCommandResult, { ok: true }> | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return operationalConflict(
      "idempotency_conflict",
      "Idempotency key was used with a different PMS operational command.",
    );
  }
  if (existing.status !== "completed") {
    return operationalConflict(
      "idempotency_conflict",
      "PMS operational command is already in progress.",
    );
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

async function recordOperationalCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand,
  operation: PmsOperationalCommandOperation,
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
       $1,
       $2,
       $3,
       'in_progress',
       'property',
       $4::uuid,
       $5,
       $6::timestamptz + interval '24 hours',
       $7::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      operation,
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt,
      JSON.stringify({ commandId: command.commandId, audit: command.audit }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function applyOperationalStatusCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsOperationalStatusCommand,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const sources = await findAssignmentsForOperationalCommand(client, command);
  if (sources.length === 0) return reservationNotFound(command.guestBookingId);
  const expectedVersion = command.expectedVersion;
  if (
    expectedVersion &&
    sources.some((source) => !assignmentVersionMatches(source, expectedVersion))
  ) {
    return operationalConflict("version_conflict", "Reservation operational status is stale.");
  }
  const invalidSource = sources.find(
    (source) => !isAllowedOperationalStatusTransition(source, command.status),
  );
  if (invalidSource) {
    return invalidStatusTransition(invalidSource.assignmentStatus, command.status);
  }

  await updateAssignmentsOperationalStatus(client, command, sources, command.status);
  return { ok: true };
}

async function applyCheckInCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsCheckInCommand,
  acceptedAt: string,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const sources = await findAssignmentsForOperationalCommand(client, command);
  if (sources.length === 0) return reservationNotFound(command.guestBookingId);
  const expectedVersion = command.expectedVersion;
  if (
    expectedVersion &&
    sources.some((source) => !assignmentVersionMatches(source, expectedVersion))
  ) {
    return operationalConflict("version_conflict", "Reservation check-in version is stale.");
  }
  const invalidSource = sources.find(
    (source) => !isAllowedOperationalStatusTransition(source, "checked_in"),
  );
  if (invalidSource) {
    return invalidStatusTransition(invalidSource.assignmentStatus, "checked_in");
  }
  if (await hasExistingCheckInRecord(client, command)) {
    return invalidStatusTransition("checked_in", "checked_in");
  }

  await client.query(
    `INSERT INTO pms.booking_checkin_records (
       property_id,
       guest_booking_id,
       assignment_id,
       completed_by_user_id,
       completed_at,
       step_results,
       pending_flags
     )
     SELECT $1::uuid, $2::uuid, source.assignment_id, $3::uuid, $4::timestamptz, $5::jsonb, $6::jsonb
     FROM unnest($7::uuid[]) AS source(assignment_id)`,
    [
      command.propertyId,
      command.guestBookingId,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      acceptedAt,
      JSON.stringify(command.stepResults),
      JSON.stringify(command.pendingFlags),
      sources.map((source) => source.assignmentId),
    ],
  );
  await updateAssignmentsOperationalStatus(client, command, sources, "checked_in");
  return { ok: true };
}

async function applyNoShowCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsNoShowCommand,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const sources = await findAssignmentsForOperationalCommand(client, command);
  if (sources.length === 0) return reservationNotFound(command.guestBookingId);
  const expectedVersion = command.expectedVersion;
  if (
    expectedVersion &&
    sources.some((source) => !assignmentVersionMatches(source, expectedVersion))
  ) {
    return operationalConflict("version_conflict", "Reservation no-show version is stale.");
  }
  const invalidSource = sources.find((source) => !isAllowedNoShowTransition(source));
  if (invalidSource) {
    return invalidStatusTransition(invalidSource.assignmentStatus, "no_show");
  }

  const nextVersion = nextAssignmentVersion(sources[0]!);
  await client.query(
    `UPDATE pms.operational_booking_assignments
     SET room_id = NULL,
         assignment_status = 'released',
         assigned_at = NULL,
         assignment_payload = jsonb_set(
           jsonb_set(
             jsonb_set(
               COALESCE(assignment_payload, '{}'::jsonb),
               '{version}',
               to_jsonb($4::text),
               true
             ),
             '{operationalStatus}',
             to_jsonb('no_show'::text),
             true
           ),
           '{noShowReason}',
           to_jsonb($5::text),
           true
         ),
         updated_at = now()
     WHERE id = ANY($1::uuid[])
       AND property_id = $2::uuid
       AND guest_booking_id = $3::uuid`,
    [
      sources.map((source) => source.assignmentId),
      command.propertyId,
      command.guestBookingId,
      nextVersion,
      command.reason ?? "",
    ],
  );
  return { ok: true };
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

async function findAssignmentsForOperationalCommand(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand,
): Promise<PmsAssignmentRow[]> {
  const assignmentId = "stepResults" in command ? command.assignmentId : undefined;
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
         OR ($3::uuid IS NULL)
       )
     ORDER BY assignment.position, assignment.created_at, assignment.id
     FOR UPDATE OF assignment`,
    [command.propertyId, command.guestBookingId, assignmentId ?? null],
  );
  return result.rows;
}

async function updateAssignmentsOperationalStatus(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand,
  sources: PmsAssignmentRow[],
  status: PmsOperationalStatus,
): Promise<void> {
  const nextVersion = nextAssignmentVersion(sources[0]!);
  await client.query(
    `UPDATE pms.operational_booking_assignments
     SET assignment_status = $1,
         assignment_payload = jsonb_set(
           jsonb_set(
             COALESCE(assignment_payload, '{}'::jsonb),
             '{version}',
             to_jsonb($5::text),
             true
           ),
           '{operationalStatus}',
           to_jsonb($1::text),
           true
         ),
         updated_at = now()
     WHERE id = ANY($2::uuid[])
       AND property_id = $3::uuid
       AND guest_booking_id = $4::uuid`,
    [
      status,
      sources.map((source) => source.assignmentId),
      command.propertyId,
      command.guestBookingId,
      nextVersion,
    ],
  );
}

function isAllowedOperationalStatusTransition(
  source: PmsAssignmentRow,
  target: PmsOperationalStatus,
): boolean {
  return ALLOWED_OPERATIONAL_STATUS_TRANSITIONS.get(source.assignmentStatus)?.has(target) ?? false;
}

function isAllowedNoShowTransition(source: PmsAssignmentRow): boolean {
  return source.assignmentStatus === "pending" || source.assignmentStatus === "assigned";
}

async function hasExistingCheckInRecord(
  client: PmsOperationsCommandClient,
  command: PmsCheckInCommand,
): Promise<boolean> {
  const result = await client.query(
    `SELECT id
     FROM pms.booking_checkin_records
     WHERE property_id = $1::uuid
       AND guest_booking_id = $2::uuid
       AND ($3::uuid IS NULL OR assignment_id = $3::uuid)
     LIMIT 1
     FOR UPDATE`,
    [command.propertyId, command.guestBookingId, command.assignmentId ?? null],
  );
  return (result.rowCount ?? result.rows.length) > 0;
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

async function recordOperationalCommandAuditEvent(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand,
  operation: PmsOperationalCommandOperation,
  commandMeta: PmsCommandMeta,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata
     )
     VALUES (
       $1,
       'pms',
       $2,
       1,
       $3::timestamptz,
       'property',
       NULL,
       $4::uuid,
       $5,
       $6::uuid,
       'pms',
       'operational_booking',
       $7,
       $8,
       $9,
       $10::jsonb,
       $11::jsonb,
       $12::jsonb
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `pms.${operation}.${command.idempotencyKey}.audit.v1`,
      `pms.${operation.replace("_command", "")}`,
      command.audit.requestedAt,
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      command.guestBookingId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({ commandMeta, idempotencyKeyHash: keyHash }),
      JSON.stringify({}),
      JSON.stringify({
        commandId: command.commandId,
        reason: command.audit.reason,
        requestId: command.audit.requestId,
        actorOrganizationId:
          command.audit.actor.kind === "user" ? command.audit.actor.organizationId : null,
      }),
    ],
  );
}

async function completeOperationalCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand,
  operation: PmsOperationalCommandOperation,
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
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'property'
       AND property_id = $7::uuid`,
    [
      command.guestBookingId,
      sha256(stableJson(commandMeta)),
      acceptedAt,
      JSON.stringify({ commandMeta }),
      operation,
      keyHash,
      command.propertyId,
    ],
  );
}

async function reservationResultForCommand(
  config: TargetPmsOperationsCommandRepositoryConfig,
  command: PmsOperationalCommand,
  commandMeta: PmsCommandMeta,
  replayed: boolean,
): Promise<PmsOperationalCommandResult> {
  const reservation = await config.readRepository.findReservationByGuestBookingId(
    command.propertyId,
    command.guestBookingId,
  );
  return reservation
    ? { ok: true, reservation, commandMeta, replayed }
    : reservationNotFound(command.guestBookingId);
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

function reservationNotFound(guestBookingId: string): {
  ok: false;
  statusCode: 404;
  code: "reservation_not_found";
  message: string;
} {
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

function operationalConflict(
  code: "version_conflict" | "idempotency_conflict",
  message: string,
): Exclude<PmsOperationalCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code,
    message,
  };
}

function privateNoteReservationNotFound(
  guestBookingId: string,
): Exclude<PmsPrivateNoteCommandResult | PmsPrivateNoteDeleteResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "reservation_not_found",
    message: `PMS reservation ${guestBookingId} was not found.`,
  };
}

function noteNotFound(
  noteId: string,
): Exclude<PmsPrivateNoteCommandResult | PmsPrivateNoteDeleteResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "note_not_found",
    message: `PMS private note ${noteId} was not found.`,
  };
}

function privateNoteConflict(
  message: string,
): Exclude<PmsPrivateNoteCommandResult | PmsPrivateNoteDeleteResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code: "idempotency_conflict",
    message,
  };
}

function operationalTemplateConflict(
  message: string,
): Exclude<PmsOperationalTemplateCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code: "idempotency_conflict",
    message,
  };
}

function invalidStatusTransition(
  fromStatus: string,
  toStatus: string,
): Exclude<PmsOperationalCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 400,
    code: "invalid_status_transition",
    message: `Cannot transition PMS reservation from ${fromStatus} to ${toStatus}.`,
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

function operationalCommandFingerprint(command: PmsOperationalCommand): unknown {
  const { audit: _audit, ...fingerprint } = command;
  return fingerprint;
}

function isPmsPrivateNote(value: unknown): value is PmsPrivateNote {
  if (!value || typeof value !== "object") return false;
  const note = value as PmsPrivateNote;
  return (
    typeof note.noteId === "string" &&
    typeof note.body === "string" &&
    (note.authorUserId === null || typeof note.authorUserId === "string") &&
    typeof note.authorDisplayName === "string" &&
    typeof note.createdAt === "string" &&
    !!note.auditMetadata &&
    typeof note.auditMetadata === "object" &&
    note.auditMetadata.privacyScope === "internal" &&
    typeof note.auditMetadata.createdAt === "string" &&
    typeof note.auditMetadata.createdByDisplayName === "string"
  );
}

function isPmsOperationalTemplate(value: unknown): value is PmsOperationalTemplate {
  if (!value || typeof value !== "object") return false;
  const template = value as PmsOperationalTemplate;
  return (
    typeof template.propertyId === "string" &&
    (template.templateKind === "check_in_checklist" ||
      template.templateKind === "check_out_inspection") &&
    Array.isArray(template.steps) &&
    (template.updatedByUserId === null || typeof template.updatedByUserId === "string") &&
    (template.updatedAt === null || typeof template.updatedAt === "string")
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
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
