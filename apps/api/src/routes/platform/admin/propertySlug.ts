import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  PropertySlugChangeError,
  type PropertySlugChangeCommand,
} from "../../../domains/propertySlugChange.js";
import { enforceRoutePolicy } from "../../policy.js";

export type PlatformPropertySlugRoutesOptions = { command: PropertySlugChangeCommand };

const PLATFORM_RESOURCE = {
  product: "platform",
  resourceType: "platform",
  resourceId: "vayada",
  allowedRelationships: ["operator"],
} as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A Vayada operator changes a hotel's booking page address (VAY-2295). The preview writes
 * nothing; the change must name the preview's planSha256, the plan the operator approved. */
export async function registerPlatformPropertySlugRoutes(
  app: FastifyInstance,
  options: PlatformPropertySlugRoutesOptions,
): Promise<void> {
  app.addHook("onClose", async () => options.command.close());

  app.post("/properties/:propertyId/slug/preview", async (request, reply) => {
    const input = readInput(request, reply);
    if (!input) return reply;
    try {
      return await options.command.preview(input);
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post("/properties/:propertyId/slug", async (request, reply) => {
    const input = readInput(request, reply);
    if (!input) return reply;
    const body = record(request.body);
    const reason = typeof body?.["reason"] === "string" ? body["reason"].trim() : "";
    const expectedPlanSha256 = body?.["expectedPlanSha256"];
    if (
      !reason ||
      reason.length > 500 ||
      typeof expectedPlanSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(expectedPlanSha256)
    ) {
      return reply.status(400).send({
        code: "invalid_property_slug_change",
        detail: "Provide a reason and the planSha256 of the preview you approved.",
      });
    }
    try {
      const result = await options.command.apply({ ...input, reason, expectedPlanSha256 });
      if (result.publication.status === "failed") {
        request.log.warn(
          { propertyId: input.propertyId, code: result.publication.code },
          "Booking page address changed; the republish failed",
        );
      }
      return result;
    } catch (error) {
      return sendError(error, reply);
    }
  });
}

function readInput(request: FastifyRequest, reply: FastifyReply) {
  const context = enforceRoutePolicy(request, {
    permission: "platform.property.status.manage",
    resource: PLATFORM_RESOURCE,
  });
  const propertyId = record(request.params)?.["propertyId"];
  const slug = record(request.body)?.["slug"];
  if (typeof propertyId !== "string" || !UUID_PATTERN.test(propertyId)) {
    reply.status(400).send({ code: "invalid_property_id", detail: "Property ID must be a UUID." });
    return null;
  }
  if (typeof slug !== "string") {
    reply.status(400).send({ code: "invalid_slug", detail: "Provide the new address as slug." });
    return null;
  }
  return {
    propertyId: propertyId.toLowerCase(),
    slug,
    audit: {
      actorUserId: context.actor.internalUserId,
      organizationId: context.selectedOrganization.organizationId,
      requestId: context.audit.requestId,
      correlationId: context.audit.correlationId ?? context.audit.requestId,
      requestedAt: context.audit.receivedAt,
    },
  };
}

function sendError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof PropertySlugChangeError)) throw error;
  const statusCode =
    error.code === "invalid_slug"
      ? 400
      : error.code === "invalid_platform_scope"
        ? 403
        : error.code === "property_not_found"
          ? 404
          : 409;
  return reply.status(statusCode).send({ code: error.code });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
