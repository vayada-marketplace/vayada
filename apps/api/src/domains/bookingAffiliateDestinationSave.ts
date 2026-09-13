import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { requireActiveEntitlement, requireResourceAccess } from "@vayada/backend-authorization";
import { parseAffiliateBookingDestinationConfiguration } from "@vayada/domain-booking";
import type pg from "pg";

type Save = {
  context: RequestContext;
  propertyId: string;
  idempotencyKey: string;
  configuration: unknown;
};
type Result =
  | { ok: true; destinationVersionId: string; replayed: boolean }
  | { ok: false; code: "invalid_request" | "scope_unavailable" | "idempotency_conflict" };
const operation = "booking.affiliate_destination.save";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Internal Marketplace entry point; callers must resolve a fresh RequestContext for every call. */
export async function saveBookingAffiliateDestinationFromMarketplace(
  pool: pg.Pool,
  input: Save,
): Promise<Result> {
  const { context } = input;
  const configuration = parseAffiliateBookingDestinationConfiguration(input.configuration);
  if (
    !configuration ||
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
  const fingerprint = hash(JSON.stringify([organizationId, actorId, propertyId, configuration]));
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
      `SELECT keys.status, keys.request_fingerprint_hash, configuration.id
       FROM platform.idempotency_keys keys
       LEFT JOIN booking.affiliate_destination_versions configuration
         ON configuration.id::text=keys.response_resource_id AND configuration.property_id=$2
         AND configuration.created_by_user_id=$4 AND configuration.created_by_organization_id=$5
       WHERE keys.operation_scope='booking' AND keys.operation=$1
         AND keys.tenant_scope='property' AND keys.property_id=$2 AND keys.key_hash=$3`,
      [operation, propertyId, key, actorId, organizationId],
    );
    if (prior.rows[0]) {
      await client.query("ROLLBACK");
      const saved = prior.rows[0];
      return saved.status === "completed" &&
        saved.request_fingerprint_hash === fingerprint &&
        saved.id
        ? { ok: true, destinationVersionId: saved.id, replayed: true }
        : { ok: false, code: "idempotency_conflict" };
    }
    const destinationVersionId = randomUUID();
    await client.query(
      `INSERT INTO booking.affiliate_destination_versions
       (id,property_id,display_name,booking_url,created_by_user_id,created_by_organization_id,request_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        destinationVersionId,
        propertyId,
        configuration.displayName,
        configuration.bookingUrl,
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
       VALUES('booking',$1,$2,$3,'completed','property',$4,201,'booking',
        'affiliate_destination_version',$5,$6,now(),now()+interval '90 days')`,
      [
        operation,
        key,
        fingerprint,
        propertyId,
        destinationVersionId,
        context.audit.correlationId ?? context.audit.requestId,
      ],
    );
    await client.query("COMMIT");
    return { ok: true, destinationVersionId, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
