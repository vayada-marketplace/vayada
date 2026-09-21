import pg, { type QueryResult, type QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RequestContext } from "@vayada/backend-auth";
import {
  AuthorizationError,
  hasActiveEntitlement,
  requirePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";

import { enforceRoutePolicy } from "./policy.js";

const MODULE_ENTITLEMENT_PREFIX = "module:";
const MODULE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PMS_MODULE_IDS = ["affiliates", "financials"] as const;
const PMS_MODULE_ID_SET = new Set<string>(PMS_MODULE_IDS);

export type PmsModuleActivation = {
  moduleId: string;
  isActive: boolean;
  activatedAt: string | null;
  deactivatedAt: string | null;
  updatedAt: string;
};

export type PmsModuleActivationsResponse = {
  hotelId: string;
  canManage: boolean;
  supportedModules: string[];
  activeModules: string[];
  activations: PmsModuleActivation[];
};

export type PmsModuleActivationRepository = {
  list(context: RequestContext, propertyId: string): Promise<PmsModuleActivation[]>;
  updateFinancials(
    context: RequestContext,
    propertyId: string,
    isActive: boolean,
  ): Promise<PmsModuleActivation>;
  close?(): Promise<void>;
};

export type PmsModuleActivationRoutesOptions = {
  repository: PmsModuleActivationRepository;
  allowedOrigins?: string[];
  financialsActivationPropertyIds?: readonly string[];
  propertyAccessRepository?: PropertyAccessRepository;
};

type PmsPropertyParams = {
  propertyId: string;
};

type PmsModuleParams = PmsPropertyParams & {
  moduleId: string;
};

type PmsModuleActivationBody = {
  moduleId?: unknown;
  isActive?: unknown;
};

export async function registerPmsModuleActivationRoutes(
  app: FastifyInstance,
  options: PmsModuleActivationRoutesOptions,
): Promise<void> {
  const { repository } = options;
  const financialsActivationPropertyIds = new Set(options.financialsActivationPropertyIds ?? []);

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  for (const path of [
    "/properties/:propertyId/module-activations",
    "/properties/:propertyId/module-activations/:moduleId",
  ]) {
    app.options(path, async (request, reply) => {
      if (!writePmsModuleActivationCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return reply.status(403).send({
          code: "origin_not_allowed",
          message: "PMS module activation origin is not allowed.",
        });
      }
      return reply.code(204).send();
    });
  }

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/module-activations",
    async (request, reply) => {
      if (!writePmsModuleActivationCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return reply.status(403).send({
          code: "origin_not_allowed",
          message: "PMS module activation origin is not allowed.",
        });
      }

      const { propertyId } = request.params;
      const context = enforceModuleActivationReadPolicy(request, propertyId);
      if (!options.propertyAccessRepository) throw new AuthorizationError();
      await requirePropertyAccess(context, options.propertyAccessRepository, {
        propertyId,
        targetResource: {
          product: "pms",
          resourceType: "pms_property",
        },
        allowedRelationships: ["owner", "operator", "front_desk"],
      });
      const activations = await repository.list(context, propertyId);
      const financialsEntitlement = {
        product: "pms" as const,
        key: "module:financials",
        resource: {
          product: "pms" as const,
          resourceType: "pms_property" as const,
          resourceId: propertyId,
        },
      };
      const financialsActive = hasActiveEntitlement(context, financialsEntitlement);
      const financialsVisible =
        canReadFinancials(context, propertyId) &&
        (financialsActivationPropertyIds.has(propertyId) ||
          financialsActive ||
          activations.some(
            (activation) => activation.moduleId === "financials" && activation.isActive,
          ));
      return reply
        .header("Cache-Control", "private, no-store")
        .send(
          moduleActivationsResponse(
            propertyId,
            financialsVisible &&
              !hasGlobalFinancialsSuspension(context) &&
              canManageFinancials(context, propertyId),
            activations,
            financialsVisible,
            financialsActive,
          ),
        );
    },
  );

  app.patch<{ Params: PmsModuleParams; Body: PmsModuleActivationBody }>(
    "/properties/:propertyId/module-activations/:moduleId",
    async (request, reply) => {
      if (!writePmsModuleActivationCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return reply.status(403).send({
          code: "origin_not_allowed",
          message: "PMS module activation origin is not allowed.",
        });
      }

      const { propertyId, moduleId } = request.params;
      const body = request.body;
      const parsed = parseModuleActivationUpdateBody(moduleId, body);
      if (!parsed.ok) return reply.status(400).send(parsed.error);

      if (moduleId === "affiliates") {
        enforceModuleActivationManagePolicy(request, propertyId);
        return reply.header("Cache-Control", "no-store").code(410).send({
          code: "affiliate_module_activation_retired",
          message: "Legacy affiliate module changes are no longer available.",
        });
      }

      const context = await enforceFinancialsManagePolicy(
        request,
        propertyId,
        options.propertyAccessRepository,
      );
      if (parsed.isActive && hasGlobalFinancialsSuspension(context)) {
        return reply.header("Cache-Control", "no-store").code(409).send({
          code: "financials_globally_suspended",
          message: "The organization has suspended Financials.",
        });
      }
      if (!financialsActivationPropertyIds.has(propertyId)) {
        const current = (await repository.list(context, propertyId)).find(
          (activation) => activation.moduleId === "financials",
        );
        const effectiveActive = hasActiveEntitlement(context, {
          product: "pms",
          key: "module:financials",
          resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
        });
        if (parsed.isActive || (!current?.isActive && !effectiveActive)) {
          return reply.header("Cache-Control", "no-store").code(403).send({
            code: "financials_activation_not_allowed",
            message: "Financials activation is not approved for this property.",
          });
        }
      }
      const activation = await repository.updateFinancials(context, propertyId, parsed.isActive);
      return reply.header("Cache-Control", "no-store").send(activation);
    },
  );
}

function enforceModuleActivationReadPolicy(
  request: FastifyRequest,
  propertyId: string,
): RequestContext {
  return enforceRoutePolicy(request, {
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
}

function enforceModuleActivationManagePolicy(
  request: FastifyRequest,
  propertyId: string,
): RequestContext {
  return enforceRoutePolicy(request, {
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
      allowedRelationships: ["owner", "operator"],
    },
  });
}

async function enforceFinancialsManagePolicy(
  request: FastifyRequest,
  propertyId: string,
  propertyAccessRepository?: PropertyAccessRepository,
): Promise<RequestContext> {
  const resource = {
    product: "pms" as const,
    resourceType: "pms_property" as const,
    resourceId: propertyId,
  };
  const context = enforceRoutePolicy(request, {
    permission: "pms.finance.manage",
    entitlement: { product: "pms", key: "property-management", resource },
    resource: { ...resource, allowedRelationships: ["owner"] },
  });
  if (context.selectedOrganization.kind !== "hotel_group" || !propertyAccessRepository) {
    throw new AuthorizationError();
  }
  await requirePropertyAccess(context, propertyAccessRepository, {
    propertyId,
    targetResource: resource,
    allowedRelationships: ["owner"],
  });
  return context;
}

function parseModuleActivationUpdateBody(
  moduleId: string,
  body: PmsModuleActivationBody,
):
  | { ok: true; isActive: boolean }
  | { ok: false; error: { code: "invalid_body"; message: string } } {
  if (!MODULE_ID_PATTERN.test(moduleId)) {
    return { ok: false, error: invalidBody("moduleId must be kebab-case.") };
  }
  if (!PMS_MODULE_ID_SET.has(moduleId)) {
    return { ok: false, error: invalidBody("moduleId is not supported for PMS.") };
  }
  if (body?.moduleId !== undefined && body.moduleId !== moduleId) {
    return { ok: false, error: invalidBody("Body moduleId must match the route moduleId.") };
  }
  if (typeof body?.isActive !== "boolean") {
    return { ok: false, error: invalidBody("isActive must be a boolean.") };
  }
  return { ok: true, isActive: body.isActive };
}

function invalidBody(message: string) {
  return { code: "invalid_body" as const, message };
}

function canManageFinancials(context: RequestContext, propertyId: string): boolean {
  if (!context.membership.permissions.includes("pms.finance.manage")) return false;
  return context.linkedResources.some(
    (resource) =>
      resource.product === "pms" &&
      resource.resourceType === "pms_property" &&
      resource.resourceId === propertyId &&
      resource.status === "active" &&
      resource.relationship === "owner",
  );
}

function canReadFinancials(context: RequestContext, propertyId: string): boolean {
  return (
    context.membership.permissions.includes("pms.finance.read") &&
    context.linkedResources.some(
      (resource) =>
        resource.product === "pms" &&
        resource.resourceType === "pms_property" &&
        resource.resourceId === propertyId &&
        resource.status === "active" &&
        resource.relationship === "owner",
    )
  );
}

function hasGlobalFinancialsSuspension(context: RequestContext): boolean {
  return context.entitlements.some(
    (entitlement) =>
      entitlement.product === "pms" &&
      entitlement.key === "module:financials" &&
      entitlement.status === "suspended" &&
      entitlement.resource === undefined,
  );
}

function moduleActivationsResponse(
  propertyId: string,
  canManage: boolean,
  activations: PmsModuleActivation[],
  financialsVisible: boolean,
  financialsActive: boolean,
): PmsModuleActivationsResponse {
  const supportedActivations = activations.filter(
    (activation) =>
      activation.moduleId === "affiliates" ||
      (financialsVisible && activation.moduleId === "financials"),
  );
  return {
    hotelId: propertyId,
    canManage,
    supportedModules: financialsVisible ? ["financials"] : [],
    activeModules: [
      ...supportedActivations
        .filter((activation) => activation.moduleId === "affiliates" && activation.isActive)
        .map((activation) => activation.moduleId),
      ...(financialsVisible && financialsActive ? ["financials"] : []),
    ],
    activations: supportedActivations,
  };
}

function writePmsModuleActivationCorsHeaders(
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

export type PmsModuleActivationPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  end?(): Promise<void>;
};

export function createPgPmsModuleActivationRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PmsModuleActivationPool;
}): PmsModuleActivationRepository {
  if (!config.connectionString.trim()) {
    throw new Error("PMS module activation repository connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool: PmsModuleActivationPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async list(context, propertyId) {
      const result = await pool.query<PmsModuleActivationRow>(
        `SELECT
           entitlement_key AS "entitlementKey",
           status,
           starts_at AS "startsAt",
           expires_at AS "expiresAt",
           updated_at AS "updatedAt"
         FROM identity.product_entitlements
         WHERE organization_id = $1::uuid
           AND product = 'pms'
           AND entitlement_key = ANY($3::text[])
           AND resource_product = 'pms'
           AND resource_type = 'pms_property'
           AND resource_id = $2
           AND (starts_at IS NULL OR starts_at <= now())
         ORDER BY entitlement_key ASC`,
        [
          context.selectedOrganization.organizationId,
          propertyId,
          PMS_MODULE_IDS.map(moduleEntitlementKey),
        ],
      );
      return result.rows.map(toModuleActivation);
    },

    async updateFinancials(context, propertyId, isActive) {
      const result = await pool.query<PmsModuleActivationRow>(
        `WITH updated AS (
           INSERT INTO identity.product_entitlements (
             organization_id, product, entitlement_key, status,
             resource_product, resource_type, resource_id,
             starts_at, expires_at, metadata
           ) VALUES (
             $1::uuid, 'pms', 'module:financials',
             CASE WHEN $2::boolean THEN 'active' ELSE 'suspended' END,
             'pms', 'pms_property', $3,
             CASE WHEN $2::boolean THEN now() ELSE NULL END,
             NULL,
             jsonb_build_object('source', 'feature_hub_financials', 'updatedByUserId', $4::uuid)
           )
           ON CONFLICT (
             organization_id, product, entitlement_key,
             COALESCE(resource_product, ''), COALESCE(resource_type, ''),
             COALESCE(resource_id, '')
           ) DO UPDATE SET
             status = EXCLUDED.status,
             starts_at = CASE
               WHEN EXCLUDED.status = 'active'
                 AND (
                   identity.product_entitlements.status <> 'active'
                   OR identity.product_entitlements.starts_at > now()
                 ) THEN now()
               WHEN EXCLUDED.status = 'active'
                 THEN COALESCE(identity.product_entitlements.starts_at, now())
               ELSE NULL
             END,
             expires_at = NULL,
             metadata = identity.product_entitlements.metadata || EXCLUDED.metadata,
             updated_at = now()
           RETURNING
             id AS "entitlementId",
             entitlement_key AS "entitlementKey", status,
             starts_at AS "startsAt", expires_at AS "expiresAt",
             updated_at AS "updatedAt"
         ), audited AS (
           INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope,
             organization_id, property_id, actor_type, actor_user_id,
             target_resource_product, target_resource_type, target_resource_id,
             redacted_payload, audit_metadata, retention_class, privacy_scope
           )
           SELECT $5, 'pms',
             CASE WHEN $2::boolean THEN 'financials_module_activated'
                  ELSE 'financials_module_deactivated' END,
             now(), 'property', NULL::uuid, $3::uuid, 'user', $4::uuid,
             'pms', 'pms_property', $3,
             jsonb_build_object('moduleId', 'financials', 'isActive', $2::boolean),
             jsonb_build_object(
               'organizationId', $1::uuid,
               'entitlementId', updated."entitlementId"
             ),
             'financial', 'internal'
           FROM updated
           RETURNING id
         )
         SELECT updated.* FROM updated CROSS JOIN audited`,
        [
          context.selectedOrganization.organizationId,
          isActive,
          propertyId,
          context.actor.internalUserId,
          randomUUID(),
        ],
      );
      if (!result.rows[0]) throw new Error("Financials activation did not return a row");
      return toModuleActivation(result.rows[0]);
    },

    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

type PmsModuleActivationRow = {
  entitlementKey: string;
  status: string;
  startsAt: Date | string | null;
  expiresAt: Date | string | null;
  updatedAt: Date | string;
};

function toModuleActivation(row: PmsModuleActivationRow): PmsModuleActivation {
  const isActive = row.status === "active" && !isPast(row.expiresAt);
  return {
    moduleId: row.entitlementKey.slice(MODULE_ENTITLEMENT_PREFIX.length),
    isActive,
    activatedAt: toIsoOrNull(row.startsAt),
    deactivatedAt: isActive ? null : (toIsoOrNull(row.expiresAt) ?? toIso(row.updatedAt)),
    updatedAt: toIso(row.updatedAt),
  };
}

function moduleEntitlementKey(moduleId: string): string {
  return `${MODULE_ENTITLEMENT_PREFIX}${moduleId}`;
}

function isPast(value: Date | string | null): boolean {
  return value ? new Date(value).getTime() <= Date.now() : false;
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value ? toIso(value) : null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
