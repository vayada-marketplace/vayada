import type { FinancePlatformOnlineCardExecutionEvidenceRepository } from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply } from "fastify";

import { authorizePlatformFinance } from "./financePlatformAuthorization.js";

type PropertyParams = { propertyId: string };

export async function registerFinancePlatformOnlineCardExecutionEvidenceRoutes(
  app: FastifyInstance,
  options: { repository: Partial<FinancePlatformOnlineCardExecutionEvidenceRepository> },
): Promise<void> {
  // VAY-2205: a hotel's card payments for Vayada finance. Read only since VAY-2442 (Flamur,
  // 2026-11-03): card works as soon as the hotel's own settings are complete, so Vayada no
  // longer turns it on or off (the approval routes are gone).
  app.get<{ Params: PropertyParams }>(
    "/finance/platform/properties/:propertyId/online-card-execution-evidence",
    async (request, reply) => {
      const context = authorizePlatformFinance(request, reply, "read");
      if (!context) return reply;
      if (!options.repository.readOnlineCardExecutionState) return unavailable(reply);
      if (!uuid(request.params.propertyId)) return invalid(reply);
      const state = await options.repository.readOnlineCardExecutionState(
        request.params.propertyId.toLowerCase(),
      );
      return (
        state ??
        reply.code(404).send({
          statusCode: 404,
          code: "property_not_found",
          category: "not_found",
          message: "Property was not found.",
        })
      );
    },
  );
}

function unavailable(reply: FastifyReply) {
  return reply.code(501).send({
    statusCode: 501,
    code: "write_unavailable",
    category: "write_model",
    message: "Online-card execution evidence writes are not configured.",
  });
}

function invalid(reply: FastifyReply) {
  return reply.code(400).send({
    statusCode: 400,
    code: "invalid_body",
    category: "validation",
    message: "Online-card execution evidence is invalid.",
  });
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
