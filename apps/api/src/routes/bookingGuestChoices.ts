import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import type { createBookingGuestChoiceStore } from "../domains/bookingGuestChoiceStore.js";
import { authorizeRequest, exactDataRecord, readIdempotencyKey } from "./bookingGuestPolicy.js";

export type BookingGuestChoiceRoutesOptions = {
  store: ReturnType<typeof createBookingGuestChoiceStore>;
  propertyAccessRepository: PropertyAccessRepository;
};
export async function registerBookingGuestChoiceRoutes(
  app: FastifyInstance,
  options: BookingGuestChoiceRoutesOptions,
) {
  const scopes = new WeakMap<
    FastifyRequest,
    { propertyId: string; organizationId: string; actorUserId: string }
  >();
  for (const method of ["GET", "PUT"] as const)
    app.route({
      method,
      url: "/properties/:propertyId/guest-rules",
      onRequest: async (request, reply) => {
        const authorized = await authorizeRequest(request, reply, options.propertyAccessRepository);
        if (authorized)
          scopes.set(request, {
            propertyId: authorized.propertyId,
            organizationId: authorized.context.selectedOrganization.organizationId,
            actorUserId: authorized.context.actor.internalUserId,
          });
      },
      handler: async (request, reply) => {
        const scope = scopes.get(request);
        if (!scope) throw new Error("Guest-rule authorization missing");
        try {
          if (method === "GET") return reply.send({ current: await options.store.read(scope) });
          const requestId = readIdempotencyKey(request);
          if (
            !requestId ||
            !exactDataRecord(request.body, ["expectedRevision", "confirmed", "choices"])
          )
            return reply.status(400).send({ code: "invalid_guest_choices" });
          return reply.send(await options.store.save(scope, { ...request.body, requestId }));
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          const status =
            code === "invalid_guest_choices"
              ? 400
              : code === "guest_choices_denied"
                ? 403
                : ["guest_choices_stale", "guest_choices_idempotency_conflict"].includes(code)
                  ? 409
                  : null;
          if (status) return reply.status(status).send({ code });
          throw error;
        }
      },
    });
}
