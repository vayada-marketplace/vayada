import { UnauthorizedError, type PermissionKey } from "@vayada/backend-auth";
import {
  AuthorizationError,
  requirePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import {
  parseFlexibleRatePlanSnapshot,
  parsePmsPricingSourceSnapshot,
  parsePmsPricingCurrencyCapabilities,
  parsePmsPricingCurrencyChangeBlockers,
  parsePropertyPricingCurrencyCommandResult,
  parseUpsertPropertyPricingCurrencyCommand,
  type PmsPricingCommandAudit,
  type PmsPricingCommandPort,
  type PmsPricingCurrencyCapabilitiesReadPort,
  type PmsPricingCurrencyChangeBlockersReadPort,
  type PmsPricingReadPort,
  type PropertyPricingCurrencyCommandError,
} from "@vayada/domain-pms";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type RoomTypeParams = PropertyParams & { roomTypeId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type PmsPricingRoutesOptions = {
  /** Owner-only first-currency and currency saves on the ordinary login (VAY-2056); replaces
   * commandPort for the currency route. Requires propertyAccessRepository. */
  currencyCommandPort?: Pick<PmsPricingCommandPort, "upsertPropertyPricingCurrency">;
  /** VAY-2390 P5: the Owner's protected currency change (`ownerCurrencyChange` on the API login),
   * and what it would be refused for right now. */
  currencyChangeCommandPort?: Pick<PmsPricingCommandPort, "upsertPropertyPricingCurrency"> &
    PmsPricingCurrencyChangeBlockersReadPort;
  propertyAccessRepository?: PropertyAccessRepository;
  commandPort: PmsPricingCommandPort;
  readPort: PmsPricingReadPort;
  currencyCapabilitiesReadPort: PmsPricingCurrencyCapabilitiesReadPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Currency adapter; with requireOwnerSession it applies the hotel-setup Owner-only gates. */
export function registerPmsPricingCurrencyCommand(
  app: FastifyInstance,
  commandPort: Pick<PmsPricingCommandPort, "upsertPropertyPricingCurrency">,
  options: {
    requireOwnerSession?: boolean;
    propertyAccessRepository?: PropertyAccessRepository;
    /** VAY-2390 P5: the Owner's protected change, on its own path and key. */
    path?: string;
    permission?: PermissionKey;
  } = {},
): void {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = await authorizeRequest(
      request,
      reply,
      options.requireOwnerSession,
      options.propertyAccessRepository,
      options.permission,
    );
    if (scope) authorized.set(request, scope);
  };

  app.put<{ Params: PropertyParams; Body: unknown }>(
    options.path ?? "/properties/:propertyId/pricing-source/currency",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isExactObject(request.body, ["expectedPricingCurrencyRevision", "currency"])) {
        return invalidRequest(reply, "The pricing currency body is invalid.");
      }
      const command = parseUpsertPropertyPricingCurrencyCommand({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        idempotencyKey,
        audit: commandAudit(scope.context),
        expectedPricingCurrencyRevision: request.body["expectedPricingCurrencyRevision"],
        currency: request.body["currency"],
      });
      if (!command) return invalidRequest(reply, "The pricing currency body is invalid.");

      const result = parsePropertyPricingCurrencyCommandResult(
        await commandPort.upsertPropertyPricingCurrency(command),
      );
      if (
        !result ||
        (result.ok && result.response.pricingCurrency.propertyId !== scope.propertyId)
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(result.response.outcome === "created" ? 201 : 200).send(result.response)
        : sendCurrencyError(reply, result.error);
    },
  );
}

/** Target pricing adapter. Currency changes stay fail-closed until the shared dependency guard lands. */
export async function registerPmsPricingRoutes(
  app: FastifyInstance,
  options: PmsPricingRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = await authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  if (options.currencyCommandPort) {
    if (!options.propertyAccessRepository)
      throw new Error("Currency saves require property access");
    registerPmsPricingCurrencyCommand(app, options.currencyCommandPort, {
      requireOwnerSession: true,
      propertyAccessRepository: options.propertyAccessRepository,
    });
  } else registerPmsPricingCurrencyCommand(app, options.commandPort);
  if (options.currencyChangeCommandPort) {
    if (!options.propertyAccessRepository)
      throw new Error("Currency changes require property access");
    registerPmsPricingCurrencyCommand(app, options.currencyChangeCommandPort, {
      requireOwnerSession: true,
      propertyAccessRepository: options.propertyAccessRepository,
      path: "/properties/:propertyId/pricing-source/currency-change",
      permission: "finance.billing.manage",
    });
    const changePort = options.currencyChangeCommandPort;
    const propertyAccessRepository = options.propertyAccessRepository;
    const ownerOnly = new WeakMap<FastifyRequest, AuthorizedScope>();
    // A read-only preview for the dialog: the same Owner gate, no locks; the change checks again.
    app.get<{ Params: PropertyParams }>(
      "/properties/:propertyId/pricing-source/currency-change/blockers",
      {
        onRequest: async (request, reply) => {
          const scope = await authorizeRequest(
            request,
            reply,
            true,
            propertyAccessRepository,
            "finance.billing.manage",
          );
          if (scope) ownerOnly.set(request, scope);
        },
      },
      async (request, reply) => {
        const scope = requireAuthorizedScope(ownerOnly, request);
        const blockers = parsePmsPricingCurrencyChangeBlockers(
          await changePort.getCurrencyChangeBlockers(scope.propertyId),
        );
        return blockers ? reply.status(200).send({ blockers }) : invalidPortResult(reply);
      },
    );
  }

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/pricing-source/currency-capabilities",
    { onRequest: authorize },
    async (request, reply) => {
      requireAuthorizedScope(authorized, request);
      try {
        const value = await options.currencyCapabilitiesReadPort.getPricingCurrencyCapabilities();
        if (value === null) {
          return reply.status(503).send({ code: "pms_pricing_currency_capabilities_unavailable" });
        }
        const capabilities = parsePmsPricingCurrencyCapabilities(value);
        return capabilities
          ? reply.status(200).send(capabilities)
          : reply
              .status(500)
              .send({ code: "pms_pricing_currency_capabilities_port_contract_violation" });
      } catch {
        return reply.status(503).send({ code: "pms_pricing_currency_capabilities_unavailable" });
      }
    },
  );

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/pricing-source",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const value = await options.readPort.getPricingSourceSnapshot(scope.propertyId);
      if (!value) return reply.status(404).send({ code: "pricing_currency_not_configured" });
      const snapshot = parsePmsPricingSourceSnapshot(value);
      return snapshot && snapshot.propertyId === scope.propertyId
        ? reply.status(200).send(snapshot)
        : invalidPortResult(reply);
    },
  );

  app.get<{ Params: RoomTypeParams }>(
    "/properties/:propertyId/room-types/:roomTypeId/flexible-rate-plan",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const roomTypeId = readRoomTypeId(request.params, reply);
      if (!roomTypeId) return reply;
      const value = await options.readPort.getFlexibleRatePlan(scope.propertyId, roomTypeId);
      if (!value) return reply.status(404).send({ code: "flexible_rate_plan_not_found" });
      const snapshot = parseFlexibleRatePlanSnapshot(value);
      return snapshot &&
        snapshot.propertyId === scope.propertyId &&
        snapshot.roomTypeId === roomTypeId
        ? reply.status(200).send(snapshot)
        : invalidPortResult(reply);
    },
  );
}

async function authorizeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  requireOwnerSession = false,
  propertyAccessRepository?: PropertyAccessRepository,
  permissionOverride?: PermissionKey,
): Promise<AuthorizedScope | null> {
  const permission =
    permissionOverride ??
    (request.method === "GET" ? "pms.operations.read" : "pms.operations.manage");
  try {
    const baseContext = enforceRoutePolicy(request, { permission });
    if (baseContext.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({ code: "invalid_organization_scope" });
      return null;
    }
    if (requireOwnerSession && !baseContext.actor.providerIdentity.sessionId)
      throw new AuthorizationError();
    const rawPropertyId = (request.params as Partial<PropertyParams>).propertyId;
    if (typeof rawPropertyId !== "string" || !UUID_PATTERN.test(rawPropertyId)) {
      invalidRequest(reply, "The property ID is invalid.");
      return null;
    }
    const propertyId = rawPropertyId.toLowerCase();
    const resource = {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
    } as const;
    const context = enforceRoutePolicy(request, {
      permission,
      entitlement: { product: "pms", key: "property-management", resource },
      resource: {
        ...resource,
        allowedRelationships: requireOwnerSession ? ["owner"] : ["owner", "operator"],
      },
    });
    if (propertyAccessRepository) {
      await requirePropertyAccess(context, propertyAccessRepository, {
        propertyId,
        targetResource: { product: "pms", resourceType: "pms_property" },
        allowedRelationships: ["owner"],
      });
    }
    return { context, propertyId };
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

function commandAudit(context: AuthorizedScope["context"]): PmsPricingCommandAudit {
  return {
    actor: { kind: "user", userId: context.actor.internalUserId },
    requestId: context.audit.requestId,
    correlationId: context.audit.correlationId ?? null,
    requestedAt: context.audit.receivedAt,
  };
}

function requireAuthorizedScope(
  authorized: WeakMap<FastifyRequest, AuthorizedScope>,
  request: FastifyRequest,
): AuthorizedScope {
  const scope = authorized.get(request);
  if (!scope) throw new Error("PMS pricing authorization was not resolved before body parsing");
  return scope;
}

function readRoomTypeId(params: RoomTypeParams, reply: FastifyReply): string | null {
  if (!UUID_PATTERN.test(params.roomTypeId)) {
    invalidRequest(reply, "The room type ID is invalid.");
    return null;
  }
  return params.roomTypeId.toLowerCase();
}

export function readIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") return null;
  const key = header.trim();
  return key.length >= 1 && key.length <= 200 ? key : null;
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string") &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sendCurrencyError(
  reply: FastifyReply,
  error: PropertyPricingCurrencyCommandError,
): FastifyReply {
  if (error.code === "setup_scope_unavailable") return reply.status(404).send(error);
  if (error.code === "unsupported_pricing_currency") return reply.status(422).send(error);
  return reply.status(409).send(error);
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function invalidPortResult(reply: FastifyReply): FastifyReply {
  return reply.status(500).send({ code: "pms_pricing_port_contract_violation" });
}
