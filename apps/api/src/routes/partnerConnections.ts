import { UnauthorizedError, requireAuthContext, type RequestContext } from "@vayada/backend-auth";
import {
  AuthorizationError,
  hasActiveEntitlement,
  hasActiveLinkedResource,
  hasPermission,
  resolveEffectivePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  authorizationRedirect,
  checkAuthorizationRequest,
  type PartnerConnectionsRepository,
} from "../domains/partnerConnections.js";

/**
 * VAY-2436: the hotel's side of a partner connection, for Booking Admin (signed in with WorkOS).
 *
 *   GET    /api/booking/partner-authorizations?<authorize query>
 *          the approval page: the app's name, the scopes it asks for and the hotels this person may
 *          connect it to. 400 { code } for a request to show as an error; 400 { code, redirectTo }
 *          for one to send back to the app.
 *   POST   /api/booking/partner-authorizations
 *          { authorization: <authorize query>, decision: "allow" | "deny", propertyId }
 *          Allow records the approval and answers { redirectTo } with a one-time code; Deny answers
 *          { redirectTo } with error=access_denied.
 *   GET    /api/booking/properties/:propertyId/partner-connections   the hotel's connected apps
 *   DELETE /api/booking/properties/:propertyId/partner-connections/:connectionId   Disconnect
 *
 * Who may connect or disconnect (Flamur, 2026-11-20): anyone who can manage the hotel's promo codes.
 */
export type PartnerConnectionRoutesOptions = {
  repository: PartnerConnectionsRepository;
  propertyAccessRepository: PropertyAccessRepository;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELATIONSHIPS = ["owner", "operator"] as const;

type PropertyParams = { propertyId: string };
type ConnectionParams = PropertyParams & { connectionId: string };

export async function registerPartnerConnectionRoutes(
  app: FastifyInstance,
  { repository, propertyAccessRepository }: PartnerConnectionRoutesOptions,
) {
  /** The hotels this person may connect an app to or disconnect one from. */
  async function manageablePropertyIds(context: RequestContext): Promise<string[]> {
    if (!hasPermission(context, "booking.promos.manage")) return [];
    const access = await resolveEffectivePropertyAccess(context, propertyAccessRepository);
    return (access?.propertyIds ?? []).filter((propertyId) =>
      bookingHotelAccess(context, propertyId),
    );
  }

  async function checkedRequest(params: Record<string, unknown>) {
    const clientId = params["client_id"];
    const partnerApp = typeof clientId === "string" ? await repository.findApp(clientId) : null;
    return checkAuthorizationRequest(partnerApp, params);
  }

  app.get("/partner-authorizations", async (request, reply) => {
    const context = signedInHotelMember(request, reply);
    if (!context) return reply;
    reply.header("Cache-Control", "private, no-store");
    const checked = await checkedRequest(record(request.query) ?? {});
    if (!checked.ok) return sendRequestError(reply, checked);
    const properties = await repository.readApprovableProperties(
      await manageablePropertyIds(context),
    );
    return reply.send({
      app: { name: checked.request.app.name },
      scopes: checked.request.scopes,
      properties,
    });
  });

  app.post("/partner-authorizations", async (request, reply) => {
    const context = signedInHotelMember(request, reply);
    if (!context) return reply;
    reply.header("Cache-Control", "private, no-store");
    const body = record(request.body);
    const authorization = record(body?.["authorization"]);
    const decision = body?.["decision"];
    if (!authorization || (decision !== "allow" && decision !== "deny"))
      return reply.status(400).send({ code: "invalid_request" });
    const checked = await checkedRequest(authorization);
    if (!checked.ok) return sendRequestError(reply, checked);
    const { redirectUri, state } = checked.request;
    if (decision === "deny")
      return reply.send({
        redirectTo: authorizationRedirect(redirectUri, { error: "access_denied" }, state),
      });

    const propertyId = body?.["propertyId"];
    if (typeof propertyId !== "string" || !UUID.test(propertyId))
      return reply.status(400).send({ code: "invalid_property" });
    const normalized = propertyId.toLowerCase();
    if (!(await manageablePropertyIds(context)).includes(normalized))
      return reply.status(403).send({ code: "forbidden" });
    const { code } = await repository.approve({
      request: checked.request,
      propertyId: normalized,
      approvedByUserId: context.actor.internalUserId,
    });
    return reply.send({ redirectTo: authorizationRedirect(redirectUri, { code }, state) });
  });

  async function propertyScope(
    request: FastifyRequest<{ Params: PropertyParams }>,
    reply: FastifyReply,
    manage: boolean,
  ): Promise<{ context: RequestContext; propertyId: string } | null> {
    const context = signedInHotelMember(request, reply);
    if (!context) return null;
    const raw = request.params.propertyId;
    if (!UUID.test(raw)) {
      reply.status(400).send({ code: "invalid_property" });
      return null;
    }
    const propertyId = raw.toLowerCase();
    const permission = manage ? "booking.promos.manage" : "booking.promos.read";
    const access = hasPermission(context, permission)
      ? await resolveEffectivePropertyAccess(context, propertyAccessRepository)
      : null;
    if (!access?.propertyIds.includes(propertyId) || !bookingHotelAccess(context, propertyId)) {
      reply.status(403).send({ code: "forbidden" });
      return null;
    }
    return { context, propertyId };
  }

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/partner-connections",
    async (request, reply) => {
      const scope = await propertyScope(request, reply, false);
      if (!scope) return reply;
      return reply.header("Cache-Control", "private, no-store").send({
        connections: await repository.listConnections(scope.propertyId),
        canManage: hasPermission(scope.context, "booking.promos.manage"),
      });
    },
  );

  app.delete<{ Params: ConnectionParams }>(
    "/properties/:propertyId/partner-connections/:connectionId",
    async (request, reply) => {
      const scope = await propertyScope(request, reply, true);
      if (!scope) return reply;
      const { connectionId } = request.params;
      const disconnected =
        UUID.test(connectionId) &&
        (await repository.disconnect({
          propertyId: scope.propertyId,
          connectionId: connectionId.toLowerCase(),
          userId: scope.context.actor.internalUserId,
        }));
      if (!disconnected) return reply.status(404).send({ code: "connection_not_found" });
      return reply.status(204).send();
    },
  );
}

/** A Booking Engine hotel of this account, with the Booking Engine on. */
function bookingHotelAccess(context: RequestContext, propertyId: string): boolean {
  const resource = {
    product: "booking",
    resourceType: "booking_hotel",
    resourceId: propertyId,
  } as const;
  return (
    hasActiveLinkedResource(context, { ...resource, allowedRelationships: RELATIONSHIPS }) &&
    hasActiveEntitlement(context, { product: "booking", key: "booking-engine", resource })
  );
}

function signedInHotelMember(request: FastifyRequest, reply: FastifyReply): RequestContext | null {
  try {
    const context = requireAuthContext(request);
    if (
      context.actor.status !== "active" ||
      context.selectedOrganization.kind !== "hotel_group" ||
      context.selectedOrganization.status !== "active" ||
      context.membership.status !== "active"
    )
      throw new AuthorizationError();
    return context;
  } catch (error) {
    if (error instanceof UnauthorizedError) reply.status(401).send({ code: "unauthenticated" });
    else if (error instanceof AuthorizationError) reply.status(403).send({ code: "forbidden" });
    else throw error;
    return null;
  }
}

function sendRequestError(
  reply: FastifyReply,
  checked: ReturnType<typeof checkAuthorizationRequest> & { ok: false },
) {
  return reply
    .status(400)
    .send(
      checked.redirectable
        ? { code: checked.error, redirectTo: checked.redirectTo }
        : { code: checked.error },
    );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
