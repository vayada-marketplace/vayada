import type { FastifyInstance } from "fastify";
import {
  validAffiliateCollaborationKey,
  type AffiliateAssentRepository,
} from "../domains/marketplaceAffiliateAssentRepository.js";
import { enforceRoutePolicy } from "./policy.js";

export async function registerMarketplaceAffiliateAssentRoutes(
  app: FastifyInstance,
  options: { repository: AffiliateAssentRepository },
) {
  app.addHook("onClose", () => options.repository.close());
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.addHook("onRequest", async (request) => {
    const context = enforceRoutePolicy(request, { permission: "marketplace.collaboration.read" });
    if (
      context.actor.status !== "active" ||
      context.membership.status !== "active" ||
      context.selectedOrganization.status !== "active"
    )
      throw Object.assign(new Error("Active identity required"), { statusCode: 403 });
  });
  app.get<{ Params: { attemptId: string } }>(
    "/affiliate-attempts/:attemptId",
    async (request, reply) => {
      const { attemptId } = request.params;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId))
        return reply.code(422).send({ code: "invalid_request" });
      const context = enforceRoutePolicy(request, { permission: "marketplace.collaboration.read" });
      try {
        const result = await options.repository.read(context, attemptId.toLowerCase());
        return result ?? reply.code(404).send({ code: "scope_unavailable" });
      } catch (error) {
        request.log.error({ err: error }, "Affiliate assent read failed");
        return reply.code(500).send({ code: "read_unavailable" });
      }
    },
  );
  app.get<{ Params: { collaborationId: string } }>(
    "/collaborations/:collaborationId/affiliate-assent",
    async (request, reply) => {
      const { collaborationId } = request.params;
      if (!validAffiliateCollaborationKey(collaborationId))
        return reply.code(422).send({ code: "invalid_request" });
      const context = enforceRoutePolicy(request, { permission: "marketplace.collaboration.read" });
      try {
        const result = await options.repository.readForCollaboration(context, collaborationId);
        return result ?? reply.code(404).send({ code: "scope_unavailable" });
      } catch (error) {
        request.log.error({ err: error }, "Collaboration affiliate assent read failed");
        return reply.code(500).send({ code: "read_unavailable" });
      }
    },
  );
}
