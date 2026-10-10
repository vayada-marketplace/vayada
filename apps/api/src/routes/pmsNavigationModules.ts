import pg from "pg";
import { randomUUID } from "node:crypto";
import { requireAuthContext, UnauthorizedError, type RequestContext } from "@vayada/backend-auth";
import { AuthorizationError, type PropertyAccessRepository } from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforcePmsPropertyRoutePolicy } from "./pmsPropertyPolicy.js";

/** Feature Hub switches that only decide whether a module's PMS sidebar item shows (VAY-2078).
 * They never gate the module's pages, APIs or data. */
export const PMS_NAVIGATION_MODULE_IDS = ["inbox", "reviews"] as const;
export type PmsNavigationModuleId = (typeof PMS_NAVIGATION_MODULE_IDS)[number];

// Anyone who sees a PMS sidebar item reads the switches; front desk staff hold only these.
const READ_PERMISSIONS = ["pms.operations.read", "pms.inbox.read", "pms.dashboard.read"] as const;
const MANAGE_RELATIONSHIPS = ["owner", "operator"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PmsNavigationModule = {
  moduleId: PmsNavigationModuleId;
  isActive: boolean;
  activatedAt: string | null;
  deactivatedAt: string | null;
  updatedAt: string;
};

/** Same shape as the Feature Hub module-activation read, so the admins can merge both. */
export type PmsNavigationModulesResponse = {
  hotelId: string;
  canManage: boolean;
  supportedModules: PmsNavigationModuleId[];
  activeModules: PmsNavigationModuleId[];
  activations: PmsNavigationModule[];
};

export type PmsNavigationModuleUpdate = {
  propertyId: string;
  moduleId: PmsNavigationModuleId;
  isActive: boolean;
  audit: {
    actorUserId: string;
    organizationId: string;
    requestId: string;
    correlationId: string | null;
  };
};

export type PmsNavigationModuleRepository = {
  list(propertyId: string): Promise<PmsNavigationModule[]>;
  update(command: PmsNavigationModuleUpdate): Promise<PmsNavigationModule>;
  close?(): Promise<void>;
};

export type PmsNavigationModuleRoutesOptions = {
  repository: PmsNavigationModuleRepository;
  propertyAccessRepository: PropertyAccessRepository;
  allowedOrigins?: string[];
};

type PropertyParams = { propertyId: string };
type ModuleParams = PropertyParams & { moduleId: string };

export async function registerPmsNavigationModuleRoutes(
  app: FastifyInstance,
  options: PmsNavigationModuleRoutesOptions,
): Promise<void> {
  const { repository, propertyAccessRepository } = options;
  app.addHook("onClose", async () => repository.close?.());

  for (const path of [
    "/properties/:propertyId/navigation-modules",
    "/properties/:propertyId/navigation-modules/:moduleId",
  ]) {
    app.options(path, async (request, reply) => {
      if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
        return reply.status(403).send({ code: "origin_not_allowed" });
      return reply.code(204).send();
    });
  }

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/navigation-modules",
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
        const activations = await repository.list(propertyId);
        return reply.header("Cache-Control", "private, no-store").send({
          hotelId: propertyId,
          canManage: canManage(context, propertyId),
          supportedModules: [...PMS_NAVIGATION_MODULE_IDS],
          activeModules: activations.filter((row) => row.isActive).map((row) => row.moduleId),
          activations,
        } satisfies PmsNavigationModulesResponse);
      } catch (error) {
        request.log.error({ err: error, propertyId }, "PMS navigation modules read failed");
        return reply.status(503).send({ code: "navigation_modules_unavailable" });
      }
    },
  );

  app.patch<{ Params: ModuleParams; Body: unknown }>(
    "/properties/:propertyId/navigation-modules/:moduleId",
    async (request, reply) => {
      if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
        return reply.status(403).send({ code: "origin_not_allowed" });
      const propertyId = parsePropertyId(request.params.propertyId);
      if (!propertyId) return invalidRequest(reply, "The property ID is invalid.");
      const context = await authorize(reply, () =>
        enforcePmsPropertyRoutePolicy(
          request,
          {
            propertyId,
            permission: "pms.operations.manage",
            allowedRelationships: MANAGE_RELATIONSHIPS,
          },
          propertyAccessRepository,
        ),
      );
      if (!context) return reply;
      const { moduleId } = request.params;
      if (!isNavigationModuleId(moduleId))
        return invalidRequest(reply, "moduleId is not a PMS navigation module.");
      const body = request.body as { moduleId?: unknown; isActive?: unknown } | null;
      if (typeof body !== "object" || body === null || typeof body.isActive !== "boolean")
        return invalidRequest(reply, "isActive must be a boolean.");
      if (body.moduleId !== undefined && body.moduleId !== moduleId)
        return invalidRequest(reply, "Body moduleId must match the route moduleId.");
      const isActive = body.isActive;
      try {
        const saved = await repository.update({
          propertyId,
          moduleId,
          isActive,
          audit: {
            actorUserId: context.actor.internalUserId,
            organizationId: context.selectedOrganization.organizationId,
            requestId: context.audit.requestId,
            correlationId: context.audit.correlationId ?? null,
          },
        });
        return reply.header("Cache-Control", "no-store").send(saved);
      } catch (error) {
        request.log.error(
          { err: error, propertyId, moduleId },
          "PMS navigation module update failed",
        );
        return reply.status(503).send({ code: "navigation_modules_unavailable" });
      }
    },
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

function canManage(context: RequestContext, propertyId: string): boolean {
  if (!context.membership.permissions.includes("pms.operations.manage")) return false;
  return context.linkedResources.some(
    (resource) =>
      resource.product === "pms" &&
      resource.resourceType === "pms_property" &&
      resource.resourceId.toLowerCase() === propertyId &&
      resource.status === "active" &&
      (MANAGE_RELATIONSHIPS as readonly string[]).includes(resource.relationship),
  );
}

function parsePropertyId(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function isNavigationModuleId(value: string): value is PmsNavigationModuleId {
  return (PMS_NAVIGATION_MODULE_IDS as readonly string[]).includes(value);
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

type NavigationModuleRow = {
  moduleId: PmsNavigationModuleId;
  isActive: boolean;
  activatedAt: Date | null;
  deactivatedAt: Date | null;
  updatedAt: Date;
};

const RETURNED_COLUMNS = `module_id AS "moduleId", is_active AS "isActive",
  activated_at AS "activatedAt", deactivated_at AS "deactivatedAt", updated_at AS "updatedAt"`;

export function createPgPmsNavigationModuleRepository(config: {
  connectionString: string;
  max?: number;
}): PmsNavigationModuleRepository {
  if (!config.connectionString.trim())
    throw new Error("PMS navigation module repository connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async list(propertyId) {
      const result = await pool.query<NavigationModuleRow>(
        `SELECT ${RETURNED_COLUMNS} FROM pms.property_navigation_modules
         WHERE property_id = $1::uuid ORDER BY module_id`,
        [propertyId],
      );
      return result.rows.map(toNavigationModule);
    },

    async update({ propertyId, moduleId, isActive, audit }) {
      const result = await pool.query<NavigationModuleRow>(
        `WITH updated AS (
           INSERT INTO pms.property_navigation_modules AS current
             (property_id, module_id, is_active, activated_at, deactivated_at)
           VALUES (
             $1::uuid, $2, $3::boolean,
             CASE WHEN $3::boolean THEN now() END,
             CASE WHEN NOT $3::boolean THEN now() END
           )
           ON CONFLICT (property_id, module_id) DO UPDATE SET
             is_active = EXCLUDED.is_active,
             activated_at = CASE WHEN EXCLUDED.is_active AND NOT current.is_active
               THEN now() ELSE current.activated_at END,
             deactivated_at = CASE WHEN NOT EXCLUDED.is_active AND current.is_active
               THEN now() ELSE current.deactivated_at END,
             updated_at = now()
           RETURNING ${RETURNED_COLUMNS}
         ), audited AS (
           INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
             actor_type, actor_user_id, target_resource_product, target_resource_type,
             target_resource_id, correlation_id, causation_id, redacted_payload, audit_metadata,
             privacy_scope
           )
           SELECT $4, 'pms',
             CASE WHEN $3::boolean THEN 'pms.navigation_module.activated'
                  ELSE 'pms.navigation_module.deactivated' END,
             now(), 'property', NULL, $1::uuid, 'user', $5::uuid, 'pms', 'pms_property',
             $1::uuid::text, $6, $7,
             jsonb_build_object('moduleId', $2::text, 'isActive', $3::boolean),
             jsonb_build_object('organizationId', $8::uuid), 'internal'
           FROM updated
           RETURNING id
         )
         SELECT updated.* FROM updated CROSS JOIN audited`,
        [
          propertyId,
          moduleId,
          isActive,
          `pms.navigation-module:${propertyId}:${moduleId}:${randomUUID()}`,
          audit.actorUserId,
          audit.correlationId ?? audit.requestId,
          audit.requestId,
          audit.organizationId,
        ],
      );
      if (!result.rows[0]) throw new Error("PMS navigation module update did not return a row");
      return toNavigationModule(result.rows[0]);
    },

    async close() {
      await pool.end();
    },
  };
}

function toNavigationModule(row: NavigationModuleRow): PmsNavigationModule {
  return {
    moduleId: row.moduleId,
    isActive: row.isActive,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    // The column keeps the last switch-off; an active module reports none, like Financials.
    deactivatedAt: row.isActive ? null : (row.deactivatedAt?.toISOString() ?? null),
    updatedAt: row.updatedAt.toISOString(),
  };
}
