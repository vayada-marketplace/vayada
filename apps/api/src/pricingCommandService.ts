import { timingSafeEqual } from "node:crypto";

import {
  backendAuthPlugin,
  type BackendAuthPluginOptions,
  type RequestContext,
  UnauthorizedError,
} from "@vayada/backend-auth";
import {
  AuthorizationError,
  createAuthorizationResolver,
  type EntitlementRepository,
  type PropertyAccessRepository,
  type RolePermissionRepository,
} from "@vayada/backend-authorization";
import { pricingKeys, pricingObject } from "@vayada/domain-pms";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";

import {
  PricingStorageError,
  type PricingStorageScope,
} from "./domains/replacementPricingStore.js";
import { enforceRoutePolicy } from "./routes/policy.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERNAL_TOKEN_HEADER = "x-vayada-internal-token";

export type PricingCommandServiceAuthOptions = Omit<
  BackendAuthPluginOptions,
  "authorizationResolver"
> & {
  rolePermissionRepository: RolePermissionRepository;
  entitlementRepository: EntitlementRepository;
  propertyAccessRepository: PropertyAccessRepository;
};

export type PricingAuthorityOperations = {
  read(context: RequestContext, scope: PricingStorageScope): Promise<unknown>;
  save(context: RequestContext, scope: PricingStorageScope, input: unknown): Promise<unknown>;
};

export type PricingCommandServiceOptions = {
  logger?: FastifyServerOptions["logger"];
  internalToken: string;
  propertyId: string;
  auth: PricingCommandServiceAuthOptions;
  ownerRead: PricingAuthorityOperations["read"];
  ownerManage: PricingAuthorityOperations["save"];
};

function tokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const received = Buffer.from(actual);
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

function idempotencyKey(request: Parameters<typeof enforceRoutePolicy>[0]): string {
  const count = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const value = request.headers["idempotency-key"];
  if (
    count !== 1 ||
    typeof value !== "string" ||
    value.includes(",") ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 200
  )
    throw new PricingStorageError("invalid");
  return value;
}

function scope(context: RequestContext, propertyId: string): PricingStorageScope {
  return {
    propertyId,
    organizationId: context.selectedOrganization.organizationId,
    actorUserId: context.actor.internalUserId,
  };
}

function authorizeOwner(
  contextRequest: Parameters<typeof enforceRoutePolicy>[0],
  propertyId: string,
  manage: boolean,
) {
  const permission = manage ? "pms.rooms_rates.manage" : "pms.rooms_rates.read";
  const context = enforceRoutePolicy(contextRequest, { permission });
  if (
    context.selectedOrganization.kind !== "hotel_group" ||
    !context.actor.providerIdentity.sessionId
  )
    throw new AuthorizationError();
  const resource = {
    product: "pms",
    resourceType: "pms_property",
    resourceId: propertyId,
  } as const;
  return enforceRoutePolicy(contextRequest, {
    permission,
    entitlement: { product: "pms", key: "property-management", resource },
    resource: { ...resource, allowedRelationships: ["owner", "operator"] },
  });
}

function sendPricingError(error: unknown, reply: FastifyReply) {
  if (error instanceof UnauthorizedError) return reply.code(401).send({ code: "unauthenticated" });
  if (error instanceof AuthorizationError) return reply.code(403).send({ code: "forbidden" });
  if (error instanceof PricingStorageError) {
    const status = error.code === "invalid" ? 400 : error.code === "denied" ? 403 : 409;
    return reply.code(status).send({ code: error.code });
  }
  return reply.code(503).send({ code: "pricing_unavailable" });
}

/** Private fixed-command boundary. It intentionally exposes no generic execution primitive. */
export function buildPricingCommandService(options: PricingCommandServiceOptions): FastifyInstance {
  if (!UUID.test(options.propertyId)) throw new Error("propertyId must be a UUID");
  if (Buffer.byteLength(options.internalToken) < 32)
    throw new Error("internalToken must contain at least 32 bytes");

  const app = Fastify({
    logger: options.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    disableRequestLogging: true,
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!tokenMatches(request.headers[INTERNAL_TOKEN_HEADER], options.internalToken))
      return reply.code(401).send({ code: "internal_unauthenticated" });
    if (
      Object.keys(request.headers).some(
        (header) =>
          header === "x-hotel-id" ||
          (header.startsWith("x-vayada-") && header !== INTERNAL_TOKEN_HEADER),
      )
    )
      return reply.code(400).send({ code: "forwarded_context_rejected" });
  });

  const { rolePermissionRepository, entitlementRepository, propertyAccessRepository, ...auth } =
    options.auth;
  app.register(backendAuthPlugin, {
    ...auth,
    authorizationResolver: createAuthorizationResolver(
      rolePermissionRepository,
      entitlementRepository,
      propertyAccessRepository,
    ),
  });

  const authorized = new WeakMap<object, RequestContext>();
  const authorizeRequest = async (
    request: Parameters<typeof authorizeOwner>[0] & {
      params: { propertyId: string };
      query: unknown;
    },
    reply: FastifyReply,
    manage: boolean,
  ) => {
    try {
      if (
        request.params.propertyId.toLowerCase() !== options.propertyId.toLowerCase() ||
        !pricingObject(request.query) ||
        Object.keys(request.query).length !== 0
      )
        throw new AuthorizationError();
      authorized.set(request, authorizeOwner(request, options.propertyId, manage));
    } catch (error) {
      return sendPricingError(error, reply);
    }
  };

  app.get<{ Params: { propertyId: string }; Querystring: Record<string, unknown> }>(
    "/v1/owner/properties/:propertyId/authority",
    {
      onRequest: (request, reply) => authorizeRequest(request, reply, false),
    },
    async (request, reply) => {
      try {
        const context = authorized.get(request);
        if (!context) throw new UnauthorizedError();
        return await options.ownerRead(context, scope(context, options.propertyId));
      } catch (error) {
        return sendPricingError(error, reply);
      }
    },
  );

  app.put<{
    Params: { propertyId: string };
    Querystring: Record<string, unknown>;
    Body: unknown;
  }>(
    "/v1/owner/properties/:propertyId/authority",
    {
      bodyLimit: 4 * 1024,
      onRequest: (request, reply) => authorizeRequest(request, reply, true),
    },
    async (request, reply) => {
      try {
        const context = authorized.get(request);
        if (!context) throw new UnauthorizedError();
        const requestId = idempotencyKey(request);
        const body = request.body;
        if (
          !pricingObject(body) ||
          !pricingKeys(body, ["expectedRevision", "authority"]) ||
          !(
            body.expectedRevision === null ||
            (typeof body.expectedRevision === "string" && UUID.test(body.expectedRevision))
          ) ||
          !["vayada", "external", "unconfigured"].includes(body.authority as string)
        )
          throw new PricingStorageError("invalid");
        return await options.ownerManage(context, scope(context, options.propertyId), {
          requestId,
          expectedRevision: body.expectedRevision,
          authority: body.authority,
        });
      } catch (error) {
        return sendPricingError(error, reply);
      }
    },
  );

  return app;
}
