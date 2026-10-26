import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  requireAuthContext,
  UnauthorizedError,
  type PermissionKey,
  type RequestContext,
} from "@vayada/backend-auth";
import { AuthorizationError, type PropertyAccessRepository } from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforcePmsPropertyRoutePolicy } from "./pmsPropertyPolicy.js";

/** Settings → Check-in (VAY-2374, migration 0517): how a property runs the step-by-step check-in. */
export const PMS_CHECKIN_GUEST_FIELDS = [
  "email",
  "phone",
  "documentType",
  "documentNumber",
  "nationality",
  "dateOfBirth",
  "gender",
] as const;
export const PMS_CHECKIN_REGISTRATION_SCOPES = ["booker", "adults", "all"] as const;
// "card" is the hotel's own terminal: check-in records payments, it never charges online (D2).
export const PMS_CHECKIN_SETTLEMENT_OPTIONS = [
  "card",
  "cash",
  "bank_transfer",
  "at_checkout",
  "already_paid",
] as const;
// Door codes are a follow-up (D5).
export const PMS_CHECKIN_KEY_HANDOVER = ["physical", "none"] as const;

export type PmsCheckinGuestField = (typeof PMS_CHECKIN_GUEST_FIELDS)[number];

export type PmsCheckinSettings = {
  showSpecialRequest: boolean;
  confirmSpecialRequest: boolean;
  allowRoomChanges: boolean;
  allowIncompleteGuests: boolean;
  guestNotes: boolean;
  registrationScope: (typeof PMS_CHECKIN_REGISTRATION_SCOPES)[number];
  /** In guest-form order. First and last name are always shown and required, so they aren't listed. */
  guestFields: Array<{ field: PmsCheckinGuestField; show: boolean; required: boolean }>;
  offerAddons: boolean;
  /** Add-ons sold at the desk (booking.addon_definitions ids); null: every active add-on. */
  addonIds: string[] | null;
  settlementOptions: Array<(typeof PMS_CHECKIN_SETTLEMENT_OPTIONS)[number]>;
  paymentChoiceRequired: boolean;
  keyHandover: (typeof PMS_CHECKIN_KEY_HANDOVER)[number];
};

/** The approved design's defaults (Paper, VAY-2372-2374): what every property gets until it saves. */
export const DEFAULT_PMS_CHECKIN_SETTINGS: PmsCheckinSettings = {
  showSpecialRequest: true,
  confirmSpecialRequest: true,
  allowRoomChanges: true,
  allowIncompleteGuests: true,
  guestNotes: true,
  registrationScope: "adults",
  guestFields: [
    { field: "email", show: true, required: false },
    { field: "phone", show: true, required: false },
    { field: "documentType", show: true, required: true },
    { field: "documentNumber", show: true, required: true },
    { field: "nationality", show: true, required: true },
    { field: "dateOfBirth", show: true, required: true },
    { field: "gender", show: false, required: false },
  ],
  offerAddons: true,
  addonIds: null,
  settlementOptions: [...PMS_CHECKIN_SETTLEMENT_OPTIONS],
  paymentChoiceRequired: true,
  keyHandover: "physical",
};

export type PmsCheckinSettingsResponse = {
  propertyId: string;
  canManage: boolean;
  settings: PmsCheckinSettings;
  updatedAt: string | null;
};

export type PmsCheckinSettingsSave = {
  propertyId: string;
  settings: PmsCheckinSettings;
  audit: {
    actorUserId: string;
    organizationId: string;
    requestId: string;
    correlationId: string | null;
  };
};

export type PmsCheckinSettingsRepository = {
  find(propertyId: string): Promise<{ settings: PmsCheckinSettings; updatedAt: string | null }>;
  save(
    command: PmsCheckinSettingsSave,
  ): Promise<
    | { ok: true; settings: PmsCheckinSettings; updatedAt: string }
    | { ok: false; code: "unknown_addon" }
  >;
  close?(): Promise<void>;
};

export type PmsCheckinSettingsRoutesOptions = {
  repository: PmsCheckinSettingsRepository;
  propertyAccessRepository: PropertyAccessRepository;
  allowedOrigins?: string[];
};

// Front desk staff read the settings while they check guests in; owners and operators change them.
const READ_PERMISSIONS = ["pms.operations.read", "pms.settings.read"] as const;
const MANAGE_RELATIONSHIPS = ["owner", "operator"] as const;
const PATH = "/properties/:propertyId/check-in-settings";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOOLEAN_KEYS = [
  "showSpecialRequest",
  "confirmSpecialRequest",
  "allowRoomChanges",
  "allowIncompleteGuests",
  "guestNotes",
  "offerAddons",
  "paymentChoiceRequired",
] as const;
const SETTING_KEYS = Object.keys(DEFAULT_PMS_CHECKIN_SETTINGS) as Array<keyof PmsCheckinSettings>;

export async function registerPmsCheckinSettingsRoutes(
  app: FastifyInstance,
  options: PmsCheckinSettingsRoutesOptions,
): Promise<void> {
  const { repository, propertyAccessRepository } = options;
  app.addHook("onClose", async () => repository.close?.());

  app.options(PATH, async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
      return reply.status(403).send({ code: "origin_not_allowed" });
    return reply.code(204).send();
  });

  app.get<{ Params: { propertyId: string } }>(PATH, async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
      return reply.status(403).send({ code: "origin_not_allowed" });
    const propertyId = parseUuid(request.params.propertyId);
    if (!propertyId) return invalidRequest(reply, "The property ID is invalid.");
    const context = await authorize(reply, async () => {
      const { permissions } = requireAuthContext(request).membership;
      const held = READ_PERMISSIONS.find((permission) => permissions.includes(permission));
      if (!held) throw new AuthorizationError();
      return enforcePmsPropertyRoutePolicy(
        request,
        { propertyId, permission: held, allowedRelationships: ["owner", "operator", "front_desk"] },
        propertyAccessRepository,
      );
    });
    if (!context) return reply;
    try {
      const stored = await repository.find(propertyId);
      return reply.header("Cache-Control", "private, no-store").send({
        propertyId,
        canManage: canManage(context, propertyId),
        ...stored,
      } satisfies PmsCheckinSettingsResponse);
    } catch (error) {
      request.log.error({ err: error, propertyId }, "PMS check-in settings read failed");
      return reply.status(503).send({ code: "checkin_settings_unavailable" });
    }
  });

  app.put<{ Params: { propertyId: string }; Body: unknown }>(PATH, async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
      return reply.status(403).send({ code: "origin_not_allowed" });
    const propertyId = parseUuid(request.params.propertyId);
    if (!propertyId) return invalidRequest(reply, "The property ID is invalid.");
    const context = await authorize(reply, () =>
      enforcePmsPropertyRoutePolicy(
        request,
        {
          propertyId,
          permission: "pms.settings.manage",
          allowedRelationships: MANAGE_RELATIONSHIPS,
        },
        propertyAccessRepository,
      ),
    );
    if (!context) return reply;
    const settings = parseSettings(request.body);
    if (typeof settings === "string") return invalidRequest(reply, settings);
    try {
      const result = await repository.save({
        propertyId,
        settings,
        audit: {
          actorUserId: context.actor.internalUserId,
          organizationId: context.selectedOrganization.organizationId,
          requestId: context.audit.requestId,
          correlationId: context.audit.correlationId ?? null,
        },
      });
      if (!result.ok) return invalidRequest(reply, "addonIds must be add-ons of this property.");
      return reply.header("Cache-Control", "no-store").send({
        propertyId,
        canManage: true,
        settings: result.settings,
        updatedAt: result.updatedAt,
      } satisfies PmsCheckinSettingsResponse);
    } catch (error) {
      request.log.error({ err: error, propertyId }, "PMS check-in settings save failed");
      return reply.status(503).send({ code: "checkin_settings_unavailable" });
    }
  });
}

/** Every setting must be sent; the stored object is exactly what was validated here. */
export function parseSettings(body: unknown): PmsCheckinSettings | string {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return "The body must be an object.";
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !(SETTING_KEYS as string[]).includes(key));
  if (unknown.length) return `Unknown setting: ${unknown[0]}.`;
  const missing = SETTING_KEYS.filter((key) => !(key in raw));
  if (missing.length) return `Missing setting: ${missing[0]}.`;
  for (const key of BOOLEAN_KEYS)
    if (typeof raw[key] !== "boolean") return `${key} must be true or false.`;
  if (raw.confirmSpecialRequest === true && raw.showSpecialRequest !== true)
    return "confirmSpecialRequest needs showSpecialRequest.";
  if (!(PMS_CHECKIN_REGISTRATION_SCOPES as readonly unknown[]).includes(raw.registrationScope))
    return `registrationScope must be one of ${PMS_CHECKIN_REGISTRATION_SCOPES.join(", ")}.`;
  if (!(PMS_CHECKIN_KEY_HANDOVER as readonly unknown[]).includes(raw.keyHandover))
    return `keyHandover must be one of ${PMS_CHECKIN_KEY_HANDOVER.join(", ")}.`;

  const guestFields = raw.guestFields;
  if (
    !Array.isArray(guestFields) ||
    guestFields.length !== PMS_CHECKIN_GUEST_FIELDS.length ||
    guestFields.some(
      (entry, index) =>
        typeof entry !== "object" ||
        entry === null ||
        Object.keys(entry).sort().join() !== "field,required,show" ||
        entry.field !== PMS_CHECKIN_GUEST_FIELDS[index] ||
        typeof entry.show !== "boolean" ||
        typeof entry.required !== "boolean" ||
        (entry.required && !entry.show),
    )
  )
    return `guestFields must list ${PMS_CHECKIN_GUEST_FIELDS.join(", ")} in that order, each with show and required; a required field is shown.`;

  const addonIds = raw.addonIds;
  if (
    addonIds !== null &&
    (!Array.isArray(addonIds) ||
      addonIds.length > 50 ||
      addonIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id)) ||
      new Set(addonIds).size !== addonIds.length)
  )
    return "addonIds must be null or a list of different add-on IDs.";

  const settlementOptions = raw.settlementOptions;
  if (
    !Array.isArray(settlementOptions) ||
    settlementOptions.length === 0 ||
    settlementOptions.some(
      (option) => !(PMS_CHECKIN_SETTLEMENT_OPTIONS as readonly unknown[]).includes(option),
    ) ||
    new Set(settlementOptions).size !== settlementOptions.length
  )
    return `settlementOptions must be one or more of ${PMS_CHECKIN_SETTLEMENT_OPTIONS.join(", ")}.`;

  return {
    showSpecialRequest: raw.showSpecialRequest as boolean,
    confirmSpecialRequest: raw.confirmSpecialRequest as boolean,
    allowRoomChanges: raw.allowRoomChanges as boolean,
    allowIncompleteGuests: raw.allowIncompleteGuests as boolean,
    guestNotes: raw.guestNotes as boolean,
    registrationScope: raw.registrationScope as PmsCheckinSettings["registrationScope"],
    guestFields: (guestFields as PmsCheckinSettings["guestFields"]).map(
      ({ field, show, required }) => ({
        field,
        show,
        required,
      }),
    ),
    offerAddons: raw.offerAddons as boolean,
    addonIds: (addonIds as string[] | null)?.map((id) => id.toLowerCase()) ?? null,
    // Kept in the fixed order, whatever order they were sent in.
    settlementOptions: PMS_CHECKIN_SETTLEMENT_OPTIONS.filter((option) =>
      (settlementOptions as unknown[]).includes(option),
    ),
    paymentChoiceRequired: raw.paymentChoiceRequired as boolean,
    keyHandover: raw.keyHandover as PmsCheckinSettings["keyHandover"],
  };
}

/** A stored object read back with the defaults for anything it doesn't hold (or holds invalidly). */
export function withDefaults(stored: unknown): PmsCheckinSettings {
  const raw =
    typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const merged = { ...DEFAULT_PMS_CHECKIN_SETTINGS } as Record<string, unknown>;
  for (const key of SETTING_KEYS) {
    if (!(key in raw)) continue;
    // One key at a time against the defaults; the special-request pair is checked after the loop.
    const candidate = parseSettings({
      ...DEFAULT_PMS_CHECKIN_SETTINGS,
      showSpecialRequest: true,
      confirmSpecialRequest: false,
      [key]: raw[key],
    });
    if (typeof candidate !== "string") merged[key] = candidate[key];
  }
  if (merged.confirmSpecialRequest && !merged.showSpecialRequest)
    merged.confirmSpecialRequest = false;
  return merged as PmsCheckinSettings;
}

function canManage(context: RequestContext, propertyId: string): boolean {
  const manage: PermissionKey = "pms.settings.manage";
  if (!context.membership.permissions.includes(manage)) return false;
  return context.linkedResources.some(
    (resource) =>
      resource.product === "pms" &&
      resource.resourceType === "pms_property" &&
      resource.resourceId.toLowerCase() === propertyId &&
      resource.status === "active" &&
      (MANAGE_RELATIONSHIPS as readonly string[]).includes(resource.relationship),
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

export function createPgPmsCheckinSettingsRepository(config: {
  connectionString: string;
  max?: number;
}): PmsCheckinSettingsRepository {
  if (!config.connectionString.trim())
    throw new Error("PMS check-in settings repository connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async find(propertyId) {
      const result = await pool.query<{ settings: unknown; updatedAt: Date }>(
        `SELECT settings, updated_at AS "updatedAt" FROM pms.checkin_settings WHERE property_id = $1::uuid`,
        [propertyId],
      );
      const row = result.rows[0];
      return row
        ? { settings: withDefaults(row.settings), updatedAt: row.updatedAt.toISOString() }
        : { settings: DEFAULT_PMS_CHECKIN_SETTINGS, updatedAt: null };
    },

    async save({ propertyId, settings, audit }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (settings.addonIds?.length) {
          const known = await client.query<{ id: string }>(
            `SELECT id::text FROM booking.addon_definitions
             WHERE property_id = $1::uuid AND id = ANY($2::uuid[]) AND status <> 'retired'`,
            [propertyId, settings.addonIds],
          );
          if (known.rows.length !== settings.addonIds.length) {
            await client.query("ROLLBACK");
            return { ok: false, code: "unknown_addon" };
          }
        }
        const previous = await client.query<{ settings: unknown }>(
          "SELECT settings FROM pms.checkin_settings WHERE property_id = $1::uuid FOR UPDATE",
          [propertyId],
        );
        const before = withDefaults(previous.rows[0]?.settings);
        const saved = await client.query<{ updatedAt: Date }>(
          `INSERT INTO pms.checkin_settings (property_id, settings, updated_by_user_id)
           VALUES ($1::uuid, $2::jsonb, $3::uuid)
           ON CONFLICT (property_id) DO UPDATE SET
             settings = EXCLUDED.settings,
             updated_by_user_id = EXCLUDED.updated_by_user_id,
             updated_at = now()
           RETURNING updated_at AS "updatedAt"`,
          [propertyId, JSON.stringify(settings), audit.actorUserId],
        );
        const changed = SETTING_KEYS.filter(
          (key) => JSON.stringify(before[key]) !== JSON.stringify(settings[key]),
        );
        await client.query(
          `INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
             actor_type, actor_user_id, target_resource_product, target_resource_type,
             target_resource_id, correlation_id, causation_id, redacted_payload, audit_metadata,
             privacy_scope
           )
           VALUES ($1, 'pms', 'pms.checkin_settings.saved', now(), 'property', NULL, $2::uuid,
             'user', $3::uuid, 'pms', 'pms_property', $2::uuid::text, $4, $5, $6::jsonb,
             jsonb_build_object('organizationId', $7::uuid), 'internal')`,
          [
            `pms.checkin-settings:${propertyId}:${randomUUID()}`,
            propertyId,
            audit.actorUserId,
            audit.correlationId ?? audit.requestId,
            audit.requestId,
            JSON.stringify({ changedSettings: changed }),
            audit.organizationId,
          ],
        );
        await client.query("COMMIT");
        return { ok: true, settings, updatedAt: saved.rows[0]!.updatedAt.toISOString() };
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
