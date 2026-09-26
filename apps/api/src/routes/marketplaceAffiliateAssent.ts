import type { FastifyInstance } from "fastify";
import {
  validAffiliateCollaborationKey,
  type AffiliateAssentRepository,
} from "../domains/marketplaceAffiliateAssentRepository.js";
import { isPostgresUnavailableError } from "../platform/postgresRuntime.js";
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
  app.post<{ Params: { collaborationId: string }; Body: unknown }>(
    "/collaborations/:collaborationId/affiliate-assent",
    async (request, reply) => {
      const { collaborationId } = request.params;
      const idempotencyKey = readIdempotencyKey(request);
      if (
        !validAffiliateCollaborationKey(collaborationId) ||
        request.body !== undefined ||
        !idempotencyKey
      )
        return reply.code(422).send({ ok: false, code: "invalid_request" });
      const context = enforceRoutePolicy(request, {
        permission: "marketplace.collaboration.write",
      });
      try {
        const result = await options.repository.recordForCollaboration(
          context,
          collaborationId,
          idempotencyKey,
        );
        if (result.ok) return reply.code(result.replayed ? 200 : 201).send(result);
        return reply
          .code(
            result.code === "invalid_request"
              ? 422
              : result.code === "scope_unavailable" || result.code === "terms_unavailable"
                ? 404
                : 409,
          )
          .send(result);
      } catch (error) {
        if (
          isPostgresUnavailableError(error) ||
          (typeof error === "object" && error !== null && "statusCode" in error)
        )
          throw error;
        request.log.error({ err: error }, "Collaboration affiliate assent command failed");
        return reply.code(500).send({ ok: false, code: "write_unavailable" });
      }
    },
  );
  app.post<{ Params: { collaborationId: string }; Body: unknown }>(
    "/collaborations/:collaborationId/affiliate-lifecycle",
    async (request, reply) => {
      const { collaborationId } = request.params;
      const idempotencyKey = readIdempotencyKey(request);
      const body = readLifecycleBody(request.body);
      if (!validAffiliateCollaborationKey(collaborationId) || !idempotencyKey || !body)
        return reply.code(422).send({ ok: false, code: "invalid_request" });
      const context = enforceRoutePolicy(request, {
        permission: "marketplace.collaboration.write",
      });
      try {
        const result = await options.repository.changeLifecycleForCollaboration(
          context,
          collaborationId,
          {
            ...body,
            idempotencyKey,
          },
        );
        if (result.ok) return reply.code(result.replayed ? 200 : 201).send(result);
        return reply
          .code(
            result.code === "invalid_request"
              ? 422
              : result.code === "scope_unavailable"
                ? 404
                : 409,
          )
          .send(result);
      } catch (error) {
        if (
          isPostgresUnavailableError(error) ||
          (typeof error === "object" && error !== null && "statusCode" in error)
        )
          throw error;
        request.log.error({ err: error }, "Collaboration affiliate lifecycle command failed");
        return reply.code(500).send({ ok: false, code: "write_unavailable" });
      }
    },
  );
}

function readLifecycleBody(body: unknown) {
  if (
    typeof body !== "object" ||
    body === null ||
    Object.keys(body).length !== 3 ||
    !("action" in body) ||
    !("reason" in body) ||
    !("expectedRevision" in body) ||
    !["pause", "resume", "end"].includes(String(body.action)) ||
    typeof body.reason !== "string" ||
    body.reason.trim() !== body.reason ||
    !body.reason ||
    body.reason.length > 500 ||
    !Number.isInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0
  )
    return null;
  return {
    action: body.action as "pause" | "resume" | "end",
    reason: body.reason,
    expectedRevision: Number(body.expectedRevision),
  };
}

function readIdempotencyKey(request: Parameters<typeof enforceRoutePolicy>[0]): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const value = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof value !== "string") return null;
  const key = value.trim();
  return key.length >= 1 && key.length <= 200 ? key : null;
}
