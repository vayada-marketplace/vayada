import pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RequestContext } from "@vayada/backend-auth";
import type { ReviewReplyCommands, ReviewReplyStatus } from "../domains/pmsReviewReplies.js";
import { enforceRoutePolicy } from "./policy.js";

export type PmsReview = {
  reviewId: string;
  channel: string | null;
  guestDisplayName: string | null;
  rating: string | null;
  body: string;
  replyBody: string | null;
  reviewedAt: string | null;
  updatedAt: string;
  replySubmission?: ReviewReplyStatus | null;
};

export type PmsReviewRepository = {
  list(
    context: RequestContext,
    propertyId: string,
    filters: { channel?: string; minRating?: number; limit: number; offset: number },
  ): Promise<{ items: PmsReview[]; total: number }>;
  replies?: ReviewReplyCommands;
  close?(): Promise<void>;
};

export function createPgPmsReviewRepository(config: {
  connectionString: string;
  replies?: ReviewReplyCommands;
}): PmsReviewRepository {
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 5 });
  return {
    replies: config.replies,
    async list(_context, propertyId, filters) {
      const values: unknown[] = [propertyId];
      const where = ["property_id = $1"];
      if (filters.channel) {
        values.push(filters.channel);
        where.push(`channel = $${values.length}`);
      }
      if (filters.minRating !== undefined) {
        values.push(filters.minRating);
        where.push(`rating >= $${values.length}`);
      }
      const countValues = values.slice();
      const count = await pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM pms.channel_reviews WHERE ${where.join(" AND ")}`,
        countValues,
      );
      values.push(filters.limit, filters.offset);
      const result = await pool.query<PmsReview>(
        `SELECT provider_review_id AS "reviewId", channel,
           guest_display_name AS "guestDisplayName", rating::text, body,
           reply_body AS "replyBody", reviewed_at AS "reviewedAt",
           updated_at AS "updatedAt",
           (SELECT jsonb_build_object('state', s.state, 'draft', s.body, 'reason', s.reason)
            FROM pms.review_reply_submissions s WHERE s.review_id = pms.channel_reviews.id) AS "replySubmission"
         FROM pms.channel_reviews WHERE ${where.join(" AND ")}
         ORDER BY COALESCE(reviewed_at, created_at) DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      return {
        items: result.rows,
        total: Number(count.rows[0]?.total ?? 0),
      };
    },
    async close() {
      try {
        await config.replies?.close();
      } finally {
        await pool.end();
      }
    },
  };
}

export async function registerPmsReviewRoutes(
  app: FastifyInstance,
  options: { repository: PmsReviewRepository },
): Promise<void> {
  app.addHook("onClose", () => options.repository.close?.());
  app.get<{ Params: { propertyId: string; reviewId: string } }>(
    "/properties/:propertyId/reviews/:reviewId/reply",
    async (request) => {
      const { propertyId, reviewId } = request.params;
      const context = enforceReviewPolicy(request, propertyId, true);
      return (
        options.repository.replies?.check(context, propertyId, reviewId) ?? {
          state: "unavailable",
          reason: "connection_unavailable",
        }
      );
    },
  );
  app.post<{ Params: { propertyId: string; reviewId: string }; Body: { text?: unknown } }>(
    "/properties/:propertyId/reviews/:reviewId/reply",
    async (request, reply) => {
      const { propertyId, reviewId } = request.params;
      const context = enforceReviewPolicy(request, propertyId, true);
      const text = request.body?.text;
      // Application request bound; Channex does not publish channel-specific text limits.
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 10000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
      )
        return reply.status(400).send({ code: "invalid_reply" });
      return (
        options.repository.replies?.submit(context, propertyId, reviewId, text.trim()) ?? {
          state: "unavailable",
          reason: "connection_unavailable",
        }
      );
    },
  );
  app.get<{
    Params: { propertyId: string };
    Querystring: { channel?: string; minRating?: string; limit?: string; offset?: string };
  }>("/properties/:propertyId/reviews", async (request, reply) => {
    const { propertyId } = request.params;
    const context = enforceReviewPolicy(request, propertyId);
    const limit = boundedInteger(request.query.limit, 50, 1, 100);
    const offset = boundedInteger(request.query.offset, 0, 0, 100_000);
    const minRating = request.query.minRating
      ? Number.parseFloat(request.query.minRating)
      : undefined;
    if (minRating !== undefined && (!Number.isFinite(minRating) || minRating < 0)) {
      return reply.status(400).send({ code: "invalid_min_rating" });
    }
    const result = await options.repository.list(context, propertyId, {
      channel: request.query.channel?.trim() || undefined,
      minRating,
      limit,
      offset,
    });
    return { propertyId, items: result.items, pagination: { total: result.total, limit, offset } };
  });
}

function enforceReviewPolicy(
  request: FastifyRequest,
  propertyId: string,
  write = false,
): RequestContext {
  return enforceRoutePolicy(request, {
    permission: write ? "pms.operations.manage" : "pms.operations.read",
    entitlement: {
      product: "pms",
      key: "property-management",
      resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
    },
    resource: {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      allowedRelationships: ["owner", "operator", "front_desk"],
    },
  });
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
