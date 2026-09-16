import { createHash } from "node:crypto";
import pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import {
  AuthorizationError,
  requireActiveEntitlement,
  requirePermission,
  requirePropertyAccess,
  requireResourceAccess,
} from "@vayada/backend-authorization";

export type AffiliateAssentRead = {
  participationId: string;
  attemptId: string;
  programId: string;
  propertyId: string;
  offerId: string;
  creatorProfileId: string;
  origin: "application" | "invitation";
  revision: number;
  assentState: "pending" | "matched";
  terms: { id: string; disclosure: string; disclosureHash: string };
  hotelApprovedAt: string | null;
  creatorAcceptedAt: string | null;
};
export type AffiliateAssentRepository = {
  read(context: RequestContext, attemptId: string): Promise<AffiliateAssentRead | null>;
  readForCollaboration(
    context: RequestContext,
    collaborationId: string,
  ): Promise<AffiliateAssentRead | null>;
  close(): Promise<void>;
};
export function createPgMarketplaceAffiliateAssentRepository(
  connectionString: string,
): AffiliateAssentRepository {
  const pool = new pg.Pool({ connectionString, max: 3 });
  return {
    read: (context, id) => readAffiliateAssent(pool, context, id),
    readForCollaboration: (context, id) => readCollaborationAffiliateAssent(pool, context, id),
    close: () => pool.end(),
  };
}

export async function readAffiliateAssent(
  pool: pg.Pool,
  context: RequestContext,
  attemptId: string,
): Promise<AffiliateAssentRead | null> {
  requirePermission(context, "marketplace.collaboration.read");
  const hotel = context.selectedOrganization.kind === "hotel_group";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId) ||
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.status !== "active" ||
    (!hotel && context.selectedOrganization.kind !== "creator_workspace")
  )
    return null;
  const result = await pool.query(
    `SELECT a.id,a.participation_id,a.program_id,a.origin,p.property_id,p.offer_id,
      m.creator_profile_id,t.id AS terms_id,t.disclosure,t.disclosure_hash,
      (SELECT recorded_at FROM marketplace.affiliate_assent_decisions
        WHERE attempt_id=a.id AND decision='hotel_approval') AS hotel_approved_at,
      (SELECT recorded_at FROM marketplace.affiliate_assent_decisions
        WHERE attempt_id=a.id AND decision='creator_acceptance') AS creator_accepted_at
    FROM marketplace.affiliate_participation_attempts a
    JOIN marketplace.affiliate_participations m ON m.id=a.participation_id
    JOIN marketplace.affiliate_programs p ON p.id=m.program_id
    JOIN marketplace.affiliate_published_terms t ON t.id=a.terms_id AND t.program_id=p.id
    JOIN marketplace.creator_profiles c ON c.id=m.creator_profile_id AND c.organization_id=m.creator_organization_id
    WHERE a.id=$1 AND (
      ($4 AND p.organization_id=$2) OR
      (NOT $4 AND m.creator_organization_id=$2 AND c.owner_user_id=$3)
    ) AND EXISTS (
      SELECT 1 FROM identity.organization_resource_links l WHERE l.organization_id=$2
        AND l.product='marketplace' AND l.status='active'
        AND l.resource_type=CASE WHEN $4 THEN 'hotel_profile' ELSE 'creator_profile' END
        AND l.resource_id=CASE WHEN $4 THEN p.property_id::text ELSE m.creator_profile_id::text END
        AND (l.relationship='owner' OR ($4 AND l.relationship='operator'))
    ) AND (NOT $4 OR EXISTS (
      SELECT 1 FROM identity.organization_resource_links l WHERE l.organization_id=$2
        AND l.product='marketplace' AND l.status='active' AND l.resource_type='marketplace_offer'
        AND l.resource_id=p.offer_id::text AND l.relationship IN ('owner','operator')
    ))`,
    [attemptId, context.selectedOrganization.organizationId, context.actor.internalUserId, hotel],
  );
  const row = result.rows[0];
  if (!row) return null;
  try {
    const resource = {
      product: "marketplace" as const,
      resourceType: hotel ? ("hotel_profile" as const) : ("creator_profile" as const),
      resourceId: hotel ? row.property_id : row.creator_profile_id,
    };
    requireResourceAccess(context, {
      permission: "marketplace.collaboration.read",
      resource: { ...resource, allowedRelationships: hotel ? ["owner", "operator"] : ["owner"] },
    });
    if (hotel) {
      requireActiveEntitlement(context, {
        product: "marketplace",
        key: "marketplace-hotel-profile",
        resource,
      });
      requireResourceAccess(context, {
        permission: "marketplace.collaboration.read",
        resource: {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: row.offer_id,
          allowedRelationships: ["owner", "operator"],
        },
      });
      await requirePropertyAccess(
        context,
        { findMembershipPropertyScope: async () => null },
        {
          propertyId: row.property_id,
          targetResource: { product: "marketplace", resourceType: "hotel_profile" },
          allowedRelationships: ["owner", "operator"],
        },
      );
    } else {
      const owned = context.linkedResources.filter(
        (r) =>
          r.product === "marketplace" &&
          r.resourceType === "creator_profile" &&
          r.relationship === "owner" &&
          r.status === "active",
      );
      if (owned.length !== 1 || owned[0]!.resourceId !== row.creator_profile_id) return null;
    }
  } catch (error) {
    if (error instanceof AuthorizationError) return null;
    throw error;
  }
  if (createHash("sha256").update(row.disclosure).digest("hex") !== row.disclosure_hash)
    throw new Error("Stored affiliate disclosure is invalid");
  const hotelApprovedAt = row.hotel_approved_at?.toISOString() ?? null;
  const creatorAcceptedAt = row.creator_accepted_at?.toISOString() ?? null;
  return {
    participationId: row.participation_id,
    attemptId: row.id,
    programId: row.program_id,
    propertyId: row.property_id,
    offerId: row.offer_id,
    creatorProfileId: row.creator_profile_id,
    origin: row.origin,
    revision: Number(!!hotelApprovedAt) + Number(!!creatorAcceptedAt),
    assentState: hotelApprovedAt && creatorAcceptedAt ? "matched" : "pending",
    terms: { id: row.terms_id, disclosure: row.disclosure, disclosureHash: row.disclosure_hash },
    hotelApprovedAt,
    creatorAcceptedAt,
  };
}

export function validAffiliateCollaborationKey(id: string): boolean {
  return id.length > 0 && id.length <= 100 && id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id);
}

export async function readCollaborationAffiliateAssent(
  pool: pg.Pool,
  context: RequestContext,
  collaborationId: string,
): Promise<AffiliateAssentRead | null> {
  requirePermission(context, "marketplace.collaboration.read");
  const hotel = context.selectedOrganization.kind === "hotel_group";
  if (
    !validAffiliateCollaborationKey(collaborationId) ||
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.status !== "active" ||
    (!hotel && context.selectedOrganization.kind !== "creator_workspace")
  )
    return null;
  const result = await pool.query<{ id: string }>(
    `WITH candidates AS (
      SELECT c.*, count(*) OVER () AS matches FROM marketplace.collaborations c
      WHERE c.source_collaboration_id=$1
        AND CASE WHEN $3 THEN c.hotel_organization_id ELSE c.creator_organization_id END=$2
    )
    SELECT a.id FROM candidates c
    JOIN marketplace.affiliate_programs p ON p.offer_id=c.offer_id
      AND p.property_id=c.property_id AND p.organization_id=c.hotel_organization_id
    JOIN marketplace.affiliate_participations m ON m.program_id=p.id
      AND m.creator_profile_id=c.creator_profile_id AND m.creator_organization_id=c.creator_organization_id
    JOIN marketplace.affiliate_participation_attempts a ON a.participation_id=m.id
    WHERE c.matches=1 ORDER BY a.attempt_number DESC LIMIT 1`,
    [collaborationId, context.selectedOrganization.organizationId, hotel],
  );
  // Reuse exact-version disclosure, persisted-resource and canonical property authorization.
  return result.rows[0] ? readAffiliateAssent(pool, context, result.rows[0].id) : null;
}
