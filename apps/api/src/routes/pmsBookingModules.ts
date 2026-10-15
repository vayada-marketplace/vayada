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

/** Feature Hub switches for Booking Engine modules (VAY-2200): booking_settings.addons_enabled and
 * promo_codes_enabled (0484). Off hides the module's Booking Engine page and its guest step or
 * field; stored add-ons, codes and bookings stay. The Add-ons page's "show the step" choice
 * (show_addons_step) is separate and unchanged. */
export const BOOKING_MODULE_IDS = ["add-ons", "promos"] as const;
export type BookingModuleId = (typeof BOOKING_MODULE_IDS)[number];

const MANAGE_PERMISSIONS: Record<BookingModuleId, PermissionKey> = {
  "add-ons": "booking.addons.manage",
  promos: "booking.promos.manage",
};
// Anyone who sees the Booking Engine Add-ons or Promos item, or the PMS Feature Hub, reads them.
const READ_PERMISSIONS = [
  "booking.addons.read",
  "booking.promos.read",
  "pms.operations.read",
] as const;
const MANAGE_RELATIONSHIPS = ["owner", "operator"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Same shape as the other Feature Hub stores. The settings row keeps no switch history. */
export type BookingModule = {
  moduleId: BookingModuleId;
  isActive: boolean;
  activatedAt: null;
  deactivatedAt: null;
  updatedAt: string;
};

export type BookingModulesResponse = {
  hotelId: string;
  canManage: boolean;
  supportedModules: BookingModuleId[];
  activeModules: BookingModuleId[];
  activations: BookingModule[];
  manageableModules: BookingModuleId[];
};

export type BookingModuleSwitches = Record<BookingModuleId, boolean> & { updatedAt: string };

export type BookingModuleUpdate = {
  propertyId: string;
  moduleId: BookingModuleId;
  isActive: boolean;
  audit: {
    actorUserId: string;
    organizationId: string;
    requestId: string;
    correlationId: string | null;
  };
};

export type BookingModuleRepository = {
  /** Null when the property has no booking settings yet; both modules then count as on. */
  read(propertyId: string): Promise<BookingModuleSwitches | null>;
  /** Null when there are no booking settings to switch. */
  update(command: BookingModuleUpdate): Promise<BookingModule | null>;
  close?(): Promise<void>;
};

export type PmsBookingModuleRoutesOptions = {
  repository: BookingModuleRepository;
  propertyAccessRepository: PropertyAccessRepository;
  allowedOrigins?: string[];
};

type PropertyParams = { propertyId: string };
type ModuleParams = PropertyParams & { moduleId: string };

export async function registerPmsBookingModuleRoutes(
  app: FastifyInstance,
  options: PmsBookingModuleRoutesOptions,
): Promise<void> {
  const { repository, propertyAccessRepository } = options;
  app.addHook("onClose", async () => repository.close?.());

  for (const path of [
    "/properties/:propertyId/booking-modules",
    "/properties/:propertyId/booking-modules/:moduleId",
  ]) {
    app.options(path, async (request, reply) => {
      if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
        return reply.status(403).send({ code: "origin_not_allowed" });
      return reply.code(204).send();
    });
  }

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/booking-modules",
    async (request, reply) => {
      if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
        return reply.status(403).send({ code: "origin_not_allowed" });
      const propertyId = parsePropertyId(request.params.propertyId);
      if (!propertyId) return invalidRequest(reply, "The property ID is invalid.");
      const context = await authorize(reply, async () => {
        const { permissions } = requireAuthContext(request).membership;
        const held = READ_PERMISSIONS.find((permission) => permissions.includes(permission));
        if (!held) throw new AuthorizationError();
        return enforcePmsPropertyRoutePolicy(
          request,
          {
            propertyId,
            permission: held,
            allowedRelationships: ["owner", "operator", "front_desk"],
          },
          propertyAccessRepository,
        );
      });
      if (!context) return reply;
      try {
        const switches = await repository.read(propertyId);
        const activeModules = BOOKING_MODULE_IDS.filter((id) => !switches || switches[id]);
        const manageableModules = switches
          ? BOOKING_MODULE_IDS.filter((id) => canManage(context, propertyId, id))
          : [];
        return reply.header("Cache-Control", "private, no-store").send({
          hotelId: propertyId,
          canManage: manageableModules.length > 0,
          supportedModules: [...BOOKING_MODULE_IDS],
          activeModules,
          activations: switches
            ? BOOKING_MODULE_IDS.map((moduleId) =>
                toBookingModule(moduleId, switches[moduleId], switches.updatedAt),
              )
            : [],
          manageableModules,
        } satisfies BookingModulesResponse);
      } catch (error) {
        request.log.error({ err: error, propertyId }, "Booking modules read failed");
        return reply.status(503).send({ code: "booking_modules_unavailable" });
      }
    },
  );

  app.patch<{ Params: ModuleParams; Body: unknown }>(
    "/properties/:propertyId/booking-modules/:moduleId",
    async (request, reply) => {
      if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
        return reply.status(403).send({ code: "origin_not_allowed" });
      const propertyId = parsePropertyId(request.params.propertyId);
      if (!propertyId) return invalidRequest(reply, "The property ID is invalid.");
      const { moduleId } = request.params;
      const context = await authorize(reply, async () => {
        requireAuthContext(request);
        // Each module keeps the permission of its own Booking Engine page.
        if (!isBookingModuleId(moduleId)) return null;
        return enforcePmsPropertyRoutePolicy(
          request,
          {
            propertyId,
            permission: MANAGE_PERMISSIONS[moduleId],
            allowedRelationships: MANAGE_RELATIONSHIPS,
          },
          propertyAccessRepository,
        );
      });
      if (context === undefined) return reply;
      if (!context || !isBookingModuleId(moduleId))
        return invalidRequest(reply, "moduleId is not a Booking Engine module.");
      const body = request.body as { moduleId?: unknown; isActive?: unknown } | null;
      if (typeof body !== "object" || body === null || typeof body.isActive !== "boolean")
        return invalidRequest(reply, "isActive must be a boolean.");
      if (body.moduleId !== undefined && body.moduleId !== moduleId)
        return invalidRequest(reply, "Body moduleId must match the route moduleId.");
      try {
        const saved = await repository.update({
          propertyId,
          moduleId,
          isActive: body.isActive,
          audit: {
            actorUserId: context.actor.internalUserId,
            organizationId: context.selectedOrganization.organizationId,
            requestId: context.audit.requestId,
            correlationId: context.audit.correlationId ?? null,
          },
        });
        if (!saved)
          return reply.header("Cache-Control", "no-store").status(409).send({
            code: "booking_settings_missing",
            message: "Set up the booking engine before switching its modules.",
          });
        return reply.header("Cache-Control", "no-store").send(saved);
      } catch (error) {
        request.log.error({ err: error, propertyId, moduleId }, "Booking module update failed");
        return reply.status(503).send({ code: "booking_modules_unavailable" });
      }
    },
  );
}

/** Undefined once a reply has been sent; null passes an unknown module on to validation. */
async function authorize<T extends RequestContext | null>(
  reply: FastifyReply,
  check: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await check();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      reply.status(401).send({ code: "unauthenticated" });
      return undefined;
    }
    if (error instanceof AuthorizationError) {
      reply.status(403).send({ code: "forbidden" });
      return undefined;
    }
    throw error;
  }
}

function canManage(context: RequestContext, propertyId: string, moduleId: BookingModuleId) {
  if (!context.membership.permissions.includes(MANAGE_PERMISSIONS[moduleId])) return false;
  return context.linkedResources.some(
    (resource) =>
      resource.product === "pms" &&
      resource.resourceType === "pms_property" &&
      resource.resourceId.toLowerCase() === propertyId &&
      resource.status === "active" &&
      (MANAGE_RELATIONSHIPS as readonly string[]).includes(resource.relationship),
  );
}

function toBookingModule(
  moduleId: BookingModuleId,
  isActive: boolean,
  updatedAt: string,
): BookingModule {
  return { moduleId, isActive, activatedAt: null, deactivatedAt: null, updatedAt };
}

function parsePropertyId(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function isBookingModuleId(value: string): value is BookingModuleId {
  return (BOOKING_MODULE_IDS as readonly string[]).includes(value);
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
    .header("Access-Control-Allow-Methods", "GET,PATCH,OPTIONS")
    .header("Vary", "Origin");
  return true;
}

type SwitchRow = { addOns: boolean; promos: boolean; updatedAt: Date };

// The switches deliberately leave booking_settings.updated_at alone: the booking page publication
// hashes that row, and a switch must not make a live page look edited. Guests read both live.
export function createPgBookingModuleRepository(config: {
  connectionString: string;
  max?: number;
}): BookingModuleRepository {
  if (!config.connectionString.trim())
    throw new Error("Booking module repository connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async read(propertyId) {
      const result = await pool.query<SwitchRow>(
        `SELECT addons_enabled AS "addOns", promo_codes_enabled AS "promos",
                updated_at AS "updatedAt"
         FROM booking.booking_settings WHERE property_id = $1::uuid`,
        [propertyId],
      );
      const row = result.rows[0];
      return row
        ? { "add-ons": row.addOns, promos: row.promos, updatedAt: row.updatedAt.toISOString() }
        : null;
    },

    async update({ propertyId, moduleId, isActive, audit }) {
      const result = await pool.query<{ isActive: boolean; updatedAt: Date }>(
        `WITH updated AS (
           UPDATE booking.booking_settings SET
             addons_enabled = CASE WHEN $2 = 'add-ons' THEN $3::boolean ELSE addons_enabled END,
             promo_codes_enabled =
               CASE WHEN $2 = 'promos' THEN $3::boolean ELSE promo_codes_enabled END
           WHERE property_id = $1::uuid
           RETURNING CASE WHEN $2 = 'add-ons' THEN addons_enabled ELSE promo_codes_enabled END
             AS "isActive"
         ), audited AS (
           INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
             actor_type, actor_user_id, target_resource_product, target_resource_type,
             target_resource_id, correlation_id, causation_id, redacted_payload, audit_metadata,
             privacy_scope
           )
           SELECT $4, 'booking',
             CASE WHEN $3::boolean THEN 'booking.feature_module.activated'
                  ELSE 'booking.feature_module.deactivated' END,
             now(), 'property', NULL, $1::uuid, 'user', $5::uuid, 'pms', 'pms_property',
             $1::uuid::text, $6, $7,
             jsonb_build_object('moduleId', $2::text, 'isActive', $3::boolean),
             jsonb_build_object('organizationId', $8::uuid), 'internal'
           FROM updated
           RETURNING occurred_at
         )
         SELECT updated."isActive", audited.occurred_at AS "updatedAt"
         FROM updated CROSS JOIN audited`,
        [
          propertyId,
          moduleId,
          isActive,
          `booking.feature-module:${propertyId}:${moduleId}:${randomUUID()}`,
          audit.actorUserId,
          audit.correlationId ?? audit.requestId,
          audit.requestId,
          audit.organizationId,
        ],
      );
      const row = result.rows[0];
      return row ? toBookingModule(moduleId, row.isActive, row.updatedAt.toISOString()) : null;
    },

    async close() {
      await pool.end();
    },
  };
}
