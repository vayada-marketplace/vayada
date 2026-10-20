import type { RequestContext } from "@vayada/backend-auth";
import {
  AuthorizationError,
  resolveEffectivePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import {
  HOTEL_SETUP_CHECKLIST_ACKNOWLEDGEABLE,
  type HotelSetupChecklistAcknowledgeable,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  HotelSetupChecklistService,
  HotelSetupChecklistViewerChange,
} from "../domains/hotelSetupChecklistService.js";
import type { HotelFirstRunActor } from "../domains/hotelFirstRunSteps.js";
import { enforceRoutePolicy } from "./policy.js";

/**
 * VAY-2247 wave 2: the setup checklist both dashboards show.
 *   GET  /api/hotel-setup/properties/:propertyId/checklist
 *   POST /api/hotel-setup/properties/:propertyId/checklist/acknowledgements  { item }   ("Looks good")
 *   PUT  /api/hotel-setup/properties/:propertyId/checklist/viewer  { hidden?, dismissed? }
 * For anyone who may manage the hotel's setup, on a property in their scope, with their own session:
 * "Looks good" is for the whole hotel, Hide for now and Dismiss only for the signed-in person.
 */

export type HotelSetupChecklistRouteOptions = {
  createService(
    context: RequestContext,
  ): Pick<HotelSetupChecklistService, "read" | "acknowledge" | "setViewer">;
  propertyAccessRepository: PropertyAccessRepository;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseChecklistAcknowledgement(
  value: unknown,
): HotelSetupChecklistAcknowledgeable | null {
  if (!exact(value, ["item"])) return null;
  const item = value.item;
  return typeof item === "string" &&
    (HOTEL_SETUP_CHECKLIST_ACKNOWLEDGEABLE as readonly string[]).includes(item)
    ? (item as HotelSetupChecklistAcknowledgeable)
    : null;
}

export function parseChecklistViewerChange(value: unknown): HotelSetupChecklistViewerChange | null {
  if (!exact(value, ["hidden", "dismissed"])) return null;
  const change: { hidden?: boolean; dismissed?: boolean } = {};
  for (const key of ["hidden", "dismissed"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== "boolean") return null;
    change[key] = value[key] as boolean;
  }
  return Object.keys(change).length > 0 ? Object.freeze(change) : null;
}

async function checklistActor(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: PropertyAccessRepository,
): Promise<{ context: RequestContext; actor: HotelFirstRunActor } | null> {
  const propertyId = (request.params as { propertyId?: string }).propertyId ?? "";
  if (!UUID.test(propertyId)) {
    reply.status(400).send({ code: "invalid_property_id" });
    return null;
  }
  const context = enforceRoutePolicy(request, { permission: "hotel_catalog.setup.manage" });
  if (
    context.selectedOrganization.kind !== "hotel_group" ||
    !context.actor.providerIdentity.sessionId
  ) {
    reply.status(403).send({ code: "session_required" });
    return null;
  }
  const effective = await resolveEffectivePropertyAccess(context, repository);
  if (!effective?.propertyIds.includes(propertyId)) throw new AuthorizationError();
  return {
    context,
    actor: Object.freeze({
      organizationId: context.selectedOrganization.organizationId,
      propertyId: propertyId.toLowerCase(),
      userId: context.actor.internalUserId,
      requestId: context.audit.requestId,
      correlationId: context.audit.correlationId ?? null,
      requestedAt: context.audit.receivedAt,
    }),
  };
}

export async function registerHotelSetupChecklistRoutes(
  app: FastifyInstance,
  options: HotelSetupChecklistRouteOptions,
) {
  const send = (reply: FastifyReply, checklist: unknown) =>
    checklist
      ? reply.status(200).send(checklist)
      : reply.status(404).send({ code: "property_not_found" });

  app.get("/properties/:propertyId/checklist", async (request, reply) => {
    const member = await checklistActor(request, reply, options.propertyAccessRepository);
    if (!member) return reply;
    return send(reply, await options.createService(member.context).read(member.actor));
  });

  app.post("/properties/:propertyId/checklist/acknowledgements", async (request, reply) => {
    const member = await checklistActor(request, reply, options.propertyAccessRepository);
    if (!member) return reply;
    const item = parseChecklistAcknowledgement(request.body);
    if (!item) return reply.status(400).send({ code: "invalid_checklist_acknowledgement" });
    return send(reply, await options.createService(member.context).acknowledge(member.actor, item));
  });

  app.put("/properties/:propertyId/checklist/viewer", async (request, reply) => {
    const member = await checklistActor(request, reply, options.propertyAccessRepository);
    if (!member) return reply;
    const change = parseChecklistViewerChange(request.body);
    if (!change) return reply.status(400).send({ code: "invalid_checklist_viewer_change" });
    return send(reply, await options.createService(member.context).setViewer(member.actor, change));
  });
}
