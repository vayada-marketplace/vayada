import { randomUUID } from "node:crypto";
import pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import type {
  GuestReviewDraft,
  GuestReviewOpportunity,
  GuestReviewProvider,
  GuestReviewStatus,
} from "../integrations/channexGuestReviews.js";
export type GuestReviewCommands = ReturnType<typeof createPgGuestReviewCommands>;
type Receipt = GuestReviewOpportunity & { externalPropertyId: string; attemptId: string };
export function createPgGuestReviewCommands(config: {
  connectionString: string;
  provider?: GuestReviewProvider;
}) {
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 5 });
  async function connection(
    propertyId: string,
    client: pg.Pool | pg.PoolClient = pool,
    lock = false,
  ) {
    const result = await client.query<{ externalPropertyId: string }>(
      `SELECT external_property_id AS "externalPropertyId" FROM pms.channel_connections
       WHERE property_id = $1 AND provider = 'channex' AND connection_status IN ('connected', 'degraded')
       ${lock ? "FOR UPDATE" : ""}`,
      [propertyId],
    );
    return result.rows.length === 1 ? result.rows[0].externalPropertyId : undefined;
  }
  async function receipts(
    propertyId: string,
    client: pg.Pool | pg.PoolClient = pool,
    reviewId?: string,
  ) {
    const result = await client.query<Receipt>(
      `SELECT provider_review_id AS "reviewId", external_property_id AS "externalPropertyId",
        attempt_id AS "attemptId", state, reason, draft, guest_name AS "guestName", reservation_code AS "reservationCode"
       FROM pms.guest_review_submissions WHERE property_id = $1 ${reviewId ? "AND provider_review_id = $2" : ""}
       ORDER BY updated_at DESC`,
      reviewId ? [propertyId, reviewId] : [propertyId],
    );
    return result.rows;
  }
  function visible(row: Receipt): GuestReviewOpportunity {
    return {
      reviewId: row.reviewId,
      guestName: row.guestName,
      reservationCode: row.reservationCode,
      state: row.state,
      ...(row.reason ? { reason: row.reason } : {}),
      draft: row.draft,
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
      VALUES ($1, 'pms', 'pms.review.guest', now(), 'property', $2, 'user', $3,
       'pms', 'channex_guest_review', $4, $5, jsonb_build_object('outcome', $6::text))`,
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
  async function finish(
    context: RequestContext,
    propertyId: string,
    row: Receipt,
    result: GuestReviewStatus,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE pms.guest_review_submissions SET state = $4, reason = $5, updated_at = now()
        WHERE property_id = $1 AND provider_review_id = $2 AND attempt_id = $3 AND state <> 'accepted' RETURNING state`,
        [propertyId, row.reviewId, row.attemptId, result.state, result.reason ?? null],
      );
      if (updated.rowCount) await audit(client, context, propertyId, row.reviewId, result.state);
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
    expectedExternalPropertyId?: string,
  ): Promise<GuestReviewOpportunity> {
    const row = (await receipts(propertyId, pool, reviewId))[0];
    if (row?.state === "accepted") return visible(row);
    const externalPropertyId = await connection(propertyId);
    if (
      !externalPropertyId ||
      !config.provider ||
      (expectedExternalPropertyId && expectedExternalPropertyId !== externalPropertyId) ||
      (row && row.externalPropertyId !== externalPropertyId)
    )
      return {
        ...(row ? visible(row) : { reviewId, guestName: "", reservationCode: "" }),
        state: row?.state === "uncertain" ? "uncertain" : "unavailable",
        reason: "connection_unavailable",
      };
    const result = await config.provider.check({ reviewId, externalPropertyId });
    if (result.state === "accepted" && row) await finish(context, propertyId, row, result);
    if (row?.state === "uncertain" && result.state !== "accepted")
      return { ...visible(row), reason: "confirmation_pending" };
    return { ...result, ...(row?.draft ? { draft: row.draft } : {}) };
  }
  return {
    check,
    async list(_context: RequestContext, propertyId: string, page: number) {
      const stored = (await receipts(propertyId)).map(visible);
      const externalPropertyId = await connection(propertyId);
      if (!externalPropertyId || !config.provider)
        return { items: [], stored, more: false, unavailable: true };
      try {
        return {
          ...(await config.provider.list(externalPropertyId, page)),
          stored,
          unavailable: false,
        };
      } catch {
        return { items: [], stored, more: false, unavailable: true };
      }
    },
    async submit(
      context: RequestContext,
      propertyId: string,
      reviewId: string,
      draft: GuestReviewDraft,
    ): Promise<GuestReviewOpportunity> {
      const externalPropertyId = await connection(propertyId);
      const preflight = await check(context, propertyId, reviewId, externalPropertyId);
      if (preflight.state !== "ready" || !externalPropertyId) return preflight;
      const client = await pool.connect();
      const attemptId = randomUUID();
      try {
        await client.query("BEGIN");
        const current = await connection(propertyId, client, true);
        if (!current || current !== externalPropertyId) {
          await client.query("ROLLBACK");
          return { ...preflight, state: "unavailable", reason: "connection_unavailable" };
        }
        // The connection lock serializes reservation, then a fresh statement reads the receipt.
        const row = (await receipts(propertyId, client, reviewId))[0];
        if (row && row.state !== "failed") {
          await client.query("ROLLBACK");
          return visible(row);
        }
        await client.query(
          `INSERT INTO pms.guest_review_submissions
          (property_id, external_property_id, provider_review_id, attempt_id, actor_user_id, draft, guest_name, reservation_code, state)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'uncertain') ON CONFLICT (property_id, provider_review_id)
          DO UPDATE SET external_property_id = $2, attempt_id = $4, actor_user_id = $5, draft = $6,
            guest_name = $7, reservation_code = $8, state = 'uncertain', reason = NULL, updated_at = now()`,
          [
            propertyId,
            current,
            reviewId,
            attemptId,
            context.actor.internalUserId,
            draft,
            preflight.guestName,
            preflight.reservationCode,
          ],
        );
        await audit(client, context, propertyId, reviewId, "submitting");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const result = await config.provider!.send(
        { reviewId, externalPropertyId: externalPropertyId! },
        draft,
      );
      await finish(
        context,
        propertyId,
        { ...preflight, externalPropertyId: externalPropertyId!, attemptId },
        result,
      );
      return { ...preflight, ...result, draft };
    },
    close: () => pool.end(),
  };
}
