import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { requireActiveEntitlement, requireResourceAccess } from "@vayada/backend-authorization";
import {
  MARKETPLACE_AFFILIATE_OFFER_TERMS_VERSION,
  parseMarketplaceAffiliateOfferTerms,
} from "@vayada/domain-marketplace";
import type pg from "pg";

type SaveDraft = {
  context: RequestContext;
  propertyId: string;
  offerId: string;
  expectedRevision: number;
  idempotencyKey: string;
  terms: unknown;
};
type Result =
  | { ok: true; draftId: string; revision: number; replayed: boolean }
  | {
      ok: false;
      code: "invalid_request" | "scope_unavailable" | "revision_conflict" | "idempotency_conflict";
    };
const operation = "marketplace.affiliate_offer_draft.save";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Internal application operation. Each invocation requires a freshly resolved auth context. */
export async function saveMarketplaceAffiliateDraft(
  pool: pg.Pool,
  input: SaveDraft,
): Promise<Result> {
  const { context, propertyId, offerId, expectedRevision } = input;
  const terms = parseMarketplaceAffiliateOfferTerms(input.terms);
  if (
    !terms.ok ||
    !uuid.test(propertyId) ||
    !uuid.test(offerId) ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision >= 2147483647 ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200
  )
    return { ok: false, code: "invalid_request" };
  if (
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.kind !== "hotel_group" ||
    context.selectedOrganization.status !== "active"
  )
    return { ok: false, code: "scope_unavailable" };
  for (const [resourceType, resourceId] of [
    ["hotel_profile", propertyId],
    ["marketplace_offer", offerId],
  ] as const)
    requireResourceAccess(context, {
      permission: "marketplace.profile.manage",
      resource: {
        product: "marketplace",
        resourceType,
        resourceId,
        allowedRelationships: ["owner", "operator"],
      },
    });
  requireActiveEntitlement(context, {
    product: "marketplace",
    key: "marketplace-hotel-profile",
    resource: { product: "marketplace", resourceType: "hotel_profile", resourceId: propertyId },
  });
  const organizationId = context.selectedOrganization.organizationId;
  const actorId = context.actor.internalUserId;
  const key = hash(JSON.stringify([offerId, input.idempotencyKey]));
  const fingerprint = hash(
    JSON.stringify([organizationId, actorId, offerId, expectedRevision, terms.terms]),
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const offer = await client.query(
      `SELECT id FROM marketplace.marketplace_offers
       WHERE id=$1 AND property_id=$2 AND organization_id=$3
         AND offer_status NOT IN ('archived', 'suspended') FOR UPDATE`,
      [offerId, propertyId, organizationId],
    );
    if (!offer.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, code: "scope_unavailable" };
    }
    const prior = await client.query(
      `SELECT request_fingerprint_hash, status, response_resource_id
       FROM platform.idempotency_keys WHERE operation_scope='marketplace' AND operation=$1
       AND tenant_scope='property' AND property_id=$2 AND key_hash=$3 FOR UPDATE`,
      [operation, propertyId, key],
    );
    if (prior.rows[0]) {
      const saved = prior.rows[0];
      const draft = await client.query(
        `SELECT id, revision FROM marketplace.affiliate_offer_terms_drafts
         WHERE id::text=$1 AND offer_id=$2 AND property_id=$3 AND organization_id=$4 AND actor_user_id=$5`,
        [saved.response_resource_id, offerId, propertyId, organizationId, actorId],
      );
      await client.query("ROLLBACK");
      return saved.status === "completed" &&
        saved.request_fingerprint_hash === fingerprint &&
        draft.rows[0]
        ? { ok: true, draftId: draft.rows[0].id, revision: draft.rows[0].revision, replayed: true }
        : { ok: false, code: "idempotency_conflict" };
    }
    const latest = await client.query(
      "SELECT COALESCE(MAX(revision),0) AS revision FROM marketplace.affiliate_offer_terms_drafts WHERE offer_id=$1",
      [offerId],
    );
    if (latest.rows[0].revision !== expectedRevision) {
      await client.query("ROLLBACK");
      return { ok: false, code: "revision_conflict" };
    }
    const draftId = randomUUID();
    const revision = expectedRevision + 1;
    await client.query(
      `INSERT INTO marketplace.affiliate_offer_terms_drafts
       (id,offer_id,property_id,organization_id,revision,contract_version,booking_destination_id,
        finance_policy_version_id,attribution_window_days,actor_user_id,request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        draftId,
        offerId,
        propertyId,
        organizationId,
        revision,
        MARKETPLACE_AFFILIATE_OFFER_TERMS_VERSION,
        terms.terms.bookingDestinationId,
        terms.terms.financePolicyVersionId,
        terms.terms.attributionWindowDays,
        actorId,
        context.audit.requestId,
      ],
    );
    await client.query(
      `INSERT INTO platform.idempotency_keys
       (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,
        response_status_code,response_resource_product,response_resource_type,response_resource_id,
        correlation_id,completed_at,expires_at)
       VALUES ('marketplace',$1,$2,$3,'completed','property',$4,201,'marketplace',
        'affiliate_offer_terms_draft',$5,$6,now(),now()+interval '90 days')`,
      [
        operation,
        key,
        fingerprint,
        propertyId,
        draftId,
        context.audit.correlationId ?? context.audit.requestId,
      ],
    );
    await client.query("COMMIT");
    return { ok: true, draftId, revision, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
