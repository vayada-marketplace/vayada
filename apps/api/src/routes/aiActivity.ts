import { requireAuthContext } from "@vayada/backend-auth";
import type { HttpErrorEnvelope } from "@vayada/backend-http";
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";

import type { AiActivityItem, AiActivityStore } from "../ai/actionLog/aiActivity.js";

/**
 * VAY-2508: `GET /api/ai/activity`, what AI did in the signed-in user's name (UI later). Everyone
 * sees their own AI actions; the account owner (`hotel_owner`) sees the whole account and may
 * filter by user. Self-scoped like the GDPR routes, so it checks the session itself: no
 * permission key fits "your own AI activity". An AI never reads this log: a delegated context
 * (`source = agent`) is refused here, and the route stays off the action registry (never-list:
 * AI-connection management).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type Query = { limit?: string; cursor?: string; propertyId?: string; userId?: string };

function sendError(
  reply: FastifyReply,
  statusCode: 403 | 422,
  code: string,
  message: string,
): FastifyReply {
  const body: HttpErrorEnvelope = {
    statusCode,
    code,
    category: statusCode === 403 ? "authorization" : "validation",
    message,
  };
  return reply.status(statusCode).send(body);
}

function encodeCursor(item: AiActivityItem): string {
  return Buffer.from(JSON.stringify([item.occurredAt, item.id])).toString("base64url");
}

function decodeCursor(cursor: string): { occurredAt: string; id: string } | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      !Number.isNaN(Date.parse(value[0])) &&
      typeof value[1] === "string" &&
      UUID.test(value[1])
    )
      return { occurredAt: value[0], id: value[1] };
  } catch {
    // fall through
  }
  return null;
}

export async function registerAiActivityRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { store: AiActivityStore },
): Promise<void> {
  app.get<{ Querystring: Query }>("/activity", async (request, reply) => {
    const context = requireAuthContext(request);
    if (context.audit.source === "agent")
      return sendError(reply, 403, "forbidden", "AI activity is not available to AI actions.");
    if (context.selectedOrganization.kind !== "hotel_group")
      return sendError(reply, 403, "forbidden", "AI activity belongs to a hotel account.");

    const query = request.query;
    const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
      return sendError(reply, 422, "invalid_query", `limit must be 1 to ${MAX_LIMIT}.`);
    if (query.propertyId !== undefined && !UUID.test(query.propertyId))
      return sendError(reply, 422, "invalid_query", "propertyId must be a UUID.");
    if (query.userId !== undefined && !UUID.test(query.userId))
      return sendError(reply, 422, "invalid_query", "userId must be a UUID.");
    const before = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (before === null) return sendError(reply, 422, "invalid_query", "cursor is not valid.");

    const self = context.actor.internalUserId;
    const owner = context.membership.roleKey === "hotel_owner";
    if (!owner && query.userId !== undefined && query.userId !== self)
      return sendError(
        reply,
        403,
        "forbidden",
        "Only the account owner sees other users' AI activity.",
      );

    const rows = await options.store.list({
      organizationId: context.selectedOrganization.organizationId,
      userId: owner ? query.userId : self,
      propertyId: query.propertyId,
      before,
      limit: limit + 1,
    });
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!) : null,
    };
  });
}
