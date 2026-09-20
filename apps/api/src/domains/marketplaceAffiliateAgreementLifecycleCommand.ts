import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import { requirePropertyAccess, requireResourceAccess } from "@vayada/backend-authorization";
import { readMarketplaceAffiliateAgreementLifecycle } from "./marketplaceAffiliateAgreementLifecycle.js";

type Action = "pause" | "resume" | "end";
type Input = {
  context: RequestContext;
  agreementId: string;
  action: Action;
  reason: string;
  expectedRevision: number;
  idempotencyKey: string;
};
type Result =
  | { ok: true; eventId: string; revision: number; effectiveAt: string; replayed: boolean }
  | { ok: false; code: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const operation = "marketplace.affiliate_agreement.lifecycle";

/** Internal command only. This changes agreement history, never collaboration history. */
export async function changeMarketplaceAffiliateAgreementLifecycle(
  pool: pg.Pool,
  input: Input,
): Promise<Result> {
  if (
    typeof input.agreementId !== "string" ||
    !uuid.test(input.agreementId) ||
    !["pause", "resume", "end"].includes(input.action) ||
    typeof input.reason !== "string" ||
    input.reason.trim() !== input.reason ||
    !input.reason ||
    input.reason.length > 500 ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision >= 2147483647 ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200 ||
    !input.context.audit.requestId.trim() ||
    input.context.audit.requestId.length > 200
  )
    return { ok: false, code: "invalid_request" };

  const agreementId = input.agreementId.toLowerCase();
  const { context, action, reason, expectedRevision } = input;
  const hotel = context.selectedOrganization.kind === "hotel_group";
  const creator = context.selectedOrganization.kind === "creator_workspace";
  const actorId = context.actor.internalUserId;
  const organizationId = context.selectedOrganization.organizationId;
  if (
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.status !== "active" ||
    (!hotel && !creator)
  )
    return { ok: false, code: "scope_unavailable" };

  const client = await pool.connect();
  const fail = async (code: string): Promise<Result> => {
    await client.query("ROLLBACK");
    return { ok: false, code };
  };
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const target = (
      await client.query(
        `SELECT g.property_id,g.offer_id,g.hotel_organization_id,g.creator_profile_id,
          g.creator_organization_id,c.owner_user_id,c.profile_status
         FROM marketplace.affiliate_agreements g
         JOIN marketplace.affiliate_agreement_activations a ON a.agreement_id=g.id
         JOIN marketplace.creator_profiles c ON c.id=g.creator_profile_id
           AND c.organization_id=g.creator_organization_id
         WHERE g.id=$1 FOR UPDATE OF g,a,c`,
        [agreementId],
      )
    ).rows[0];
    if (
      !target ||
      (hotel
        ? target.hotel_organization_id !== organizationId
        : target.creator_organization_id !== organizationId ||
          target.owner_user_id !== actorId ||
          target.profile_status !== "active")
    )
      return await fail("scope_unavailable");

    const resource = {
      product: "marketplace" as const,
      resourceType: hotel ? ("hotel_profile" as const) : ("creator_profile" as const),
      resourceId: hotel ? target.property_id : target.creator_profile_id,
    };
    requireResourceAccess(context, {
      permission: "marketplace.collaboration.write",
      resource: { ...resource, allowedRelationships: hotel ? ["owner", "operator"] : ["owner"] },
    });
    if (hotel) {
      await requirePropertyAccess(
        context,
        { findMembershipPropertyScope: async () => null },
        {
          propertyId: target.property_id,
          targetResource: { product: "marketplace", resourceType: "hotel_profile" },
          allowedRelationships: ["owner", "operator"],
        },
      );
      requireResourceAccess(context, {
        permission: "marketplace.collaboration.write",
        resource: {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: target.offer_id,
          allowedRelationships: ["owner", "operator"],
        },
      });
    }
    const link = await client.query(
      `SELECT id FROM identity.organization_resource_links
       WHERE organization_id=$1 AND product='marketplace' AND status='active'
         AND resource_type=$2 AND resource_id=$3 AND relationship=ANY($4::text[])
       FOR SHARE`,
      [
        organizationId,
        hotel ? "hotel_profile" : "creator_profile",
        hotel ? target.property_id : target.creator_profile_id,
        hotel ? ["owner", "operator"] : ["owner"],
      ],
    );
    if (!link.rowCount) return await fail("scope_unavailable");
    if (hotel) {
      const offerLink = await client.query(
        `SELECT id FROM identity.organization_resource_links
         WHERE organization_id=$1 AND product='marketplace' AND status='active'
           AND resource_type='marketplace_offer' AND resource_id=$2
           AND relationship IN ('owner','operator') FOR SHARE`,
        [organizationId, target.offer_id],
      );
      if (!offerLink.rowCount) return await fail("scope_unavailable");
    }

    const key = hash(JSON.stringify([agreementId, input.idempotencyKey]));
    const fingerprint = hash(
      JSON.stringify([agreementId, organizationId, actorId, action, reason, expectedRevision]),
    );
    const prior = (
      await client.query(
        `SELECT k.status,k.request_fingerprint_hash,e.id,e.revision,e.effective_at
         FROM platform.idempotency_keys k
         LEFT JOIN marketplace.affiliate_agreement_lifecycle_events e
           ON e.id::text=k.response_resource_id AND e.agreement_id=$4
           AND e.actor_user_id=$5 AND e.actor_organization_id=$6 AND e.action=$7
         WHERE k.operation_scope='marketplace' AND k.operation=$1
           AND k.tenant_scope='property' AND k.property_id=$2 AND k.key_hash=$3`,
        [operation, target.property_id, key, agreementId, actorId, organizationId, action],
      )
    ).rows[0];
    if (prior) {
      await client.query("ROLLBACK");
      return prior.status === "completed" &&
        prior.request_fingerprint_hash === fingerprint &&
        prior.id
        ? {
            ok: true,
            eventId: prior.id,
            revision: prior.revision,
            effectiveAt: prior.effective_at.toISOString(),
            replayed: true,
          }
        : { ok: false, code: "idempotency_conflict" };
    }

    const lifecycle = await readMarketplaceAffiliateAgreementLifecycle(client, agreementId);
    if (lifecycle.status === "unavailable" || lifecycle.status === "invalid_history")
      return await fail("history_unavailable");
    if (lifecycle.revision !== expectedRevision) return await fail("revision_conflict");
    const side = hotel ? "hotel" : "creator";
    if (
      lifecycle.status === "ended" ||
      (action === "pause" && lifecycle.pausedBy.includes(side)) ||
      (action === "resume" && !lifecycle.pausedBy.includes(side))
    )
      return await fail("transition_unavailable");

    const eventId = randomUUID();
    const event = (
      await client.query(
        `INSERT INTO marketplace.affiliate_agreement_lifecycle_events
         (id,agreement_id,revision,action,actor_side,actor_user_id,
          actor_organization_id,reason,request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING effective_at`,
        [
          eventId,
          agreementId,
          expectedRevision + 1,
          action,
          side,
          actorId,
          organizationId,
          reason,
          context.audit.requestId,
        ],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO platform.idempotency_keys
       (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,
        response_status_code,response_resource_product,response_resource_type,response_resource_id,
        correlation_id,completed_at,expires_at)
       VALUES ('marketplace',$1,$2,$3,'completed','property',$4,201,'marketplace',
         'affiliate_agreement_lifecycle_event',$5,$6,now(),now()+interval '90 days')`,
      [
        operation,
        key,
        fingerprint,
        target.property_id,
        eventId,
        context.audit.correlationId ?? context.audit.requestId,
      ],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      eventId,
      revision: expectedRevision + 1,
      effectiveAt: event.effective_at.toISOString(),
      replayed: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
