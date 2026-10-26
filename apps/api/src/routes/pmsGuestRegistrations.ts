import pg from "pg";
import { randomUUID } from "node:crypto";
import { UnauthorizedError, type RequestContext } from "@vayada/backend-auth";
import { AuthorizationError, type PropertyAccessRepository } from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforcePmsPropertyRoutePolicy } from "./pmsPropertyPolicy.js";

/** What staff record per guest at check-in for police registration (VAY-2373, migration 0516). Names,
 * email, phone and nationality stay on the booking guest; this adds the ID document and the rest. */
export const PMS_GUEST_DOCUMENT_TYPES = [
  "passport",
  "national_id",
  "driving_licence",
  "other",
] as const;
export const PMS_GUEST_GENDERS = ["female", "male", "other", "prefer_not_to_say"] as const;
export type PmsGuestDocumentType = (typeof PMS_GUEST_DOCUMENT_TYPES)[number];
export type PmsGuestGender = (typeof PMS_GUEST_GENDERS)[number];

// ID fields: hidden from staff who may not read guest contact details, like email and phone.
const IDENTITY_FIELDS = ["dateOfBirth", "documentType", "documentNumber", "gender"] as const;
const FIELDS = ["assignmentId", ...IDENTITY_FIELDS, "staffNotes"] as const;
type FieldName = (typeof FIELDS)[number];
const RELATIONSHIPS = ["owner", "operator", "front_desk"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PmsGuestRegistrationFields = {
  assignmentId: string | null;
  dateOfBirth: string | null;
  documentType: PmsGuestDocumentType | null;
  documentNumber: string | null;
  gender: PmsGuestGender | null;
  staffNotes: string | null;
};

export type PmsGuestRegistration = PmsGuestRegistrationFields & {
  guestId: string;
  role: "booker" | "primary_guest" | "additional_guest";
  /** Fields that hold a value, also when the value itself is hidden from this reader. */
  filledFields: FieldName[];
  updatedAt: string | null;
};

export type PmsGuestRegistrationsResponse = {
  guestBookingId: string;
  canReadIdentity: boolean;
  guests: PmsGuestRegistration[];
};

export type PmsGuestRegistrationSave = {
  propertyId: string;
  guestBookingId: string;
  guestId: string;
  fields: PmsGuestRegistrationFields;
  audit: {
    actorUserId: string;
    organizationId: string;
    requestId: string;
    correlationId: string | null;
  };
};

export type PmsGuestRegistrationSaveResult =
  | { ok: true; registration: PmsGuestRegistration }
  | { ok: false; code: "guest_not_found" | "assignment_not_found" };

export type PmsGuestRegistrationRepository = {
  /** Every guest of the booking with its registration; null when the booking isn't this property's. */
  list(propertyId: string, guestBookingId: string): Promise<PmsGuestRegistration[] | null>;
  save(command: PmsGuestRegistrationSave): Promise<PmsGuestRegistrationSaveResult>;
  close?(): Promise<void>;
};

export type PmsGuestRegistrationRoutesOptions = {
  repository: PmsGuestRegistrationRepository;
  propertyAccessRepository: PropertyAccessRepository;
  allowedOrigins?: string[];
};

type ReservationParams = { propertyId: string; guestBookingId: string };
type GuestParams = ReservationParams & { guestId: string };

const LIST_PATH = "/properties/:propertyId/reservations/:guestBookingId/guest-registrations";
const GUEST_PATH = `${LIST_PATH}/:guestId`;

export async function registerPmsGuestRegistrationRoutes(
  app: FastifyInstance,
  options: PmsGuestRegistrationRoutesOptions,
): Promise<void> {
  const { repository, propertyAccessRepository } = options;
  app.addHook("onClose", async () => repository.close?.());

  for (const path of [LIST_PATH, GUEST_PATH]) {
    app.options(path, async (request, reply) => {
      if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
        return reply.status(403).send({ code: "origin_not_allowed" });
      return reply.code(204).send();
    });
  }

  app.get<{ Params: ReservationParams }>(LIST_PATH, async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
      return reply.status(403).send({ code: "origin_not_allowed" });
    const propertyId = parseUuid(request.params.propertyId);
    const guestBookingId = parseUuid(request.params.guestBookingId);
    if (!propertyId || !guestBookingId)
      return invalidRequest(reply, "The property or reservation ID is invalid.");
    const context = await authorize(reply, () =>
      enforcePmsPropertyRoutePolicy(
        request,
        { propertyId, permission: "pms.operations.read", allowedRelationships: RELATIONSHIPS },
        propertyAccessRepository,
      ),
    );
    if (!context) return reply;
    try {
      const guests = await repository.list(propertyId, guestBookingId);
      if (!guests) return reply.status(404).send({ code: "reservation_not_found" });
      const canReadIdentity = canReadGuestIdentity(context);
      return reply.header("Cache-Control", "private, no-store").send({
        guestBookingId,
        canReadIdentity,
        guests: canReadIdentity ? guests : guests.map(hideIdentity),
      } satisfies PmsGuestRegistrationsResponse);
    } catch (error) {
      request.log.error({ err: error, propertyId }, "PMS guest registrations read failed");
      return reply.status(503).send({ code: "guest_registrations_unavailable" });
    }
  });

  app.put<{ Params: GuestParams; Body: unknown }>(GUEST_PATH, async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
      return reply.status(403).send({ code: "origin_not_allowed" });
    const propertyId = parseUuid(request.params.propertyId);
    const guestBookingId = parseUuid(request.params.guestBookingId);
    const guestId = parseUuid(request.params.guestId);
    if (!propertyId || !guestBookingId || !guestId)
      return invalidRequest(reply, "The property, reservation or guest ID is invalid.");
    const context = await authorize(reply, () =>
      enforcePmsPropertyRoutePolicy(
        request,
        { propertyId, permission: "pms.operations.manage", allowedRelationships: RELATIONSHIPS },
        propertyAccessRepository,
      ),
    );
    if (!context) return reply;
    // A save replaces every field, so only staff who can see the ID fields may write them.
    if (!canReadGuestIdentity(context)) return reply.status(403).send({ code: "forbidden" });
    const fields = parseFields(request.body);
    if (typeof fields === "string") return invalidRequest(reply, fields);
    try {
      const result = await repository.save({
        propertyId,
        guestBookingId,
        guestId,
        fields,
        audit: {
          actorUserId: context.actor.internalUserId,
          organizationId: context.selectedOrganization.organizationId,
          requestId: context.audit.requestId,
          correlationId: context.audit.correlationId ?? null,
        },
      });
      if (!result.ok) {
        return result.code === "guest_not_found"
          ? reply.status(404).send({ code: "guest_not_found" })
          : invalidRequest(reply, "assignmentId is not a room of this reservation.");
      }
      return reply.header("Cache-Control", "no-store").send(result.registration);
    } catch (error) {
      request.log.error({ err: error, propertyId }, "PMS guest registration save failed");
      return reply.status(503).send({ code: "guest_registrations_unavailable" });
    }
  });
}

function canReadGuestIdentity(context: RequestContext): boolean {
  return context.membership.permissions.includes("pms.guest_contact.read");
}

function hideIdentity(guest: PmsGuestRegistration): PmsGuestRegistration {
  return { ...guest, dateOfBirth: null, documentType: null, documentNumber: null, gender: null };
}

/** The whole registration: every field must be sent, null clears it. */
function parseFields(body: unknown): PmsGuestRegistrationFields | string {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return "The body must be an object.";
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (unknown.length) return `Unknown field: ${unknown[0]}.`;
  const missing = FIELDS.filter((key) => !(key in raw));
  if (missing.length) return `Missing field: ${missing[0]} (send null to clear it).`;

  const assignmentId = raw.assignmentId;
  if (
    assignmentId !== null &&
    (typeof assignmentId !== "string" || !UUID_PATTERN.test(assignmentId))
  )
    return "assignmentId must be a UUID or null.";
  const dateOfBirth = raw.dateOfBirth;
  if (dateOfBirth !== null && !isBirthDate(dateOfBirth))
    return "dateOfBirth must be a past date (YYYY-MM-DD) or null.";
  const documentType = raw.documentType;
  if (
    documentType !== null &&
    !(PMS_GUEST_DOCUMENT_TYPES as readonly unknown[]).includes(documentType)
  )
    return `documentType must be one of ${PMS_GUEST_DOCUMENT_TYPES.join(", ")} or null.`;
  const gender = raw.gender;
  if (gender !== null && !(PMS_GUEST_GENDERS as readonly unknown[]).includes(gender))
    return `gender must be one of ${PMS_GUEST_GENDERS.join(", ")} or null.`;
  const documentNumber = optionalText(raw.documentNumber, 64);
  if (documentNumber === undefined)
    return "documentNumber must be text up to 64 characters or null.";
  const staffNotes = optionalText(raw.staffNotes, 2000);
  if (staffNotes === undefined) return "staffNotes must be text up to 2000 characters or null.";

  return {
    assignmentId: (assignmentId as string | null)?.toLowerCase() ?? null,
    dateOfBirth: dateOfBirth as string | null,
    documentType: documentType as PmsGuestDocumentType | null,
    documentNumber,
    gender: gender as PmsGuestGender | null,
    staffNotes,
  };
}

/** Trimmed text, null for null or blank, undefined when invalid. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return null;
  return text.length <= max ? text : undefined;
}

function isBirthDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value >= "1900-01-01" &&
    date.getTime() <= Date.now()
  );
}

async function authorize(
  reply: FastifyReply,
  check: () => Promise<RequestContext>,
): Promise<RequestContext | null> {
  try {
    return await check();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      reply.status(401).send({ code: "unauthenticated" });
      return null;
    }
    if (error instanceof AuthorizationError) {
      reply.status(403).send({ code: "forbidden" });
      return null;
    }
    throw error;
  }
}

function parseUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function writeCorsHeaders(
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
    .header("Access-Control-Allow-Methods", "GET,PUT,OPTIONS")
    .header("Vary", "Origin");
  return true;
}

type RegistrationRow = {
  guestId: string | null;
  role: PmsGuestRegistration["role"] | null;
  assignmentId: string | null;
  dateOfBirth: string | null;
  documentType: PmsGuestDocumentType | null;
  documentNumber: string | null;
  gender: PmsGuestGender | null;
  staffNotes: string | null;
  updatedAt: Date | null;
};

const REGISTRATION_COLUMNS = `registration.assignment_id::text AS "assignmentId",
  to_char(registration.date_of_birth, 'YYYY-MM-DD') AS "dateOfBirth",
  registration.document_type AS "documentType", registration.document_number AS "documentNumber",
  registration.gender, registration.staff_notes AS "staffNotes", registration.updated_at AS "updatedAt"`;

export function createPgPmsGuestRegistrationRepository(config: {
  connectionString: string;
  max?: number;
}): PmsGuestRegistrationRepository {
  if (!config.connectionString.trim())
    throw new Error("PMS guest registration repository connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async list(propertyId, guestBookingId) {
      const result = await pool.query<RegistrationRow>(
        `SELECT guest.id::text AS "guestId", guest.guest_role AS role, ${REGISTRATION_COLUMNS}
         FROM booking.guest_bookings booking
         LEFT JOIN booking.booking_guests guest ON guest.guest_booking_id = booking.id
         LEFT JOIN pms.guest_registrations registration
           ON registration.booking_guest_id = guest.id AND registration.property_id = booking.property_id
         WHERE booking.property_id = $1::uuid AND booking.id = $2::uuid
         ORDER BY CASE guest.guest_role WHEN 'booker' THEN 0 WHEN 'primary_guest' THEN 1 ELSE 2 END,
           guest.created_at, guest.id`,
        [propertyId, guestBookingId],
      );
      if (result.rows.length === 0) return null;
      return result.rows.filter((row) => row.guestId).map(toRegistration);
    },

    async save({ propertyId, guestBookingId, guestId, fields, audit }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const guest = await client.query<{ role: PmsGuestRegistration["role"] }>(
          `SELECT guest.guest_role AS role
           FROM booking.booking_guests guest
           JOIN booking.guest_bookings booking ON booking.id = guest.guest_booking_id
           WHERE guest.id = $3::uuid AND booking.id = $2::uuid AND booking.property_id = $1::uuid`,
          [propertyId, guestBookingId, guestId],
        );
        if (!guest.rows[0]) {
          await client.query("ROLLBACK");
          return { ok: false, code: "guest_not_found" };
        }
        if (fields.assignmentId) {
          const assignment = await client.query(
            `SELECT 1 FROM pms.operational_booking_assignments
             WHERE id = $3::uuid AND property_id = $1::uuid AND guest_booking_id = $2::uuid`,
            [propertyId, guestBookingId, fields.assignmentId],
          );
          if (!assignment.rows[0]) {
            await client.query("ROLLBACK");
            return { ok: false, code: "assignment_not_found" };
          }
        }
        const previous = await client.query<RegistrationRow>(
          `SELECT ${REGISTRATION_COLUMNS} FROM pms.guest_registrations registration
           WHERE registration.booking_guest_id = $1::uuid FOR UPDATE`,
          [guestId],
        );
        const saved = await client.query<RegistrationRow>(
          `INSERT INTO pms.guest_registrations AS registration (
             booking_guest_id, property_id, guest_booking_id, assignment_id, date_of_birth,
             document_type, document_number, gender, staff_notes, updated_by_user_id
           )
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6, $7, $8, $9, $10::uuid)
           ON CONFLICT (booking_guest_id) DO UPDATE SET
             assignment_id = EXCLUDED.assignment_id,
             date_of_birth = EXCLUDED.date_of_birth,
             document_type = EXCLUDED.document_type,
             document_number = EXCLUDED.document_number,
             gender = EXCLUDED.gender,
             staff_notes = EXCLUDED.staff_notes,
             updated_by_user_id = EXCLUDED.updated_by_user_id,
             updated_at = now()
           RETURNING ${REGISTRATION_COLUMNS}`,
          [
            guestId,
            propertyId,
            guestBookingId,
            fields.assignmentId,
            fields.dateOfBirth,
            fields.documentType,
            fields.documentNumber,
            fields.gender,
            fields.staffNotes,
            audit.actorUserId,
          ],
        );
        const before = previous.rows[0];
        const changed = FIELDS.filter((key) => (before?.[key] ?? null) !== saved.rows[0]![key]);
        // Field names only: the values are guest identity data and stay out of the audit log.
        await client.query(
          `INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
             actor_type, actor_user_id, target_resource_product, target_resource_type,
             target_resource_id, correlation_id, causation_id, redacted_payload, audit_metadata,
             privacy_scope
           )
           VALUES ($1, 'pms', 'pms.guest_registration.saved', now(), 'property', NULL, $2::uuid,
             'user', $3::uuid, 'pms', 'booking_guest', $4, $5, $6, $7::jsonb,
             jsonb_build_object('organizationId', $8::uuid), 'confidential')`,
          [
            `pms.guest-registration:${guestId}:${randomUUID()}`,
            propertyId,
            audit.actorUserId,
            guestId,
            audit.correlationId ?? audit.requestId,
            audit.requestId,
            JSON.stringify({ guestBookingId, changedFields: changed }),
            audit.organizationId,
          ],
        );
        await client.query("COMMIT");
        return {
          ok: true,
          registration: toRegistration({ ...saved.rows[0]!, guestId, role: guest.rows[0].role }),
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}

function toRegistration(row: RegistrationRow): PmsGuestRegistration {
  const fields: PmsGuestRegistrationFields = {
    assignmentId: row.assignmentId,
    dateOfBirth: row.dateOfBirth,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    gender: row.gender,
    staffNotes: row.staffNotes,
  };
  return {
    guestId: row.guestId!,
    role: row.role!,
    ...fields,
    filledFields: FIELDS.filter((key) => fields[key] !== null),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}
