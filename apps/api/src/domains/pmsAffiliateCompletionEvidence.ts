import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import { requireActiveEntitlement, requireResourceAccess } from "@vayada/backend-authorization";
import type { PmsAffiliateCompletionEvidence } from "@vayada/domain-pms";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** PMS-owned internal read. Resolve fresh context on each call; never exposed to creators.
 * No PMS subscription is required. This does not validate destination tracking or earn money. */
export async function readPmsAffiliateCompletionEvidence(
  database: Pick<pg.Pool, "query">,
  input: { context: RequestContext; propertyId: string; bookingId: string; stayItemId: string },
): Promise<PmsAffiliateCompletionEvidence> {
  const { context } = input;
  const unavailable = { status: "pending", reason: "scope_unavailable" } as const;
  if (
    ![input.propertyId, input.bookingId, input.stayItemId].every((id) => uuid.test(id)) ||
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.status !== "active" ||
    context.selectedOrganization.kind !== "hotel_group"
  )
    return unavailable;
  const propertyId = input.propertyId.toLowerCase();
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
  const result = await database.query(
    `
    SELECT a.id AS stay_item_id, a.assignment_status, b.lifecycle_status,
      c.id AS checkout_id, c.completed_at, c.completed_by_user_id,
      c.pending_flags, audit.id AS audit_id, audit.causation_id
    FROM pms.operational_booking_assignments a
    JOIN booking.guest_bookings b ON b.id=a.guest_booking_id AND b.property_id=a.property_id
    JOIN hotel_catalog.properties p ON p.id=a.property_id AND p.profile_status <> 'disabled'
    LEFT JOIN LATERAL (
      SELECT * FROM pms.booking_checkout_records record
      WHERE record.property_id=a.property_id AND record.guest_booking_id=a.guest_booking_id
        AND record.assignment_id=a.id
      ORDER BY record.completed_at DESC,record.id DESC LIMIT 1
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT event.id,event.causation_id FROM platform.product_audit_events event
      WHERE event.product='pms' AND event.action='pms.checkout.completed' AND event.action_version=1
        AND event.tenant_scope='property' AND event.property_id=a.property_id
        AND event.target_resource_product='pms' AND event.target_resource_type='booking_checkout_record'
        AND event.target_resource_id=c.id::text AND event.secondary_resource_product='booking'
        AND event.secondary_resource_type='guest_booking' AND event.secondary_resource_id=b.id::text
        AND event.actor_type='user' AND event.actor_user_id=c.completed_by_user_id
        AND event.occurred_at=c.completed_at
      ORDER BY event.id LIMIT 1
    ) audit ON true
    WHERE a.property_id=$1 AND a.guest_booking_id=$2 AND a.id=$3
      AND EXISTS (SELECT 1 FROM identity.organization_resource_links link
        WHERE link.organization_id=$4 AND link.product='marketplace' AND link.resource_type='hotel_profile'
          AND link.resource_id=a.property_id::text AND link.status='active' AND link.relationship IN ('owner','operator'))`,
    [propertyId, input.bookingId, input.stayItemId, context.selectedOrganization.organizationId],
  );
  const row = result.rows[0];
  if (!row) return unavailable;
  const recordedAt =
    row.completed_at instanceof Date ? row.completed_at : new Date(row.completed_at ?? NaN);
  if (
    row.assignment_status !== "checked_out" ||
    !["confirmed", "completed"].includes(row.lifecycle_status) ||
    !row.checkout_id ||
    !row.completed_by_user_id ||
    !row.audit_id ||
    !row.causation_id?.trim() ||
    !Number.isFinite(recordedAt.getTime()) ||
    recordedAt.getTime() > Date.now() ||
    !Array.isArray(row.pending_flags)
  )
    return { status: "pending", reason: "completion_unconfirmed" };
  return {
    status: "completed",
    propertyId,
    bookingId: input.bookingId.toLowerCase(),
    stayItemId: row.stay_item_id,
    source: "vayada_pms",
    assertion: "authenticated_hotel_checkout",
    sourceRecordId: row.checkout_id,
    auditEventId: row.audit_id,
    actorUserId: row.completed_by_user_id,
    causedByCommandId: row.causation_id,
    recordedAt: recordedAt.toISOString(),
    actualDepartureAt: null,
    hasPendingFlags: row.pending_flags.length > 0,
  };
}
