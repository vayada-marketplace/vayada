import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { requireActiveEntitlement, requireResourceAccess } from "@vayada/backend-authorization";
import { parseFinanceAffiliatePercentagePolicy } from "@vayada/domain-finance";
import type pg from "pg";

type Save = {
  context: RequestContext;
  propertyId: string;
  idempotencyKey: string;
  policy: unknown;
};
type Result =
  | { ok: true; policyVersionId: string; replayed: boolean }
  | { ok: false; code: "invalid_request" | "scope_unavailable" | "idempotency_conflict" };
const operation = "finance.affiliate_percentage_policy.save";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Internal Marketplace entry point; callers must resolve a fresh RequestContext for every call. */
export async function saveFinanceAffiliatePercentagePolicyFromMarketplace(
  pool: pg.Pool,
  input: Save,
): Promise<Result> {
  const { context } = input;
  const policy = parseFinanceAffiliatePercentagePolicy(input.policy);
  if (
    !policy ||
    !uuid.test(input.propertyId) ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200 ||
    !context.audit.requestId.trim() ||
    context.audit.requestId.length > 200
  )
    return { ok: false, code: "invalid_request" };
  const propertyId = input.propertyId.toLowerCase();
  if (
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.kind !== "hotel_group" ||
    context.selectedOrganization.status !== "active"
  )
    return { ok: false, code: "scope_unavailable" };
  const resource = {
    product: "marketplace" as const,
    resourceType: "hotel_profile" as const,
    resourceId: propertyId,
  };
  requireResourceAccess(context, {
    permission: "marketplace.profile.manage",
    resource: { ...resource, allowedRelationships: ["owner", "operator"] },
  });
  requireActiveEntitlement(context, {
    product: "marketplace",
    key: "marketplace-hotel-profile",
    resource,
  });
  const organizationId = context.selectedOrganization.organizationId;
  const actorId = context.actor.internalUserId;
  const key = hash(input.idempotencyKey);
  const fingerprint = hash(JSON.stringify([organizationId, actorId, propertyId, policy]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scope = await client.query(
      `SELECT property.id FROM hotel_catalog.properties property
       JOIN identity.organization_resource_links link ON link.resource_id=property.id::text
       WHERE property.id=$1 AND property.profile_status <> 'disabled' AND link.organization_id=$2
         AND link.product='marketplace' AND link.resource_type='hotel_profile'
         AND link.status='active' AND link.relationship IN ('owner','operator')
       ORDER BY link.id FOR UPDATE OF property, link`,
      [propertyId, organizationId],
    );
    if (!scope.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, code: "scope_unavailable" };
    }
    const prior = await client.query(
      `SELECT keys.status, keys.request_fingerprint_hash, policy.id
       FROM platform.idempotency_keys keys
       LEFT JOIN finance.affiliate_percentage_policy_versions policy
         ON policy.id::text=keys.response_resource_id AND policy.property_id=$2
         AND policy.created_by_user_id=$4 AND policy.created_by_organization_id=$5
       WHERE keys.operation_scope='finance' AND keys.operation=$1
         AND keys.tenant_scope='property' AND keys.property_id=$2 AND keys.key_hash=$3`,
      [operation, propertyId, key, actorId, organizationId],
    );
    if (prior.rows[0]) {
      await client.query("ROLLBACK");
      const saved = prior.rows[0];
      return saved.status === "completed" &&
        saved.request_fingerprint_hash === fingerprint &&
        saved.id
        ? { ok: true, policyVersionId: saved.id, replayed: true }
        : { ok: false, code: "idempotency_conflict" };
    }
    const policyVersionId = randomUUID();
    await client.query(
      `INSERT INTO finance.affiliate_percentage_policy_versions
       (id,property_id,contract_version,model,revenue_basis,eligibility,rate_basis_points,
        created_by_user_id,created_by_organization_id,request_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        policyVersionId,
        propertyId,
        policy.contractVersion,
        policy.model,
        policy.revenueBasis,
        policy.eligibility,
        policy.rateBasisPoints,
        actorId,
        organizationId,
        context.audit.requestId,
      ],
    );
    await client.query(
      `INSERT INTO platform.idempotency_keys
       (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,
        response_status_code,response_resource_product,response_resource_type,response_resource_id,
        correlation_id,completed_at,expires_at)
       VALUES('finance',$1,$2,$3,'completed','property',$4,201,'finance',
        'affiliate_percentage_policy_version',$5,$6,now(),now()+interval '90 days')`,
      [
        operation,
        key,
        fingerprint,
        propertyId,
        policyVersionId,
        context.audit.correlationId ?? context.audit.requestId,
      ],
    );
    await client.query("COMMIT");
    return { ok: true, policyVersionId, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
