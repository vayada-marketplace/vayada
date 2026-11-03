import { UnauthorizedError, type RequestContext } from "@vayada/backend-auth";
import {
  AuthorizationError,
  hasActiveEntitlement,
  resolveEffectivePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import { parseAccountBookingPageUpdate } from "@vayada/domain-booking";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  AccountBookingPageSaveError,
  AccountBookingPagesRepository,
} from "../domains/accountBookingPages.js";
import { enforceRoutePolicy } from "./policy.js";

export type AccountBookingPageRoutesOptions = {
  repository: AccountBookingPagesRepository;
  propertyAccessRepository: PropertyAccessRepository;
};

const MESSAGES: Record<AccountBookingPageSaveError, [number, string]> = {
  account_not_found: [404, "This account can't have a booking page."],
  header_image_invalid: [422, "Upload the header image again: this one can't be used."],
  page_changed: [
    409,
    "Someone else saved this page meanwhile. Reload it and make your changes again.",
  ],
  slug_taken: [409, "This address is already taken. Choose another one."],
  account_needs_two_properties: [
    422,
    "A booking page for all stays needs at least two active properties in the account.",
  ],
  property_not_in_account: [422, "Only properties of this account can be on its booking page."],
  property_not_ready: [
    422,
    "A property can join once it has a published booking page, a property type and a map location.",
  ],
  design_property_not_included: [422, "Copy the design from one of the included stays."],
  no_ready_property: [422, "Include at least one ready property before turning the page live."],
};

/**
 * Booking Admin › Settings › Multi-property booking engine (VAY-2456): the agency booking page of the
 * selected account. It speaks for every stay, so it needs `booking.settings.manage` and access to all of
 * the account's properties (an agency member, not an external owner or a member with assigned ones).
 */
export async function registerAccountBookingPageRoutes(
  app: FastifyInstance,
  options: AccountBookingPageRoutesOptions,
) {
  const { repository, propertyAccessRepository } = options;
  app.addHook("onClose", async () => repository.close?.());
  const contexts = new WeakMap<FastifyRequest, RequestContext>();
  const onRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const context = enforceRoutePolicy(request, { permission: "booking.settings.manage" });
      const access =
        context.selectedOrganization.kind === "hotel_group"
          ? await resolveEffectivePropertyAccess(context, propertyAccessRepository)
          : null;
      if (access?.mode !== "all")
        return reply.status(403).send({ code: "all_properties_access_required" });
      // Like the hotels' own booking settings: the booking engine must be active, here for at least
      // one of the account's properties (a suspended one counts as off).
      const bookingEngine = access.propertyIds.some((propertyId) =>
        hasActiveEntitlement(context, {
          product: "booking",
          key: "booking-engine",
          resource: { product: "booking", resourceType: "booking_hotel", resourceId: propertyId },
        }),
      );
      if (!bookingEngine) return reply.status(403).send({ code: "booking_engine_not_active" });
      contexts.set(request, context);
    } catch (error) {
      if (error instanceof UnauthorizedError)
        return reply.status(401).send({ code: "unauthenticated" });
      if (error instanceof AuthorizationError) return reply.status(403).send({ code: "forbidden" });
      throw error;
    }
  };
  const contextOf = (request: FastifyRequest) => {
    const context = contexts.get(request);
    if (!context) throw new Error("Account booking page authorization missing");
    return context;
  };
  const url = "/account-booking-page";

  app.get(url, { onRequest }, async (request, reply) => {
    const organizationId = contextOf(request).selectedOrganization.organizationId;
    try {
      const summary = await repository.read(organizationId);
      if (!summary) return reply.status(404).send({ code: "account_not_found" });
      return reply.header("Cache-Control", "private, no-store").send(summary);
    } catch (error) {
      request.log.error({ err: error, organizationId }, "Account booking page read failed");
      return reply.status(503).send({ code: "account_booking_page_unavailable" });
    }
  });

  app.put(url, { onRequest }, async (request, reply) => {
    const context = contextOf(request);
    const organizationId = context.selectedOrganization.organizationId;
    const update = parseAccountBookingPageUpdate(request.body);
    if (!update)
      return reply.status(400).send({
        code: "invalid_account_booking_page",
        message: "Some settings are missing or not valid.",
      });
    try {
      const result = await repository.save({
        organizationId,
        update,
        audit: {
          actorUserId: context.actor.internalUserId,
          requestId: context.audit.requestId,
          correlationId: context.audit.correlationId ?? null,
        },
      });
      reply.header("Cache-Control", "no-store");
      if (result.ok) return reply.send(result.summary);
      const [status, message] = MESSAGES[result.error];
      return reply.status(status).send({ code: result.error, message });
    } catch (error) {
      request.log.error({ err: error, organizationId }, "Account booking page save failed");
      return reply.status(503).send({ code: "account_booking_page_unavailable" });
    }
  });
}
