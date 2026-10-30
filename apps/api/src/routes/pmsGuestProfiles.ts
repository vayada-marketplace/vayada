import pg from "pg";
import { randomUUID } from "node:crypto";
import { UnauthorizedError, type RequestContext } from "@vayada/backend-auth";
import {
  AuthorizationError,
  resolveEffectivePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import { normalizeNationalityCode } from "@vayada/locale-constants";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  CONTACT_VISIBLE_SQL,
  GUEST_ACCOUNT_SQL,
  linkReservationGuestsNow,
  lockGuestProfiles,
  separateBookingGuest,
  type GuestProfileQueryable,
} from "../jobs/bookingGuestProfileLinks.js";
import {
  editGuestProfile,
  GUEST_PROFILE_SELECT,
  type GuestProfileFieldName,
  type GuestProfileFields,
} from "../platform/guestProfileEdits.js";
import { PMS_GUEST_DOCUMENT_TYPES } from "./pmsGuestRegistrations.js";
import { enforcePmsPropertyRoutePolicy } from "./pmsPropertyPolicy.js";

/**
 * VAY-2420: the guest profiles of an account (migration 0527): search, one profile with its stays and
 * notes, staff edits, notes, and fixing a wrong match (separate one stay, merge two profiles).
 *
 * A profile belongs to the account of the property in the URL. Staff see a profile, and its stays
 * and notes, only at the properties they may open; contact and ID details need guest contact access,
 * and email and phone also a stay there whose contact the property may see ("Hidden until you
 * accept"). Every write takes lockGuestProfiles first, like the linker.
 */
const RELATIONSHIPS = ["owner", "operator", "front_desk"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTACT_FIELDS: readonly GuestProfileFieldName[] = [
  "email",
  "phone",
  "dateOfBirth",
  "documentType",
  "documentNumber",
];
const EDITABLE_FIELDS: readonly GuestProfileFieldName[] = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "countryCode",
  "dateOfBirth",
  "documentType",
  "documentNumber",
];

export type PmsGuestProfileSummary = {
  guestProfileId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  /** Reservations at the properties this reader may open. */
  reservations: number;
  /** The latest arrival of a booking that wasn't cancelled, declined or expired. */
  lastCheckIn: string | null;
};

export type PmsGuestStay = {
  bookingGuestId: string;
  guestBookingId: string;
  propertyId: string;
  propertyName: string;
  bookingReference: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: string[];
  status: string;
  channel: string;
  directSource: string | null;
  role: "booker" | "primary_guest" | "additional_guest";
  link: "matched_email" | "matched_phone" | "created" | "merged" | "separated";
  totalAmount: string;
  currency: string;
};

export type PmsGuestNote = {
  noteId: string;
  body: string;
  propertyId: string;
  createdByUserId: string | null;
  createdAt: string;
};

export type PmsGuestProfile = PmsGuestProfileSummary & {
  fields: GuestProfileFields;
  canReadContact: boolean;
  /** Email and phone wait until the property may see them ("Hidden until you accept"). */
  contactHidden: boolean;
  nextArrival: string | null;
  guestSince: string;
  stays: PmsGuestStay[];
  notes: PmsGuestNote[];
};

export type PmsReservationGuestProfile = {
  bookingGuestId: string;
  role: PmsGuestStay["role"];
  /** As on this booking: the reservation read only has the joined name. */
  firstName: string;
  lastName: string;
  /** Null only for a draft booking: other guests are linked when this is read. */
  guestProfileId: string | null;
  reservations: number;
  notes: PmsGuestNote[];
};

export type PmsGuestProfileScope = {
  propertyId: string;
  /** The properties this reader may open; stays and notes elsewhere stay hidden. */
  propertyIds: readonly string[];
  canReadContact: boolean;
};

export type PmsGuestProfileAudit = {
  actorUserId: string;
  organizationId: string;
  requestId: string;
  correlationId: string | null;
};

export type PmsGuestProfileRepository = {
  search(
    scope: PmsGuestProfileScope,
    query: { search: string | null; limit: number },
  ): Promise<PmsGuestProfileSummary[]>;
  get(scope: PmsGuestProfileScope, guestProfileId: string): Promise<PmsGuestProfile | null>;
  edit(
    scope: PmsGuestProfileScope,
    guestProfileId: string,
    edit: Partial<GuestProfileFields>,
    bookingGuestId: string | null,
    audit: PmsGuestProfileAudit,
  ): Promise<PmsGuestProfile | "not_found" | "stay_not_found" | "contact_hidden">;
  addNote(
    scope: PmsGuestProfileScope,
    guestProfileId: string,
    body: string,
    audit: PmsGuestProfileAudit,
  ): Promise<PmsGuestNote | null>;
  deleteNote(
    scope: PmsGuestProfileScope,
    guestProfileId: string,
    noteId: string,
    audit: PmsGuestProfileAudit,
  ): Promise<boolean>;
  separate(
    scope: PmsGuestProfileScope,
    guestProfileId: string,
    bookingGuestId: string,
    audit: PmsGuestProfileAudit,
  ): Promise<{ guestProfileId: string } | "not_found" | "only_stay">;
  merge(
    scope: PmsGuestProfileScope,
    guestProfileId: string,
    otherGuestProfileId: string,
    audit: PmsGuestProfileAudit,
  ): Promise<PmsGuestProfile | "not_found">;
  reservationProfiles(
    scope: PmsGuestProfileScope,
    guestBookingId: string,
  ): Promise<PmsReservationGuestProfile[] | null>;
  close?(): Promise<void>;
};

export type PmsGuestProfileRoutesOptions = {
  repository: PmsGuestProfileRepository;
  propertyAccessRepository: PropertyAccessRepository;
  allowedOrigins?: string[];
};

type PropertyParams = { propertyId: string };
type ProfileParams = PropertyParams & { guestProfileId: string };
type NoteParams = ProfileParams & { noteId: string };
type ReservationParams = PropertyParams & { guestBookingId: string };

const LIST_PATH = "/properties/:propertyId/guests";
const PROFILE_PATH = `${LIST_PATH}/:guestProfileId`;
const NOTES_PATH = `${PROFILE_PATH}/notes`;
const NOTE_PATH = `${NOTES_PATH}/:noteId`;
const SEPARATE_PATH = `${PROFILE_PATH}/separate`;
const MERGE_PATH = `${PROFILE_PATH}/merge`;
const RESERVATION_PATH = "/properties/:propertyId/reservations/:guestBookingId/guest-profiles";

export async function registerPmsGuestProfileRoutes(
  app: FastifyInstance,
  options: PmsGuestProfileRoutesOptions,
): Promise<void> {
  const { repository, propertyAccessRepository } = options;
  app.addHook("onClose", async () => repository.close?.());

  for (const path of [
    LIST_PATH,
    PROFILE_PATH,
    NOTES_PATH,
    NOTE_PATH,
    SEPARATE_PATH,
    MERGE_PATH,
    RESERVATION_PATH,
  ]) {
    app.options(path, async (request, reply) => {
      if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
        return reply.status(403).send({ code: "origin_not_allowed" });
      return reply.code(204).send();
    });
  }

  /** Authorizes the request and returns what this reader may see, or null after replying. */
  const access = async (
    request: FastifyRequest<{ Params: PropertyParams }>,
    reply: FastifyReply,
    permission: "pms.reservation.read" | "pms.operations.manage",
  ) => {
    if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
      reply.status(403).send({ code: "origin_not_allowed" });
      return null;
    }
    const propertyId = parseUuid(request.params.propertyId);
    if (!propertyId) {
      invalidRequest(reply, "The property ID is invalid.");
      return null;
    }
    try {
      const context = await enforcePmsPropertyRoutePolicy(
        request,
        { propertyId, permission, allowedRelationships: RELATIONSHIPS },
        propertyAccessRepository,
      );
      const effective = await resolveEffectivePropertyAccess(
        context,
        propertyAccessRepository,
        RELATIONSHIPS,
      );
      const scope: PmsGuestProfileScope = {
        propertyId,
        propertyIds: [...new Set([propertyId, ...(effective?.propertyIds ?? [])])],
        canReadContact: context.membership.permissions.includes("pms.guest_contact.read"),
      };
      return { context, scope, audit: auditOf(context) };
    } catch (error) {
      if (error instanceof UnauthorizedError) reply.status(401).send({ code: "unauthenticated" });
      else if (error instanceof AuthorizationError) reply.status(403).send({ code: "forbidden" });
      else throw error;
      return null;
    }
  };
  const unavailable = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    request.log.error({ err: error }, "PMS guest profiles failed");
    return reply.status(503).send({ code: "guest_profiles_unavailable" });
  };

  app.get<{ Params: PropertyParams; Querystring: { search?: string; limit?: string } }>(
    LIST_PATH,
    async (request, reply) => {
      const allowed = await access(request, reply, "pms.reservation.read");
      if (!allowed) return reply;
      const raw = request.query.search;
      if (raw !== undefined && typeof raw !== "string")
        return invalidRequest(reply, "search must be one value.");
      const search = raw?.trim() || null;
      const limit = request.query.limit === undefined ? 20 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return invalidRequest(reply, "limit must be a whole number from 1 to 100.");
      if (search && search.length > 100) return invalidRequest(reply, "search is too long.");
      try {
        const guests = await repository.search(allowed.scope, { search, limit });
        return reply.header("Cache-Control", "private, no-store").send({ guests });
      } catch (error) {
        return unavailable(request, reply, error);
      }
    },
  );

  app.get<{ Params: ProfileParams }>(PROFILE_PATH, async (request, reply) => {
    const allowed = await access(request, reply, "pms.reservation.read");
    if (!allowed) return reply;
    const guestProfileId = parseUuid(request.params.guestProfileId);
    if (!guestProfileId) return invalidRequest(reply, "The guest ID is invalid.");
    try {
      const profile = await repository.get(allowed.scope, guestProfileId);
      if (!profile) return reply.status(404).send({ code: "guest_not_found" });
      return reply.header("Cache-Control", "private, no-store").send(profile);
    } catch (error) {
      return unavailable(request, reply, error);
    }
  });

  app.patch<{ Params: ProfileParams; Body: unknown }>(PROFILE_PATH, async (request, reply) => {
    const allowed = await access(request, reply, "pms.operations.manage");
    if (!allowed) return reply;
    const guestProfileId = parseUuid(request.params.guestProfileId);
    if (!guestProfileId) return invalidRequest(reply, "The guest ID is invalid.");
    const parsed = parseEdit(request.body);
    if (typeof parsed === "string") return invalidRequest(reply, parsed);
    if (
      !allowed.scope.canReadContact &&
      CONTACT_FIELDS.some((field) => parsed.edit[field] !== undefined)
    )
      return reply.status(403).send({ code: "forbidden" });
    try {
      const result = await repository.edit(
        allowed.scope,
        guestProfileId,
        parsed.edit,
        parsed.bookingGuestId,
        allowed.audit,
      );
      if (result === "not_found") return reply.status(404).send({ code: "guest_not_found" });
      if (result === "stay_not_found")
        return invalidRequest(reply, "bookingGuestId is not a stay of this guest.");
      if (result === "contact_hidden")
        return reply.status(403).send({ code: "guest_contact_hidden" });
      return reply.header("Cache-Control", "no-store").send(result);
    } catch (error) {
      return unavailable(request, reply, error);
    }
  });

  app.post<{ Params: ProfileParams; Body: unknown }>(NOTES_PATH, async (request, reply) => {
    const allowed = await access(request, reply, "pms.operations.manage");
    if (!allowed) return reply;
    const guestProfileId = parseUuid(request.params.guestProfileId);
    if (!guestProfileId) return invalidRequest(reply, "The guest ID is invalid.");
    const body = bodyObject(request.body)?.body;
    const text = typeof body === "string" ? body.trim() : "";
    if (!text || text.length > 2000)
      return invalidRequest(reply, "body must be text of 1 to 2000 characters.");
    try {
      const note = await repository.addNote(allowed.scope, guestProfileId, text, allowed.audit);
      if (!note) return reply.status(404).send({ code: "guest_not_found" });
      return reply.status(201).header("Cache-Control", "no-store").send(note);
    } catch (error) {
      return unavailable(request, reply, error);
    }
  });

  app.delete<{ Params: NoteParams }>(NOTE_PATH, async (request, reply) => {
    const allowed = await access(request, reply, "pms.operations.manage");
    if (!allowed) return reply;
    const guestProfileId = parseUuid(request.params.guestProfileId);
    const noteId = parseUuid(request.params.noteId);
    if (!guestProfileId || !noteId)
      return invalidRequest(reply, "The guest or note ID is invalid.");
    try {
      const deleted = await repository.deleteNote(
        allowed.scope,
        guestProfileId,
        noteId,
        allowed.audit,
      );
      if (!deleted) return reply.status(404).send({ code: "note_not_found" });
      return reply.status(204).send();
    } catch (error) {
      return unavailable(request, reply, error);
    }
  });

  app.post<{ Params: ProfileParams; Body: unknown }>(SEPARATE_PATH, async (request, reply) => {
    const allowed = await access(request, reply, "pms.operations.manage");
    if (!allowed) return reply;
    const guestProfileId = parseUuid(request.params.guestProfileId);
    const bookingGuestId = parseUuid(bodyObject(request.body)?.bookingGuestId);
    if (!guestProfileId || !bookingGuestId)
      return invalidRequest(reply, "The guest ID or bookingGuestId is invalid.");
    try {
      const result = await repository.separate(
        allowed.scope,
        guestProfileId,
        bookingGuestId,
        allowed.audit,
      );
      if (result === "not_found") return reply.status(404).send({ code: "stay_not_found" });
      if (result === "only_stay") return reply.status(409).send({ code: "only_stay" });
      return reply.status(201).header("Cache-Control", "no-store").send(result);
    } catch (error) {
      return unavailable(request, reply, error);
    }
  });

  app.post<{ Params: ProfileParams; Body: unknown }>(MERGE_PATH, async (request, reply) => {
    const allowed = await access(request, reply, "pms.operations.manage");
    if (!allowed) return reply;
    const guestProfileId = parseUuid(request.params.guestProfileId);
    const otherGuestProfileId = parseUuid(bodyObject(request.body)?.guestProfileId);
    if (!guestProfileId || !otherGuestProfileId || guestProfileId === otherGuestProfileId)
      return invalidRequest(reply, "guestProfileId must be another guest's ID.");
    try {
      const result = await repository.merge(
        allowed.scope,
        guestProfileId,
        otherGuestProfileId,
        allowed.audit,
      );
      if (result === "not_found") return reply.status(404).send({ code: "guest_not_found" });
      return reply.header("Cache-Control", "no-store").send(result);
    } catch (error) {
      return unavailable(request, reply, error);
    }
  });

  app.get<{ Params: ReservationParams }>(RESERVATION_PATH, async (request, reply) => {
    const allowed = await access(request, reply, "pms.reservation.read");
    if (!allowed) return reply;
    const guestBookingId = parseUuid(request.params.guestBookingId);
    if (!guestBookingId) return invalidRequest(reply, "The reservation ID is invalid.");
    try {
      const guests = await repository.reservationProfiles(allowed.scope, guestBookingId);
      if (!guests) return reply.status(404).send({ code: "reservation_not_found" });
      return reply.header("Cache-Control", "private, no-store").send({ guestBookingId, guests });
    } catch (error) {
      return unavailable(request, reply, error);
    }
  });
}

/** A staff edit: the fields given are set and null clears one, except the names. */
function parseEdit(
  body: unknown,
): { edit: Partial<GuestProfileFields>; bookingGuestId: string | null } | string {
  const raw = bodyObject(body);
  if (!raw) return "The body must be an object.";
  const unknown = Object.keys(raw).find(
    (key) => key !== "bookingGuestId" && !(EDITABLE_FIELDS as readonly string[]).includes(key),
  );
  if (unknown) return `Unknown field: ${unknown}.`;
  let bookingGuestId: string | null = null;
  if (raw.bookingGuestId !== undefined) {
    bookingGuestId = parseUuid(raw.bookingGuestId);
    if (!bookingGuestId) return "bookingGuestId must be a UUID.";
  }
  const edit: Partial<GuestProfileFields> = {};
  for (const field of ["firstName", "lastName"] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || name.length > 200) return `${field} must be text of 1 to 200 characters.`;
    edit[field] = name;
  }
  const email = optionalText(raw.email, 254);
  if (email === undefined || (email && !/^[^\s@]+@[^\s@]+$/.test(email)))
    return "email must be an email address or null.";
  const phone = optionalText(raw.phone, 40);
  if (phone === undefined || (phone && !/^\+?[0-9 ().-]{4,}$/.test(phone)))
    return "phone must be a phone number or null.";
  const countryCode = optionalText(raw.countryCode, 64);
  const nationality = countryCode ? normalizeNationalityCode(countryCode) : null;
  if (countryCode === undefined || (countryCode && !nationality))
    return "countryCode must be a supported nationality or null.";
  const dateOfBirth = raw.dateOfBirth;
  if (dateOfBirth !== undefined && dateOfBirth !== null && !isBirthDate(dateOfBirth))
    return "dateOfBirth must be a past date (YYYY-MM-DD) or null.";
  const documentType = raw.documentType;
  if (
    documentType !== undefined &&
    documentType !== null &&
    !(PMS_GUEST_DOCUMENT_TYPES as readonly unknown[]).includes(documentType)
  )
    return `documentType must be one of ${PMS_GUEST_DOCUMENT_TYPES.join(", ")} or null.`;
  const documentNumber = optionalText(raw.documentNumber, 64);
  if (documentNumber === undefined)
    return "documentNumber must be text up to 64 characters or null.";

  if (raw.email !== undefined) edit.email = email;
  if (raw.phone !== undefined) edit.phone = phone;
  if (raw.countryCode !== undefined) edit.countryCode = nationality;
  if (dateOfBirth !== undefined) edit.dateOfBirth = dateOfBirth as string | null;
  if (documentType !== undefined)
    edit.documentType = documentType as GuestProfileFields["documentType"];
  if (raw.documentNumber !== undefined) edit.documentNumber = documentNumber;
  if (!Object.keys(edit).length) return "Send at least one field to change.";
  return { edit, bookingGuestId };
}

/** Trimmed text, null for null, blank or a missing key, undefined when invalid. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
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

function bodyObject(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function auditOf(context: RequestContext): PmsGuestProfileAudit {
  return {
    actorUserId: context.actor.internalUserId,
    organizationId: context.selectedOrganization.organizationId,
    requestId: context.audit.requestId,
    correlationId: context.audit.correlationId ?? null,
  };
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
    .header("Access-Control-Allow-Methods", "GET,PATCH,POST,DELETE,OPTIONS")
    .header("Vary", "Origin");
  return true;
}

// ---------------------------------------------------------------------------------------------
// PostgreSQL

type Queryable = GuestProfileQueryable;

// A profile this reader may open: in the URL property's account, with a stay where they may look.
const VISIBLE_PROFILE_SQL = `profile.account_id = ${GUEST_ACCOUNT_SQL("$1::uuid")}
  AND EXISTS (
    SELECT 1 FROM booking.booking_guests stay
    JOIN booking.guest_bookings booking ON booking.id = stay.guest_booking_id
    WHERE stay.guest_profile_id = profile.id AND booking.property_id = ANY($2::uuid[])
  )`;

const STAY_SQL = `
  SELECT stay.id::text AS "bookingGuestId", booking.id::text AS "guestBookingId",
         booking.property_id::text AS "propertyId", property.display_name AS "propertyName",
         booking.public_reference AS "bookingReference",
         to_char(booking.check_in, 'YYYY-MM-DD') AS "checkIn",
         to_char(booking.check_out, 'YYYY-MM-DD') AS "checkOut",
         booking.adults, booking.children,
         COALESCE((
           SELECT array_agg(room.name ORDER BY assignment.position)
           FROM pms.operational_booking_assignments assignment
           JOIN pms.room_types room ON room.id = assignment.room_type_id
           WHERE assignment.guest_booking_id = booking.id
             AND assignment.property_id = booking.property_id
             AND assignment.assignment_status NOT IN ('canceled', 'released')
         ), '{}') AS rooms,
         booking.lifecycle_status AS status, booking.booking_channel AS channel,
         booking.direct_booking_source AS "directSource",
         stay.guest_role AS role, stay.guest_profile_link AS link,
         booking.total_amount::text AS "totalAmount", booking.currency
  FROM booking.booking_guests stay
  JOIN booking.guest_bookings booking ON booking.id = stay.guest_booking_id
  JOIN hotel_catalog.properties property ON property.id = booking.property_id
  WHERE stay.guest_profile_id = $1::uuid AND booking.property_id = ANY($2::uuid[])
  ORDER BY booking.check_in DESC, booking.id`;

// Bookings that are or were a stay: search's "Arriving …" / "Last stay …" leaves the others out.
const LIVE_STATUSES = ["pending_payment", "confirmed", "completed", "no_show"];

const NOTE_COLUMNS = `note.id::text AS "noteId", note.body, note.property_id::text AS "propertyId",
  note.created_by_user_id::text AS "createdByUserId", note.created_at AS "createdAt"`;

type NoteRow = Omit<PmsGuestNote, "createdAt"> & { createdAt: Date };

export function createPgPmsGuestProfileRepository(config: {
  connectionString: string;
  max?: number;
}): PmsGuestProfileRepository {
  if (!config.connectionString.trim())
    throw new Error("PMS guest profile repository connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  const read = async (
    client: Queryable,
    scope: PmsGuestProfileScope,
    guestProfileId: string,
  ): Promise<PmsGuestProfile | null> => {
    const profile = (
      await client.query<GuestProfileFields & { guestSince: Date; contactVisible: boolean }>(
        `SELECT ${GUEST_PROFILE_SELECT},
                EXISTS (
                  SELECT 1 FROM booking.booking_guests stay
                  JOIN booking.guest_bookings booking ON booking.id = stay.guest_booking_id
                  WHERE stay.guest_profile_id = profile.id AND booking.property_id = ANY($2::uuid[])
                    AND ${CONTACT_VISIBLE_SQL}
                ) AS "contactVisible",
                LEAST(profile.created_at, (
                  SELECT min(booking.created_at) FROM booking.booking_guests stay
                  JOIN booking.guest_bookings booking ON booking.id = stay.guest_booking_id
                  WHERE stay.guest_profile_id = profile.id AND booking.property_id = ANY($2::uuid[])
                )) AS "guestSince"
         FROM booking.guest_profiles profile
         WHERE profile.id = $3::uuid AND ${VISIBLE_PROFILE_SQL}`,
        [scope.propertyId, scope.propertyIds, guestProfileId],
      )
    ).rows[0];
    if (!profile) return null;
    const stays = (await client.query<PmsGuestStay>(STAY_SQL, [guestProfileId, scope.propertyIds]))
      .rows;
    const notes = await listNotes(client, [guestProfileId], scope.propertyIds);
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = stays
      .filter(
        (stay) => stay.checkIn >= today && ["confirmed", "pending_payment"].includes(stay.status),
      )
      .map((stay) => stay.checkIn)
      .sort();
    const shown = scope.canReadContact;
    const contact = shown && profile.contactVisible;
    const fields: GuestProfileFields = {
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: contact ? profile.email : null,
      phone: contact ? profile.phone : null,
      countryCode: profile.countryCode,
      dateOfBirth: shown ? profile.dateOfBirth : null,
      documentType: shown ? profile.documentType : null,
      documentNumber: shown ? profile.documentNumber : null,
    };
    return {
      guestProfileId,
      firstName: fields.firstName,
      lastName: fields.lastName,
      email: fields.email,
      phone: fields.phone,
      reservations: new Set(stays.map((stay) => stay.guestBookingId)).size,
      lastCheckIn: stays.find((stay) => LIVE_STATUSES.includes(stay.status))?.checkIn ?? null,
      fields,
      canReadContact: scope.canReadContact,
      contactHidden: shown && !profile.contactVisible,
      nextArrival: upcoming[0] ?? null,
      guestSince: profile.guestSince.toISOString(),
      stays,
      notes: notes.get(guestProfileId) ?? [],
    };
  };

  const transaction = async <T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockGuestProfiles(client);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  // Locks the profile when this reader may open it.
  const lockVisible = async (
    client: Queryable,
    scope: PmsGuestProfileScope,
    guestProfileId: string,
  ): Promise<boolean> =>
    (
      await client.query(
        `SELECT 1 FROM booking.guest_profiles profile
         WHERE profile.id = $3::uuid AND ${VISIBLE_PROFILE_SQL} FOR UPDATE`,
        [scope.propertyId, scope.propertyIds, guestProfileId],
      )
    ).rows.length > 0;

  // A stay of the profile at a property this reader may open.
  const visibleStay = async (
    client: Queryable,
    scope: PmsGuestProfileScope,
    guestProfileId: string,
    bookingGuestId: string,
  ): Promise<boolean> =>
    (
      await client.query(
        `SELECT 1 FROM booking.booking_guests stay
         JOIN booking.guest_bookings booking ON booking.id = stay.guest_booking_id
         WHERE stay.id = $1::uuid AND stay.guest_profile_id = $2::uuid
           AND booking.property_id = ANY($3::uuid[])`,
        [bookingGuestId, guestProfileId, scope.propertyIds],
      )
    ).rows.length > 0;

  return {
    async search(scope, { search, limit }) {
      const term = search ? search.toLowerCase().replace(/\s+/g, " ") : null;
      const digits = term?.replace(/[^0-9]/g, "") ?? "";
      const result = await pool.query<PmsGuestProfileSummary & { lastCheckIn: string | null }>(
        `SELECT profile.id::text AS "guestProfileId", profile.first_name AS "firstName",
                profile.last_name AS "lastName",
                CASE WHEN $4 AND bool_or(${CONTACT_VISIBLE_SQL}) THEN profile.email END AS email,
                CASE WHEN $4 AND bool_or(${CONTACT_VISIBLE_SQL}) THEN profile.phone END AS phone,
                count(DISTINCT booking.id)::int AS reservations,
                to_char(max(booking.check_in) FILTER (
                  WHERE booking.lifecycle_status = ANY($7::text[])
                ), 'YYYY-MM-DD') AS "lastCheckIn"
         FROM booking.guest_profiles profile
         JOIN booking.booking_guests stay ON stay.guest_profile_id = profile.id
         JOIN booking.guest_bookings booking ON booking.id = stay.guest_booking_id
         WHERE profile.account_id = ${GUEST_ACCOUNT_SQL("$1::uuid")}
           AND booking.property_id = ANY($2::uuid[])
           AND (
             $3::text IS NULL
             OR strpos(profile.name_key, $3) > 0
             OR ($4 AND ${CONTACT_VISIBLE_SQL} AND (
               strpos(lower(profile.email), $3) > 0
               OR (length($5::text) >= 4
                 AND strpos(regexp_replace(profile.phone, '[^0-9]', '', 'g'), $5::text) > 0)))
           )
         GROUP BY profile.id
         ORDER BY max(booking.check_in) DESC, profile.id
         LIMIT $6`,
        [
          scope.propertyId,
          scope.propertyIds,
          term,
          scope.canReadContact,
          digits,
          limit,
          LIVE_STATUSES,
        ],
      );
      return result.rows;
    },

    async get(scope, guestProfileId) {
      return read(pool, scope, guestProfileId);
    },

    async edit(scope, guestProfileId, edit, bookingGuestId, audit) {
      return transaction(async (client) => {
        if (!(await lockVisible(client, scope, guestProfileId))) return "not_found";
        if (bookingGuestId && !(await visibleStay(client, scope, guestProfileId, bookingGuestId)))
          return "stay_not_found";
        // Email and phone only where the property may see them ("Hidden until you accept"): on the
        // stay edited from, else on one of the guest's stays here.
        if (
          (edit.email !== undefined || edit.phone !== undefined) &&
          !(
            await client.query(
              `SELECT 1 FROM booking.booking_guests stay
               JOIN booking.guest_bookings booking ON booking.id = stay.guest_booking_id
               WHERE stay.guest_profile_id = $1::uuid AND booking.property_id = ANY($2::uuid[])
                 AND ($3::uuid IS NULL OR stay.id = $3::uuid) AND ${CONTACT_VISIBLE_SQL}
               LIMIT 1`,
              [guestProfileId, scope.propertyIds, bookingGuestId],
            )
          ).rows.length
        )
          return "contact_hidden";
        const changed = await editGuestProfile(client, {
          guestProfileId,
          edit,
          propertyIds: scope.propertyIds,
          ...(bookingGuestId ? { bookingGuestId } : {}),
        });
        await insertAudit(client, scope, audit, "pms.guest_profile.edited", guestProfileId, {
          changedFields: changed ?? [],
          bookingGuestId,
        });
        return (await read(client, scope, guestProfileId))!;
      });
    },

    async addNote(scope, guestProfileId, body, audit) {
      return transaction(async (client) => {
        if (!(await lockVisible(client, scope, guestProfileId))) return null;
        const note = (
          await client.query<NoteRow>(
            `INSERT INTO booking.guest_notes AS note
               (guest_profile_id, property_id, body, created_by_user_id)
             VALUES ($1::uuid, $2::uuid, $3, $4::uuid)
             RETURNING ${NOTE_COLUMNS}`,
            [guestProfileId, scope.propertyId, body, audit.actorUserId],
          )
        ).rows[0]!;
        await insertAudit(client, scope, audit, "pms.guest_note.added", guestProfileId, {
          noteId: note.noteId,
        });
        return toNote(note);
      });
    },

    async deleteNote(scope, guestProfileId, noteId, audit) {
      return transaction(async (client) => {
        if (!(await lockVisible(client, scope, guestProfileId))) return false;
        const deleted = await client.query(
          `DELETE FROM booking.guest_notes
           WHERE id = $1::uuid AND guest_profile_id = $2::uuid AND property_id = ANY($3::uuid[])
           RETURNING id`,
          [noteId, guestProfileId, scope.propertyIds],
        );
        if (!deleted.rows.length) return false;
        await insertAudit(client, scope, audit, "pms.guest_note.deleted", guestProfileId, {
          noteId,
        });
        return true;
      });
    },

    async separate(scope, guestProfileId, bookingGuestId, audit) {
      return transaction(async (client) => {
        if (!(await lockVisible(client, scope, guestProfileId))) return "not_found";
        if (!(await visibleStay(client, scope, guestProfileId, bookingGuestId))) return "not_found";
        const stays = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM booking.booking_guests WHERE guest_profile_id = $1::uuid",
          [guestProfileId],
        );
        if (stays.rows[0]!.count < 2) return "only_stay";
        const separated = await separateBookingGuest(client, bookingGuestId);
        if (!separated) return "not_found";
        await insertAudit(
          client,
          scope,
          audit,
          "pms.guest_profile.stay_separated",
          guestProfileId,
          {
            bookingGuestId,
            newGuestProfileId: separated,
          },
        );
        return { guestProfileId: separated };
      });
    },

    async merge(scope, guestProfileId, otherGuestProfileId, audit) {
      return transaction(async (client) => {
        // Both locked in one order, so two merges of the same pair can't deadlock.
        for (const id of [guestProfileId, otherGuestProfileId].sort())
          if (!(await lockVisible(client, scope, id))) return "not_found";
        // The kept guest keeps its values and takes the other's where it has none.
        await client.query(
          `UPDATE booking.guest_profiles kept
           SET email = COALESCE(kept.email, other.email),
               phone = COALESCE(kept.phone, other.phone),
               country_code = COALESCE(kept.country_code, other.country_code),
               date_of_birth = COALESCE(kept.date_of_birth, other.date_of_birth),
               document_type = CASE WHEN kept.document_type IS NULL AND kept.document_number IS NULL
                 THEN other.document_type ELSE kept.document_type END,
               document_number = CASE WHEN kept.document_type IS NULL AND kept.document_number IS NULL
                 THEN other.document_number ELSE kept.document_number END,
               updated_at = now()
           FROM booking.guest_profiles other
           WHERE kept.id = $1::uuid AND other.id = $2::uuid`,
          [guestProfileId, otherGuestProfileId],
        );
        await client.query(
          `UPDATE booking.booking_guests SET guest_profile_id = $1::uuid, guest_profile_link = 'merged'
           WHERE guest_profile_id = $2::uuid`,
          [guestProfileId, otherGuestProfileId],
        );
        await client.query(
          "UPDATE booking.guest_notes SET guest_profile_id = $1::uuid WHERE guest_profile_id = $2::uuid",
          [guestProfileId, otherGuestProfileId],
        );
        await client.query("DELETE FROM booking.guest_profiles WHERE id = $1::uuid", [
          otherGuestProfileId,
        ]);
        await insertAudit(client, scope, audit, "pms.guest_profile.merged", guestProfileId, {
          mergedGuestProfileId: otherGuestProfileId,
        });
        return (await read(client, scope, guestProfileId))!;
      });
    },

    async reservationProfiles(scope, guestBookingId) {
      // One row with no guest when the reservation has none, none when it isn't this property's.
      const read = () =>
        pool.query<Omit<PmsReservationGuestProfile, "notes">>(
          `SELECT stay.id::text AS "bookingGuestId", stay.guest_role AS role,
                  stay.first_name AS "firstName", stay.last_name AS "lastName",
                  stay.guest_profile_id::text AS "guestProfileId",
                  (SELECT count(DISTINCT other.guest_booking_id)::int
                   FROM booking.booking_guests other
                   JOIN booking.guest_bookings other_booking ON other_booking.id = other.guest_booking_id
                   WHERE other.guest_profile_id = stay.guest_profile_id
                     AND other_booking.property_id = ANY($3::uuid[])) AS reservations
           FROM booking.guest_bookings booking
           LEFT JOIN booking.booking_guests stay ON stay.guest_booking_id = booking.id
           WHERE booking.id = $1::uuid AND booking.property_id = $2::uuid
           ORDER BY CASE stay.guest_role WHEN 'booker' THEN 0 WHEN 'primary_guest' THEN 1 ELSE 2 END,
             stay.created_at, stay.id`,
          [guestBookingId, scope.propertyId, scope.propertyIds],
        );
      let guests = await read();
      if (guests.rows.some((row) => row.bookingGuestId && !row.guestProfileId)) {
        // Guests the job hasn't reached yet (a booking made moments ago) are linked now, so they
        // can be edited at once. When that can't happen (the lock is busy, a row fails) they are
        // listed unlinked; the job links them, or reports the row.
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL lock_timeout = '5s'");
          await lockGuestProfiles(client);
          await linkReservationGuestsNow(client, scope.propertyId, guestBookingId);
          await client.query("COMMIT");
        } catch {
          await client.query("ROLLBACK").catch(() => undefined);
        } finally {
          client.release();
        }
        guests = await read();
      }
      if (!guests.rows.length) return null;
      const profileIds = guests.rows.flatMap((row) =>
        row.guestProfileId ? [row.guestProfileId] : [],
      );
      const notes = await listNotes(pool, profileIds, scope.propertyIds);
      return guests.rows
        .filter((row) => row.bookingGuestId)
        .map((row) => ({
          ...row,
          notes: (row.guestProfileId && notes.get(row.guestProfileId)) || [],
        }));
    },

    async close() {
      await pool.end();
    },
  };
}

async function listNotes(
  client: Queryable,
  guestProfileIds: readonly string[],
  propertyIds: readonly string[],
): Promise<Map<string, PmsGuestNote[]>> {
  const notes = new Map<string, PmsGuestNote[]>();
  if (!guestProfileIds.length) return notes;
  const result = await client.query<NoteRow & { guestProfileId: string }>(
    `SELECT note.guest_profile_id::text AS "guestProfileId", ${NOTE_COLUMNS}
     FROM booking.guest_notes note
     WHERE note.guest_profile_id = ANY($1::uuid[]) AND note.property_id = ANY($2::uuid[])
     ORDER BY note.created_at DESC, note.id`,
    [guestProfileIds, propertyIds],
  );
  for (const { guestProfileId, ...row } of result.rows)
    notes.set(guestProfileId, [...(notes.get(guestProfileId) ?? []), toNote(row)]);
  return notes;
}

function toNote(row: NoteRow): PmsGuestNote {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

// Field names and IDs only: guest details stay out of the audit log.
async function insertAudit(
  client: Queryable,
  scope: PmsGuestProfileScope,
  audit: PmsGuestProfileAudit,
  action: string,
  guestProfileId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, correlation_id, causation_id, redacted_payload, audit_metadata,
       privacy_scope
     )
     VALUES ($1, 'pms', $2, now(), 'property', NULL, $3::uuid, 'user', $4::uuid, 'booking',
       'guest_profile', $5, $6, $7, $8::jsonb, jsonb_build_object('organizationId', $9::uuid),
       'confidential')`,
    [
      `${action}:${guestProfileId}:${randomUUID()}`,
      action,
      scope.propertyId,
      audit.actorUserId,
      guestProfileId,
      audit.correlationId ?? audit.requestId,
      audit.requestId,
      JSON.stringify(payload),
      audit.organizationId,
    ],
  );
}
