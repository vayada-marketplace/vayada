import pg from "pg";
import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError, type PropertyAccessRepository } from "@vayada/backend-authorization";
import { parseBookingGuestPolicyChoices } from "@vayada/domain-booking";
import type { FastifyInstance } from "fastify";

import { writePmsOperationsCorsHeaders } from "./pmsOperations.js";
import { enforcePmsPropertyRoutePolicy } from "./pmsPropertyPolicy.js";

/** VAY-2455: the check-in and check-out times guests see on the booking page (the property's guest rules), read
 * only, for the PMS team that works with bookings: the front desk shows them on a booking, the dashboard's
 * departures and the check-in. Changing them stays with `booking.settings.manage` (the guest-rules PUT). */
export type PmsGuestStayTimes = { checkInTime: string; checkOutTime: string };

export type PmsGuestStayTimesResponse = { propertyId: string; times: PmsGuestStayTimes | null };

export type PmsGuestStayTimesRepository = {
  /** Null while the property has no guest rules. */
  find(propertyId: string, organizationId: string): Promise<PmsGuestStayTimes | null>;
  close?(): Promise<void>;
};

const PATH = "/properties/:propertyId/guest-stay-times";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function registerPmsGuestStayTimesRoutes(
  app: FastifyInstance,
  options: {
    repository: PmsGuestStayTimesRepository;
    propertyAccessRepository: PropertyAccessRepository;
    allowedOrigins: string[];
  },
): Promise<void> {
  app.addHook("onClose", async () => options.repository.close?.());
  app.addHook("onRequest", async (request, reply) => {
    if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins))
      return reply.code(403).send({ code: "origin_not_allowed" });
  });
  app.options(PATH, async (_request, reply) => reply.code(204).send());

  app.get<{ Params: { propertyId: string } }>(PATH, async (request, reply) => {
    const propertyId = UUID_PATTERN.test(request.params.propertyId)
      ? request.params.propertyId.toLowerCase()
      : null;
    if (!propertyId)
      return reply
        .status(400)
        .send({ code: "invalid_request", message: "The property ID is invalid." });
    let organizationId: string;
    try {
      const context = await enforcePmsPropertyRoutePolicy(
        request,
        {
          propertyId,
          permission: "pms.reservation.read",
          allowedRelationships: ["owner", "operator", "front_desk"],
        },
        options.propertyAccessRepository,
      );
      organizationId = context.selectedOrganization.organizationId;
    } catch (error) {
      if (error instanceof UnauthorizedError)
        return reply.status(401).send({ code: "unauthenticated" });
      if (error instanceof AuthorizationError) return reply.status(403).send({ code: "forbidden" });
      throw error;
    }
    try {
      const times = await options.repository.find(propertyId, organizationId);
      return reply
        .header("Cache-Control", "private, no-store")
        .send({ propertyId, times } satisfies PmsGuestStayTimesResponse);
    } catch (error) {
      request.log.error({ err: error, propertyId }, "PMS guest stay times read failed");
      return reply.status(503).send({ code: "guest_stay_times_unavailable" });
    }
  });
}

/** A plain read of the current guest rules: no lock, so it never queues behind a guest-rules save. */
export function createPgPmsGuestStayTimesRepository(config: {
  connectionString: string;
  max?: number;
}): PmsGuestStayTimesRepository {
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });
  return {
    async find(propertyId, organizationId) {
      const row = (
        await pool.query<{ choices: unknown }>(
          `SELECT revision.choices FROM booking.guest_choice_heads head
           JOIN booking.guest_choice_revisions revision
             ON revision.property_id = head.property_id AND revision.revision = head.revision
           WHERE head.property_id = $1::uuid AND revision.organization_id = $2::uuid`,
          [propertyId, organizationId],
        )
      ).rows[0];
      if (!row) return null;
      const choices = parseBookingGuestPolicyChoices(row.choices);
      if (!choices) throw new Error("Stored guest rules are invalid.");
      return { checkInTime: choices.checkInTime, checkOutTime: choices.checkOutTime };
    },
    async close() {
      await pool.end();
    },
  };
}
