import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  MarketplaceSubmissionError,
  type createPgMarketplaceSubmissionRepository,
  type MarketplaceSubmissionScope,
  type SubmitMarketplaceRequest,
} from "../domains/marketplaceSubmissionRepository.js";
import {
  authorizeRequest,
  commandAudit,
  readIdempotencyKey,
} from "./marketplaceHotelCollaborationPreferences.js";
export type MarketplaceSubmissionRoutesOptions = {
  repository: Pick<
    ReturnType<typeof createPgMarketplaceSubmissionRepository>,
    "submit" | "getReview"
  >;
};
export async function registerMarketplaceSubmissionRoutes(
  app: FastifyInstance,
  options: MarketplaceSubmissionRoutesOptions,
) {
  const scopes = new WeakMap<FastifyRequest, MarketplaceSubmissionScope>();
  const authorize = async (
    request: FastifyRequest,
    reply: Parameters<typeof authorizeRequest>[1],
  ) => {
    reply.header("Cache-Control", "no-store");
    const scope = authorizeRequest(request, reply);
    if (scope)
      scopes.set(request, {
        propertyId: scope.propertyId,
        organizationId: scope.context.selectedOrganization.organizationId,
        audit: commandAudit(scope.context),
      });
  };
  app.get(
    "/properties/:propertyId/submission-review",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = scopes.get(request);
      if (!scope) throw new Error("Submission authorization missing");
      const key = readIdempotencyKey(request);
      if (request.headers["idempotency-key"] !== undefined && !key)
        return reply.status(400).send({ code: "invalid_idempotency_key" });
      try {
        const result = await options.repository.getReview(scope, key ?? undefined);
        if (result.propertyId !== scope.propertyId)
          return reply.status(500).send({ code: "invalid_submission_result" });
        return reply.send(result);
      } catch (error) {
        if (error instanceof MarketplaceSubmissionError)
          return reply.status(error.status).send({ code: error.code });
        throw error;
      }
    },
  );
  app.post<{ Body: unknown }>(
    "/properties/:propertyId/submissions",
    {
      onRequest: authorize,
    },
    async (request, reply) => {
      const scope = scopes.get(request);
      if (!scope) throw new Error("Submission authorization missing");
      const key = readIdempotencyKey(request);
      if (!key) return reply.status(400).send({ code: "invalid_idempotency_key" });
      try {
        const body = parseBody(request.body);
        if (!body) return reply.status(400).send({ code: "invalid_submission_request" });
        const result = await options.repository.submit(scope, key, body);
        if (result.propertyId !== scope.propertyId)
          return reply.status(500).send({ code: "invalid_submission_result" });
        return reply.status(201).send(result);
      } catch (error) {
        if (error instanceof MarketplaceSubmissionError)
          return reply.status(error.status).send({ code: error.code });
        throw error;
      }
    },
  );
}

function parseBody(value: unknown): SubmitMarketplaceRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = [
    "expectedLatestSubmissionRevisionId",
    "expectedSourceManifestHash",
    "expectedReadinessHash",
  ];
  if (Object.keys(raw).length !== keys.length || !keys.every((key) => Object.hasOwn(raw, key)))
    return null;
  const revision = raw.expectedLatestSubmissionRevisionId;
  if (
    !(
      revision === null ||
      (typeof revision === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(revision))
    )
  )
    return null;
  for (const key of keys.slice(1))
    if (typeof raw[key] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw[key])) return null;
  return raw as SubmitMarketplaceRequest;
}
