import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import type { createBookingGuestChoiceStore } from "../domains/bookingGuestChoiceStore.js";
import type { createBookingGuestTermsStore } from "../domains/bookingGuestTermsStore.js";
import { authorizeRequest, exactDataRecord, readIdempotencyKey } from "./bookingGuestPolicy.js";

export type BookingGuestChoiceRoutesOptions = {
  store: ReturnType<typeof createBookingGuestChoiceStore>;
  termsStore: ReturnType<typeof createBookingGuestTermsStore>;
  propertyAccessRepository: PropertyAccessRepository;
};
type Scope = { propertyId: string; organizationId: string; actorUserId: string };
export async function registerBookingGuestChoiceRoutes(
  app: FastifyInstance,
  options: BookingGuestChoiceRoutesOptions,
) {
  const scopes = new WeakMap<FastifyRequest, Scope>();
  const route = (
    method: "GET" | "PUT",
    url: string,
    handle: (scope: Scope, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    statuses: Readonly<Record<string, number>>,
  ) =>
    app.route({
      method,
      url,
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
          return await handle(scope, request, reply);
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          const status = Object.hasOwn(statuses, code) ? statuses[code] : undefined;
          if (status) return reply.status(status).send({ code });
          throw error;
        }
      },
    });
  const choiceStatuses = {
    invalid_guest_choices: 400,
    guest_choices_denied: 403,
    guest_choices_stale: 409,
    guest_choices_idempotency_conflict: 409,
  };
  route(
    "GET",
    "/properties/:propertyId/guest-rules",
    async (scope, _request, reply) => reply.send({ current: await options.store.read(scope) }),
    choiceStatuses,
  );
  route(
    "PUT",
    "/properties/:propertyId/guest-rules",
    async (scope, request, reply) => {
      const requestId = readIdempotencyKey(request);
      if (
        !requestId ||
        !exactDataRecord(request.body, ["expectedRevision", "confirmed", "choices"])
      )
        return reply.status(400).send({ code: "invalid_guest_choices" });
      return reply.send(await options.store.save(scope, { ...request.body, requestId }));
    },
    choiceStatuses,
  );
  const terms = options.termsStore;
  const termsStatuses = {
    invalid_guest_terms: 400,
    guest_terms_denied: 403,
    guest_terms_stale: 409,
  };
  route(
    "GET",
    "/properties/:propertyId/guest-terms",
    async (scope, _request, reply) => reply.send(await terms.read(scope)),
    termsStatuses,
  );
  route(
    "PUT",
    "/properties/:propertyId/guest-terms",
    async (scope, request, reply) => {
      if (!exactDataRecord(request.body, ["termsText", "expectedTermsText"]))
        return reply.status(400).send({ code: "invalid_guest_terms" });
      return reply.send(
        await terms.save(scope, request.body.termsText, request.body.expectedTermsText),
      );
    },
    termsStatuses,
  );
}
