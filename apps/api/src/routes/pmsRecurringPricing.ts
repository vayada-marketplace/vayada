import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  parsePmsRecurringPricingBookingEvidence,
  parsePmsRecurringPricingSourceSnapshot,
  type PmsRecurringPricingReadPort,
  type PmsRecurringPricingSourceKind,
} from "@vayada/domain-pms";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type SourceParams = PropertyParams & { sourceId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type PmsRecurringPricingRoutesOptions = {
  readPort: PmsRecurringPricingReadPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_KINDS = [
  "season",
  "weekend_surcharge",
  "additional_guest",
  "non_refundable",
] as const satisfies readonly PmsRecurringPricingSourceKind[];

/** Target recurring-pricing owner adapter. */
export async function registerPmsRecurringPricingRoutes(
  app: FastifyInstance,
  options: PmsRecurringPricingRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/pricing-source/recurring",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const rawSources = await options.readPort.listRecurringPricingSources(scope.propertyId);
      const sources = rawSources.map(parsePmsRecurringPricingSourceSnapshot);
      if (
        sources.some((source) => !source || source.propertyId !== scope.propertyId) ||
        !isStrictlySortedSources(sources)
      ) {
        return invalidPortResult(reply);
      }
      return reply.status(200).send({ sources });
    },
  );

  app.get<{ Params: SourceParams }>(
    "/properties/:propertyId/pricing-source/recurring/:sourceId",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const sourceId = readSourceId(request.params, reply);
      if (!sourceId) return reply;
      const rawSource = await options.readPort.getRecurringPricingSource(
        scope.propertyId,
        sourceId,
      );
      if (!rawSource) return reply.status(404).send({ code: "source_not_found" });
      const source = parsePmsRecurringPricingSourceSnapshot(rawSource);
      return source && source.propertyId === scope.propertyId && source.sourceId === sourceId
        ? reply.status(200).send(source)
        : invalidPortResult(reply);
    },
  );

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/pricing-source/recurring-booking-evidence",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const rawEvidence = await options.readPort.getRecurringPricingBookingEvidence(
        scope.propertyId,
      );
      if (!rawEvidence) {
        return reply.status(404).send({ code: "pricing_currency_not_configured" });
      }
      const evidence = parsePmsRecurringPricingBookingEvidence(rawEvidence);
      return evidence && evidence.propertyId === scope.propertyId
        ? reply.status(200).send(evidence)
        : invalidPortResult(reply);
    },
  );
}

function authorizeRequest(request: FastifyRequest, reply: FastifyReply): AuthorizedScope | null {
  const permission = request.method === "GET" ? "pms.operations.read" : "pms.operations.manage";
  try {
    const baseContext = enforceRoutePolicy(request, { permission });
    if (baseContext.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({ code: "invalid_organization_scope" });
      return null;
    }
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
      resource: { ...resource, allowedRelationships: ["owner", "operator"] },
    });
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

function requireAuthorizedScope(
  authorized: WeakMap<FastifyRequest, AuthorizedScope>,
  request: FastifyRequest,
): AuthorizedScope {
  const scope = authorized.get(request);
  if (!scope) {
    throw new Error("PMS recurring pricing authorization was not resolved before body parsing");
  }
  return scope;
}

function readSourceId(params: SourceParams, reply: FastifyReply): string | null {
  if (!UUID_PATTERN.test(params.sourceId)) {
    invalidRequest(reply, "The source ID is invalid.");
    return null;
  }
  return params.sourceId.toLowerCase();
}

function isStrictlySortedSources(
  sources: readonly ReturnType<typeof parsePmsRecurringPricingSourceSnapshot>[],
): boolean {
  let previous = "";
  for (const source of sources) {
    if (!source) return false;
    const key = `${String(SOURCE_KINDS.indexOf(source.sourceKind)).padStart(2, "0")}:${source.sourceId}`;
    if (key <= previous) return false;
    previous = key;
  }
  return true;
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function invalidPortResult(reply: FastifyReply): FastifyReply {
  return reply.status(500).send({ code: "pms_recurring_pricing_port_contract_violation" });
}
