import { randomUUID } from "node:crypto";
import pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import type {
  ReviewReplyProvider,
  ReviewReplyResult,
} from "../integrations/channexReviewReplies.js";

export type ReviewReplyStatus = ReviewReplyResult & { draft?: string };
export type ReviewReplyCommands = {
  check(context: RequestContext, propertyId: string, reviewId: string): Promise<ReviewReplyStatus>;
  submit(
    context: RequestContext,
    propertyId: string,
    reviewId: string,
    text: string,
  ): Promise<ReviewReplyStatus>;
  close(): Promise<void>;
};
type Row = {
  id: string;
  reviewId: string;
  externalPropertyId: string | null;
  replyBody: string | null;
  state: "accepted" | "failed" | "uncertain" | null;
  body: string | null;
  attemptId: string | null;
};

export function createPgReviewReplyCommands(config: {
  connectionString: string;
  provider?: ReviewReplyProvider;
}): ReviewReplyCommands {
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 5 });
  async function read(
    propertyId: string,
    reviewId: string,
    client: pg.Pool | pg.PoolClient = pool,
    lock = false,
  ) {
    if (lock)
      await client.query(
        "SELECT id FROM pms.channel_reviews WHERE property_id = $1 AND provider_review_id = $2 AND provider = 'channex' FOR UPDATE",
        [propertyId, reviewId],
      );
    const result = await client.query<Row>(
      `SELECT r.id, r.provider_review_id AS "reviewId", r.reply_body AS "replyBody",
         c.external_property_id AS "externalPropertyId", s.state, s.body, s.attempt_id AS "attemptId"
       FROM pms.channel_reviews r
       LEFT JOIN pms.channel_connections c ON c.property_id = r.property_id AND c.provider = 'channex'
         AND c.connection_status IN ('connected', 'degraded')
       LEFT JOIN pms.review_reply_submissions s ON s.review_id = r.id
       WHERE r.property_id = $1 AND r.provider_review_id = $2 AND r.provider = 'channex'
       `,
      [propertyId, reviewId],
    );
    return result.rows.length === 1 ? result.rows[0] : undefined;
  }
  async function finish(
    context: RequestContext,
    propertyId: string,
    row: Row,
    result: ReviewReplyResult,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM pms.channel_reviews WHERE id = $1 FOR UPDATE", [row.id]);
      const updated = await client.query(
        `UPDATE pms.review_reply_submissions SET state = $3, reason = $4, updated_at = now()
         WHERE review_id = $1 AND attempt_id = $2 AND state <> 'accepted' RETURNING review_id`,
        [row.id, row.attemptId, result.state, result.reason ?? null],
      );
      if (updated.rowCount) {
        if (result.replyBody)
          await client.query(
            `UPDATE pms.channel_reviews SET reply_body = $2, updated_at = now() WHERE id = $1`,
            [row.id, result.replyBody],
          );
        await audit(client, context, propertyId, row.reviewId, result.state);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function check(
    context: RequestContext,
    propertyId: string,
    reviewId: string,
  ): Promise<ReviewReplyStatus> {
    const row = await read(propertyId, reviewId);
    if (!row) return { state: "unavailable", reason: "review_unavailable" };
    if (row.replyBody || row.state === "accepted") {
      const result = {
        state: "accepted" as const,
        draft: row.body ?? undefined,
        ...(row.replyBody ? { replyBody: row.replyBody } : {}),
      };
      if (row.state && row.state !== "accepted") await finish(context, propertyId, row, result);
      return result;
    }
    if (!config.provider || !row.externalPropertyId)
      return {
        state: "unavailable",
        reason: "connection_unavailable",
        draft: row.body ?? undefined,
      };
    const result = await config.provider.check({
      reviewId,
      externalPropertyId: row.externalPropertyId,
    });
    if (result.state === "accepted" && row.state) await finish(context, propertyId, row, result);
    if (result.state !== "accepted" && row.state === "uncertain")
      return { state: "uncertain", reason: "confirmation_pending", draft: row.body ?? undefined };
    return { ...result, draft: row.body ?? undefined };
  }
  return {
    check,
    async submit(context, propertyId, reviewId, text) {
      const preflight = await check(context, propertyId, reviewId);
      if (preflight.state !== "ready") return preflight;
      const client = await pool.connect();
      let row: Row | undefined;
      try {
        await client.query("BEGIN");
        row = await read(propertyId, reviewId, client, true);
        if (!row || !row.externalPropertyId) {
          await client.query("ROLLBACK");
          return { state: "unavailable", reason: "connection_unavailable" };
        }
        if (row.replyBody || (row.state && row.state !== "failed")) {
          await client.query("ROLLBACK");
          return { state: row.replyBody ? "accepted" : row.state!, draft: row.body ?? undefined };
        }
        row.attemptId = randomUUID();
        await client.query(
          `INSERT INTO pms.review_reply_submissions (review_id, attempt_id, actor_user_id, body, state)
           VALUES ($1, $2, $3, $4, 'uncertain') ON CONFLICT (review_id) DO UPDATE
           SET attempt_id = $2, actor_user_id = $3, body = $4, state = 'uncertain', reason = NULL, updated_at = now()`,
          [row.id, row.attemptId, context.actor.internalUserId, text],
        );
        await audit(client, context, propertyId, reviewId, "submitting");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      // Persist the reservation before calling the provider. A crash cannot permit a blind retry.
      const result = await config.provider!.send(
        { reviewId, externalPropertyId: row.externalPropertyId! },
        text,
      );
      await finish(context, propertyId, row, result);
      return { ...result, draft: text };
    },
    close: () => pool.end(),
  };
}

async function audit(
  client: pg.PoolClient,
  context: RequestContext,
  propertyId: string,
  reviewId: string,
  state: string,
) {
  await client.query(
    `INSERT INTO platform.product_audit_events
      (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id, correlation_id, redacted_payload)
     VALUES ($1, 'pms', 'pms.review.reply', now(), 'property', $2, 'user', $3,
       'pms', 'channel_review', $4, $5, jsonb_build_object('outcome', $6::text))`,
    [
      randomUUID(),
      propertyId,
      context.actor.internalUserId,
      reviewId,
      context.audit.correlationId ?? context.audit.requestId,
      state,
    ],
  );
}
