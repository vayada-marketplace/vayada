import type { RequestContext } from "@vayada/backend-auth";
import {
  AuthorizationError,
  resolveEffectivePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import {
  FIRST_RUN_DEFAULT_BED,
  FIRST_RUN_DEFAULT_FREE_CANCELLATION_DAYS,
  isFirstRunBedChoice,
  isFirstRunFreeCancellationDays,
  type FirstRunFreeCancellationDays,
  type FirstRunRoomInput,
} from "@vayada/domain-booking";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { HotelFirstRunRequest, HotelFirstRunResult } from "../domains/hotelFirstRunService.js";
import type { HotelFirstRunState } from "../domains/hotelFirstRunState.js";
import {
  FIRST_RUN_MAX_ROOM_TYPES,
  type HotelFirstRunActor,
} from "../domains/hotelFirstRunSteps.js";
import { enforceRoutePolicy } from "./policy.js";

/**
 * VAY-2247: GET/POST /api/hotel-setup/properties/:propertyId/first-run, the server side of the new
 * setup in Booking Admin. Owner only, with the same checks as the hotel profile route; every step's
 * writer re-locks the owner's authority in its own transaction. Mounted only when
 * HOTEL_FIRST_RUN_ENABLED is on.
 */

export type HotelFirstRunRouteService = {
  read(actor: HotelFirstRunActor): Promise<HotelFirstRunState>;
  run(
    actor: HotelFirstRunActor,
    request: HotelFirstRunRequest,
    customerEmail: string | null,
  ): Promise<HotelFirstRunResult>;
};

export type HotelFirstRunRouteOptions = {
  /** Built per request: the pricing commands bind the signed-in context. */
  createService(context: RequestContext): HotelFirstRunRouteService;
  propertyAccessRepository: PropertyAccessRepository;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Codes that mean the request itself can't be used, rather than a step that conflicts. */
const REQUEST_ERRORS = new Set([
  "first_run_room_invalid",
  "first_run_price_invalid",
  "mandatory_charges_declaration_required",
]);

function exact(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key) || optional.includes(key))
  );
}

const ROOM_KEYS = ["name", "numberOfRooms", "maxGuests", "pricePerNight"] as const;

function parseRoom(room: unknown): FirstRunRoomInput | null {
  if (
    !exact(room, ROOM_KEYS) ||
    typeof room.name !== "string" ||
    !Number.isInteger(room.numberOfRooms) ||
    !Number.isInteger(room.maxGuests) ||
    typeof room.pricePerNight !== "string"
  )
    return null;
  return Object.freeze({
    name: room.name,
    numberOfRooms: room.numberOfRooms as number,
    maxGuests: room.maxGuests as number,
    pricePerNight: room.pricePerNight,
  });
}

/**
 * `cancellation`, when given: `{ kind: "free_until_days_before_arrival", days: 1 | 3 | 7 | 14 }`. Non-refundable
 * is refused for now: it is paid in advance (VAY-2280) and the first run only sets up paying at the property.
 */
function parseCancellation(value: unknown): FirstRunFreeCancellationDays | null {
  if (value === undefined) return FIRST_RUN_DEFAULT_FREE_CANCELLATION_DAYS;
  if (!exact(value, ["kind", "days"]) || value.kind !== "free_until_days_before_arrival")
    return null;
  return isFirstRunFreeCancellationDays(value.days) ? value.days : null;
}

/**
 * The body: `rooms` (1–10 room types, VAY-2247 1.12), or `room` for one, as the first version sent it.
 * Room type names must differ (the PMS keeps them unique per hotel, ignoring case). Optional since 1.12b:
 * `cancellation` and `bed` (double, queen, king, twin or single), the owner's choices for every room type;
 * without them the first run keeps its defaults (free until 3 days, one double bed).
 */
export function parseHotelFirstRunRequest(value: unknown): HotelFirstRunRequest | null {
  const roomsKey =
    typeof value === "object" && value !== null && Object.hasOwn(value, "rooms") ? "rooms" : "room";
  if (
    !exact(
      value,
      [roomsKey, "pricesIncludeMandatoryCharges", "guestPayment", "plan"],
      ["cancellation", "bed"],
    )
  )
    return null;
  const freeCancellationDays = parseCancellation(value.cancellation);
  const bed = value.bed === undefined ? FIRST_RUN_DEFAULT_BED : value.bed;
  if (freeCancellationDays === null || !isFirstRunBedChoice(bed)) return null;
  const given = roomsKey === "rooms" ? value.rooms : [value.room];
  if (!Array.isArray(given) || given.length < 1 || given.length > FIRST_RUN_MAX_ROOM_TYPES)
    return null;
  const rooms = given.map(parseRoom);
  if (
    rooms.some((room) => room === null) ||
    new Set(rooms.map((room) => room!.name.trim().toLowerCase())).size !== rooms.length ||
    typeof value.pricesIncludeMandatoryCharges !== "boolean" ||
    value.guestPayment !== "pay_at_property" ||
    (value.plan !== "commission" && value.plan !== "fixed_fee")
  ) {
    return null;
  }
  return Object.freeze({
    rooms: Object.freeze(rooms as FirstRunRoomInput[]),
    pricesIncludeMandatoryCharges: value.pricesIncludeMandatoryCharges,
    guestPayment: "pay_at_property",
    plan: value.plan,
    freeCancellationDays,
    bed,
  });
}

/** The hotel's owner, signed in with their own session, on a property their group owns. */
async function ownerActor(
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
    !context.actor.providerIdentity.sessionId ||
    context.membership.roleKey !== "hotel_owner" ||
    !context.linkedResources.some(
      (link) =>
        link.product === "hotel_catalog" &&
        link.resourceType === "property" &&
        link.resourceId === propertyId &&
        link.relationship === "owner" &&
        link.status === "active",
    )
  ) {
    reply.status(403).send({ code: "owner_session_required" });
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

export async function registerHotelFirstRunRoutes(
  app: FastifyInstance,
  options: HotelFirstRunRouteOptions,
) {
  app.get("/properties/:propertyId/first-run", async (request, reply) => {
    const owner = await ownerActor(request, reply, options.propertyAccessRepository);
    if (!owner) return reply;
    return reply.status(200).send(await options.createService(owner.context).read(owner.actor));
  });

  app.post("/properties/:propertyId/first-run", async (request, reply) => {
    const owner = await ownerActor(request, reply, options.propertyAccessRepository);
    if (!owner) return reply;
    const body = parseHotelFirstRunRequest(request.body);
    if (!body) return reply.status(400).send({ code: "invalid_first_run_request" });
    const result = await options
      .createService(owner.context)
      .run(owner.actor, body, owner.context.actor.email || null);
    if (result.ok) {
      return reply.status(200).send({
        state: result.state,
        ran: result.ran,
        ...(result.checkoutUrl ? { checkout: { url: result.checkoutUrl } } : {}),
      });
    }
    request.log.warn(
      { propertyId: owner.actor.propertyId, step: result.step, code: result.code },
      "Hotel first run stopped",
    );
    return reply
      .status(REQUEST_ERRORS.has(result.code) ? 422 : 409)
      .send({ code: result.code, step: result.step, state: result.state, ran: result.ran });
  });
}
