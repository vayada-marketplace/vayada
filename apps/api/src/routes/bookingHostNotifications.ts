import { UnauthorizedError } from "@vayada/backend-auth";
import {
  AuthorizationError,
  hasPermission,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  HOST_NOTIFICATION_MARK_LIMIT,
  isHostNotificationKey,
  type BookingHostNotificationsRepository,
  type HostNotificationViewer,
  type HostSyncDomain,
} from "../domains/bookingHostNotifications.js";
import { enforcePropertyRoutePolicy, enforceRoutePolicy } from "./policy.js";

export type BookingHostNotificationRoutesOptions = {
  repository: BookingHostNotificationsRepository;
  propertyAccessRepository: PropertyAccessRepository;
  /** The PMS syncs whose command runs in this environment, so "Retry sync" isn't offered when it would be
   * refused. */
  syncRetryDomains?: readonly HostSyncDomain[];
};

const PERMISSION = "booking.reservation.read";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Scope = { propertyId: string; viewer: HostNotificationViewer };

/** Booking Admin's notifications bell (VAY-2349): the selected property's feed and the person's read marks.
 * Anyone who may read the property's reservations sees it; promo codes, guest contact and "Retry sync"
 * follow their own permissions. */
export async function registerBookingHostNotificationRoutes(
  app: FastifyInstance,
  options: BookingHostNotificationRoutesOptions,
) {
  const { repository, propertyAccessRepository, syncRetryDomains = [] } = options;
  app.addHook("onClose", async () => repository.close?.());
  const scopes = new WeakMap<FastifyRequest, Scope>();
  const onRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = await authorize(request, reply, propertyAccessRepository, syncRetryDomains);
    if (scope) scopes.set(request, scope);
  };
  const scopeOf = (request: FastifyRequest) => {
    const scope = scopes.get(request);
    if (!scope) throw new Error("Notifications authorization missing");
    return scope;
  };

  app.get("/properties/:propertyId/notifications", { onRequest }, async (request, reply) => {
    const { propertyId, viewer } = scopeOf(request);
    try {
      const feed = await repository.read(propertyId, viewer);
      if (!feed) return reply.status(404).send({ code: "property_not_found" });
      return reply.header("Cache-Control", "private, no-store").send(feed);
    } catch (error) {
      request.log.error({ err: error, propertyId }, "Notifications read failed");
      return reply.status(503).send({ code: "notifications_unavailable" });
    }
  });

  app.post("/properties/:propertyId/notifications/read", { onRequest }, async (request, reply) => {
    const { propertyId, viewer } = scopeOf(request);
    const body = request.body as { keys?: unknown } | null;
    const keys = body?.keys;
    if (
      !body ||
      Object.keys(body).some((key) => key !== "keys") ||
      !Array.isArray(keys) ||
      keys.length === 0 ||
      keys.length > HOST_NOTIFICATION_MARK_LIMIT ||
      !keys.every(isHostNotificationKey)
    )
      return reply.status(400).send({ code: "invalid_notification_keys" });
    try {
      await repository.markRead(propertyId, viewer.userId, keys);
      return reply.header("Cache-Control", "no-store").status(204).send();
    } catch (error) {
      request.log.error({ err: error, propertyId }, "Notifications mark read failed");
      return reply.status(503).send({ code: "notifications_unavailable" });
    }
  });

  app.post(
    "/properties/:propertyId/notifications/read-all",
    { onRequest },
    async (request, reply) => {
      const { propertyId, viewer } = scopeOf(request);
      // What the person saw: the feed's generatedAt, and the sync card's key when one was shown.
      const body = (request.body ?? {}) as { before?: unknown; syncAlertKey?: unknown };
      const before = typeof body.before === "string" ? new Date(body.before) : null;
      if (
        typeof body !== "object" ||
        Object.keys(body).some((key) => key !== "before" && key !== "syncAlertKey") ||
        !before ||
        Number.isNaN(before.getTime()) ||
        (body.syncAlertKey !== undefined &&
          body.syncAlertKey !== null &&
          !isHostNotificationKey(body.syncAlertKey))
      )
        return reply.status(400).send({ code: "invalid_read_all" });
      try {
        await repository.markAllRead(propertyId, viewer, {
          before,
          syncAlertKey: typeof body.syncAlertKey === "string" ? body.syncAlertKey : null,
        });
        return reply.header("Cache-Control", "no-store").status(204).send();
      } catch (error) {
        request.log.error({ err: error, propertyId }, "Notifications mark all read failed");
        return reply.status(503).send({ code: "notifications_unavailable" });
      }
    },
  );
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyAccessRepository: PropertyAccessRepository,
  syncRetryDomains: readonly HostSyncDomain[],
): Promise<Scope | null> {
  try {
    const base = enforceRoutePolicy(request, { permission: PERMISSION });
    if (base.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({ code: "forbidden" });
      return null;
    }
    const rawPropertyId = (request.params as { propertyId?: unknown }).propertyId;
    if (typeof rawPropertyId !== "string" || !UUID_PATTERN.test(rawPropertyId)) {
      reply.status(400).send({ code: "invalid_property" });
      return null;
    }
    const propertyId = rawPropertyId.toLowerCase();
    const resource = {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: propertyId,
    } as const;
    const context = await enforcePropertyRoutePolicy(
      request,
      {
        permission: PERMISSION,
        property: {
          propertyId,
          targetResource: { product: "booking", resourceType: "booking_hotel" },
        },
        entitlement: { product: "booking", key: "booking-engine", resource },
        resource: { ...resource, allowedRelationships: ["owner", "operator"] },
      },
      propertyAccessRepository,
    );
    return {
      propertyId,
      viewer: {
        userId: context.actor.internalUserId,
        organizationId: context.selectedOrganization.organizationId,
        canReadPromos: hasPermission(context, "booking.promos.read"),
        canReadGuestContact: hasPermission(context, "pms.guest_contact.read"),
        retrySyncDomains: canRunPmsSync(request, propertyId) ? syncRetryDomains : [],
      },
    };
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

/** "Retry sync" posts PMS → Channel manager's own sync command, so it shows only to people that command
 * accepts: the same permission, PMS product and property access. */
function canRunPmsSync(request: FastifyRequest, propertyId: string): boolean {
  const resource = {
    product: "pms",
    resourceType: "pms_property",
    resourceId: propertyId,
  } as const;
  try {
    enforceRoutePolicy(request, {
      permission: "pms.operations.manage",
      entitlement: { product: "pms", key: "property-management", resource },
      resource: { ...resource, allowedRelationships: ["owner", "operator", "front_desk"] },
    });
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError) return false;
    throw error;
  }
}
