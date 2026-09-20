import { UnauthorizedError, type RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  parseMarketplaceCommunicationPreferences,
  parseMarketplaceCommunicationUnsubscribeRequest,
  parseMarketplaceCommunicationUnsubscribeResult,
  parseReplaceMarketplaceCommunicationPreferences,
  parseReplaceMarketplaceCommunicationPreferencesResult,
  type MarketplaceCommunicationPreferenceCommandPort,
  type MarketplaceCommunicationPreferencePolicy,
  type MarketplaceCommunicationPreferenceReadPort,
  type MarketplaceCommunicationUnsubscribeCommandPort,
  type MarketplaceCommunicationUnsubscribeTokenPort,
  type ReplaceMarketplaceCommunicationPreferencesV1,
  type ReplaceMarketplaceCommunicationPreferencesResult,
} from "@vayada/domain-marketplace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

const PERMISSION = "marketplace.collaboration.write" as const;
const INVALID_BODY_ERROR_CODES = new Set([
  "FST_ERR_CTP_BODY_TOO_LARGE",
  "FST_ERR_CTP_EMPTY_JSON_BODY",
  "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
  "FST_ERR_CTP_INVALID_JSON_BODY",
  "FST_ERR_CTP_INVALID_MEDIA_TYPE",
]);

type AuthorizedScope = {
  context: RequestContext;
  policy: MarketplaceCommunicationPreferencePolicy;
};

export type MarketplaceCommunicationPreferencesRoutesOptions = {
  commandPort: MarketplaceCommunicationPreferenceCommandPort;
  readPort: MarketplaceCommunicationPreferenceReadPort;
  policy: MarketplaceCommunicationPreferencePolicy;
  unsubscribe?: {
    commandPort: MarketplaceCommunicationUnsubscribeCommandPort;
    tokenPort: MarketplaceCommunicationUnsubscribeTokenPort;
    now?: () => Date;
  };
};

export async function registerMarketplaceCommunicationPreferencesRoutes(
  app: FastifyInstance,
  options: MarketplaceCommunicationPreferencesRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply, options.policy);
    if (scope) authorized.set(request, scope);
  };

  app.setErrorHandler((error, request, reply) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      INVALID_BODY_ERROR_CODES.has(error.code)
    )
      return request.routeOptions.url?.endsWith("/communication-unsubscribe")
        ? invalidUnsubscribe(reply)
        : invalidRequest(reply);
    return reply.send(error);
  });

  app.get("/communication-preferences", { onRequest: authorize }, async (request, reply) => {
    const scope = requireAuthorizedScope(authorized, request);
    let value: unknown;
    try {
      value = await options.readPort.getCommunicationPreferences(preferenceScope(scope));
    } catch {
      return portViolation(reply);
    }
    const preferences = parseMarketplaceCommunicationPreferences(value);
    return preferences?.organizationId === scope.context.selectedOrganization.organizationId
      ? reply.status(200).send(preferences)
      : portViolation(reply);
  });

  app.put<{ Body: unknown }>(
    "/communication-preferences",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      const body = parseReplaceMarketplaceCommunicationPreferences(request.body);
      if (!idempotencyKey || !body) return invalidRequest(reply);

      let value: unknown;
      try {
        value = await options.commandPort.replaceCommunicationPreferences({
          organizationId: scope.context.selectedOrganization.organizationId,
          userId: scope.context.actor.internalUserId,
          idempotencyKey,
          audit: {
            actorUserId: scope.context.actor.internalUserId,
            requestId: scope.context.audit.requestId,
            correlationId: scope.context.audit.correlationId ?? null,
            requestedAt: scope.context.audit.receivedAt,
          },
          request: body,
        });
      } catch {
        return portViolation(reply);
      }

      const result = parseReplaceMarketplaceCommunicationPreferencesResult(value);
      if (!validResult(result, scope, body)) return portViolation(reply);
      return result.ok
        ? reply.status(200).send(result.preferences)
        : sendCommandError(reply, result.error.code);
    },
  );

  if (options.unsubscribe) {
    app.post<{ Body: unknown }>("/communication-unsubscribe", async (request, reply) => {
      if (request.raw.url?.includes("?")) return invalidUnsubscribe(reply);
      const body = parseMarketplaceCommunicationUnsubscribeRequest(request.body);
      const acceptedAt = options.unsubscribe!.now?.() ?? new Date();
      const verified = body ? options.unsubscribe!.tokenPort.verify(body.token, acceptedAt) : null;
      if (!verified) return invalidUnsubscribe(reply);

      let value: unknown;
      try {
        value = await options.unsubscribe!.commandPort.unsubscribeCommunicationTopic({
          ...verified,
          audit: {
            requestId: String(request.id),
            correlationId: null,
            requestedAt: acceptedAt.toISOString(),
          },
        });
      } catch {
        return portViolation(reply);
      }
      const result = parseMarketplaceCommunicationUnsubscribeResult(value);
      if (!result) return portViolation(reply);
      return result.ok ? reply.status(204).send() : invalidUnsubscribe(reply);
    });
  }
}

function authorizeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  policy: MarketplaceCommunicationPreferencePolicy,
): AuthorizedScope | null {
  try {
    const context = enforceRoutePolicy(request, { permission: PERMISSION });
    if (
      context.actor.status !== "active" ||
      context.selectedOrganization.status !== "active" ||
      context.membership.status !== "active"
    ) {
      throw new AuthorizationError();
    }

    const resource = resolveProfileResource(context);
    enforceRoutePolicy(request, {
      permission: PERMISSION,
      ...(context.selectedOrganization.kind === "hotel_group"
        ? { entitlement: { product: "marketplace", key: "marketplace-hotel-profile" } }
        : {}),
      resource,
    });
    return { context, policy };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      reply.status(401).send({ error: { code: "unauthenticated" } });
      return null;
    }
    if (error instanceof AuthorizationError) {
      reply.status(403).send({ error: { code: "forbidden" } });
      return null;
    }
    throw error;
  }
}

function resolveProfileResource(context: RequestContext) {
  const kind = context.selectedOrganization.kind;
  const candidates = context.linkedResources
    .filter(
      (resource) =>
        resource.status === "active" &&
        resource.product === "marketplace" &&
        ((kind === "creator_workspace" &&
          resource.resourceType === "creator_profile" &&
          resource.relationship === "owner") ||
          (kind === "hotel_group" &&
            resource.resourceType === "hotel_profile" &&
            (resource.relationship === "owner" || resource.relationship === "operator"))),
    )
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  if ((kind !== "creator_workspace" && kind !== "hotel_group") || candidates.length === 0) {
    throw new AuthorizationError();
  }
  if (kind === "creator_workspace" && candidates.length !== 1) {
    throw new AuthorizationError();
  }
  const resource = candidates[0]!;
  return {
    product: resource.product,
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    allowedRelationships:
      kind === "creator_workspace" ? (["owner"] as const) : (["owner", "operator"] as const),
  };
}

function preferenceScope(scope: AuthorizedScope) {
  return {
    organizationId: scope.context.selectedOrganization.organizationId,
    userId: scope.context.actor.internalUserId,
    policy: scope.policy,
  };
}

function validResult(
  result: ReplaceMarketplaceCommunicationPreferencesResult | null,
  scope: AuthorizedScope,
  request: ReplaceMarketplaceCommunicationPreferencesV1,
): result is ReplaceMarketplaceCommunicationPreferencesResult {
  if (!result) return false;
  if (!result.ok) {
    return (
      result.error.code !== "preference_conflict" ||
      result.error.currentRevision !== request.expectedRevision
    );
  }
  return (
    result.preferences.organizationId === scope.context.selectedOrganization.organizationId &&
    (result.preferences.revision === request.expectedRevision + 1 ||
      (request.expectedRevision > 0 && result.preferences.revision === request.expectedRevision)) &&
    result.preferences.email.state === request.email.state &&
    result.preferences.email.source === "settings" &&
    result.preferences.topics.collaborationActionRequired.cadence ===
      request.topics.collaborationActionRequired.cadence &&
    result.preferences.topics.collaborationActionRequired.source === "settings"
  );
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") return null;
  const key = header.trim();
  return key.length >= 1 && key.length <= 200 ? key : null;
}

function sendCommandError(
  reply: FastifyReply,
  code: "idempotency_conflict" | "preference_conflict" | "command_in_progress" | "scope_forbidden",
) {
  if (code === "scope_forbidden") {
    return reply.status(403).send({ error: { code: "forbidden" } });
  }
  return reply.status(409).send({ error: { code } });
}

function requireAuthorizedScope(
  authorized: WeakMap<FastifyRequest, AuthorizedScope>,
  request: FastifyRequest,
): AuthorizedScope {
  const scope = authorized.get(request);
  if (!scope) throw new Error("Marketplace communication authorization was not resolved");
  return scope;
}

function invalidRequest(reply: FastifyReply) {
  return reply.status(400).send({ error: { code: "invalid_request" } });
}

function invalidUnsubscribe(reply: FastifyReply) {
  return reply.status(400).send({ error: { code: "invalid_or_expired_unsubscribe" } });
}

function portViolation(reply: FastifyReply) {
  return reply.status(500).send({ error: { code: "internal_error" } });
}
