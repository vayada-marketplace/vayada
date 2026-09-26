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
import { recordAffiliateAssent } from "./marketplaceAffiliateAssentCommand.js";
import { changeMarketplaceAffiliateAgreementLifecycle } from "./marketplaceAffiliateAgreementLifecycleCommand.js";
import { readMarketplaceAffiliateAgreementLifecycle } from "./marketplaceAffiliateAgreementLifecycle.js";

export type AffiliateAssentRead = {
  participationId: string | null;
  attemptId: string | null;
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
  lifecycle: null | {
    status: "active" | "paused" | "ended";
    revision: number;
    pausedBy: ("hotel" | "creator")[];
  };
};
export type AffiliateAssentRepository = {
  read(context: RequestContext, attemptId: string): Promise<AffiliateAssentRead | null>;
  readForCollaboration(
    context: RequestContext,
    collaborationId: string,
  ): Promise<AffiliateAssentRead | null>;
  recordForCollaboration(
    context: RequestContext,
    collaborationId: string,
    idempotencyKey: string,
  ): Promise<AffiliateAssentCommandResult>;
  changeLifecycleForCollaboration(
    context: RequestContext,
    collaborationId: string,
    input: AffiliateLifecycleCommandInput,
  ): Promise<AffiliateLifecycleCommandResult>;
  close(): Promise<void>;
};
export type AffiliateAssentCommandResult =
  | {
      ok: true;
      revision: number;
      state: "pending" | "matched";
      replayed: boolean;
    }
  | { ok: false; code: string };
export type AffiliateLifecycleCommandInput = {
  action: "pause" | "resume" | "end";
  reason: string;
  expectedRevision: number;
  idempotencyKey: string;
};
export type AffiliateLifecycleCommandResult = Awaited<
  ReturnType<typeof changeMarketplaceAffiliateAgreementLifecycle>
>;
export function createPgMarketplaceAffiliateAssentRepository(
  connectionString: string,
): AffiliateAssentRepository {
  const pool = new pg.Pool({ connectionString, max: 3 });
  return {
    read: (context, id) => readAffiliateAssent(pool, context, id),
    readForCollaboration: (context, id) => readCollaborationAffiliateAssent(pool, context, id),
    recordForCollaboration: (context, id, key) =>
      recordCollaborationAffiliateAssent(pool, context, id, key),
    changeLifecycleForCollaboration: (context, id, input) =>
      changeCollaborationAffiliateLifecycle(pool, context, id, input),
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
      m.creator_profile_id,t.id AS terms_id,t.disclosure,t.disclosure_hash,x.agreement_id,
      (SELECT recorded_at FROM marketplace.affiliate_assent_decisions
        WHERE attempt_id=a.id AND decision='hotel_approval') AS hotel_approved_at,
      (SELECT recorded_at FROM marketplace.affiliate_assent_decisions
        WHERE attempt_id=a.id AND decision='creator_acceptance') AS creator_accepted_at
    FROM marketplace.affiliate_participation_attempts a
    JOIN marketplace.affiliate_participations m ON m.id=a.participation_id
    JOIN marketplace.affiliate_programs p ON p.id=m.program_id
    JOIN marketplace.affiliate_published_terms t ON t.id=a.terms_id AND t.program_id=p.id
    LEFT JOIN marketplace.affiliate_agreement_activations x ON x.attempt_id=a.id
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
    await authorizeAffiliateRead(context, row, hotel);
  } catch (error) {
    if (error instanceof AuthorizationError) return null;
    throw error;
  }
  if (createHash("sha256").update(row.disclosure).digest("hex") !== row.disclosure_hash)
    throw new Error("Stored affiliate disclosure is invalid");
  const hotelApprovedAt = row.hotel_approved_at?.toISOString() ?? null;
  const creatorAcceptedAt = row.creator_accepted_at?.toISOString() ?? null;
  const lifecycle = row.agreement_id ? await readAffiliateLifecycle(pool, row.agreement_id) : null;
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
    lifecycle,
  };
}

export function validAffiliateCollaborationKey(id: string): boolean {
  return id.length <= 100 && /^[A-Za-z0-9._~:-]+$/.test(id);
}

async function authorizeAffiliateRead(
  context: RequestContext,
  row: { property_id: string; offer_id: string; creator_profile_id: string },
  hotel: boolean,
): Promise<void> {
  const resource = {
    product: "marketplace" as const,
    resourceType: hotel ? ("hotel_profile" as const) : ("creator_profile" as const),
    resourceId: hotel ? row.property_id : row.creator_profile_id,
  };
  requireResourceAccess(context, {
    permission: "marketplace.collaboration.read",
    resource: { ...resource, allowedRelationships: hotel ? ["owner", "operator"] : ["owner"] },
  });
  if (!hotel) {
    const owned = context.linkedResources.filter(
      (link) =>
        link.product === "marketplace" &&
        link.resourceType === "creator_profile" &&
        link.relationship === "owner" &&
        link.status === "active",
    );
    if (owned.length !== 1 || owned[0]!.resourceId !== row.creator_profile_id)
      throw new AuthorizationError();
    return;
  }
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
    WHERE c.matches=1
    ORDER BY EXISTS (
      SELECT 1 FROM marketplace.affiliate_agreement_activations x WHERE x.attempt_id=a.id
    ) DESC,a.attempt_number DESC LIMIT 1`,
    [collaborationId, context.selectedOrganization.organizationId, hotel],
  );
  // Reuse exact-version disclosure, persisted-resource and canonical property authorization.
  if (result.rows[0]) return readAffiliateAssent(pool, context, result.rows[0].id);
  const target = await resolveCollaborationAffiliateAssentTarget(pool, context, collaborationId);
  if (!target) return null;
  try {
    await authorizeAffiliateRead(context, target, hotel);
  } catch (error) {
    if (error instanceof AuthorizationError) return null;
    throw error;
  }
  return {
    participationId: null,
    attemptId: null,
    programId: target.program_id,
    propertyId: target.property_id,
    offerId: target.offer_id,
    creatorProfileId: target.creator_profile_id,
    origin: hotel ? "invitation" : "application",
    revision: 0,
    assentState: "pending",
    terms: {
      id: target.terms_id,
      disclosure: target.disclosure,
      disclosureHash: target.disclosure_hash,
    },
    hotelApprovedAt: null,
    creatorAcceptedAt: null,
    lifecycle: null,
  };
}

async function readAffiliateLifecycle(pool: pg.Pool, agreementId: string) {
  const lifecycle = await readMarketplaceAffiliateAgreementLifecycle(pool, agreementId, false);
  if (lifecycle.status === "invalid_history")
    throw new Error("Invalid affiliate lifecycle history");
  return lifecycle.status === "unavailable" ? null : lifecycle;
}

export async function recordCollaborationAffiliateAssent(
  pool: pg.Pool,
  context: RequestContext,
  collaborationId: string,
  idempotencyKey: string,
): Promise<AffiliateAssentCommandResult> {
  const hotel = context.selectedOrganization.kind === "hotel_group";
  if (
    !validAffiliateCollaborationKey(collaborationId) ||
    !idempotencyKey.trim() ||
    idempotencyKey.length > 200 ||
    (!hotel && context.selectedOrganization.kind !== "creator_workspace")
  )
    return { ok: false, code: "invalid_request" };

  const target = await resolveCollaborationAffiliateAssentTarget(pool, context, collaborationId);
  if (!target) return { ok: false, code: "scope_unavailable" };
  const keyHash = createHash("sha256")
    .update(JSON.stringify([target.program_id, target.creator_profile_id, idempotencyKey]))
    .digest("hex");
  const replay = await pool.query<{ revision: number }>(
    `SELECT d.revision FROM platform.idempotency_keys k
    JOIN marketplace.affiliate_assent_decisions d ON d.id::text=k.response_resource_id
      AND d.actor_user_id=$4 AND d.actor_organization_id=$5 AND d.decision=$6
    WHERE k.operation_scope='marketplace' AND k.operation='marketplace.affiliate.initial_assent'
      AND k.tenant_scope='property' AND k.property_id=$1 AND k.key_hash=$2
      AND k.status='completed' AND d.attempt_id=COALESCE($3::uuid,d.attempt_id)`,
    [
      target.property_id,
      keyHash,
      target.attempt_id,
      context.actor.internalUserId,
      context.selectedOrganization.organizationId,
      hotel ? "hotel_approval" : "creator_acceptance",
    ],
  );

  const result = await recordAffiliateAssent(pool, {
    context,
    propertyId: target.property_id,
    programId: target.program_id,
    creatorProfileId: target.creator_profile_id,
    termsId: target.terms_id,
    attemptId:
      target.attempt_id ??
      deterministicAttemptId(target.program_id, target.creator_profile_id, target.terms_id),
    expectedRevision: replay.rows[0] ? replay.rows[0].revision - 1 : Number(target.revision),
    idempotencyKey,
    decision: hotel ? "hotel_approval" : "creator_acceptance",
    disclosureHash: target.disclosure_hash,
    collaborationId,
  });
  return result.ok
    ? {
        ok: true,
        revision: result.revision,
        state: result.state,
        replayed: result.replayed,
      }
    : result;
}

export async function changeCollaborationAffiliateLifecycle(
  pool: pg.Pool,
  context: RequestContext,
  collaborationId: string,
  input: AffiliateLifecycleCommandInput,
): Promise<AffiliateLifecycleCommandResult> {
  const target = await resolveCollaborationAffiliateAssentTarget(pool, context, collaborationId);
  if (!target?.attempt_id) return { ok: false, code: "scope_unavailable" };
  const agreement = await pool.query<{ agreement_id: string }>(
    `SELECT agreement_id FROM marketplace.affiliate_agreement_activations WHERE attempt_id=$1`,
    [target.attempt_id],
  );
  if (!agreement.rows[0]) return { ok: false, code: "scope_unavailable" };
  return changeMarketplaceAffiliateAgreementLifecycle(pool, {
    context,
    agreementId: agreement.rows[0].agreement_id,
    ...input,
  });
}

type CollaborationAffiliateTarget = {
  property_id: string;
  offer_id: string;
  program_id: string;
  creator_profile_id: string;
  attempt_id: string | null;
  revision: string;
  terms_id: string;
  disclosure: string;
  disclosure_hash: string;
};

async function resolveCollaborationAffiliateAssentTarget(
  pool: pg.Pool,
  context: RequestContext,
  collaborationId: string,
): Promise<CollaborationAffiliateTarget | null> {
  const hotel = context.selectedOrganization.kind === "hotel_group";
  const scope = await pool.query<CollaborationAffiliateTarget>(
    `WITH candidates AS (
      SELECT c.*, count(*) OVER () AS matches FROM marketplace.collaborations c
      WHERE c.source_collaboration_id=$1
        AND CASE WHEN $3 THEN c.hotel_organization_id ELSE c.creator_organization_id END=$2
    )
    SELECT c.property_id,c.offer_id,p.id AS program_id,c.creator_profile_id,a.id AS attempt_id,
      count(d.id)::text AS revision,COALESCE(at.id,latest.id) AS terms_id,
      COALESCE(at.disclosure,latest.disclosure) AS disclosure,
      COALESCE(at.disclosure_hash,latest.disclosure_hash) AS disclosure_hash
    FROM candidates c
    JOIN marketplace.affiliate_programs p ON p.offer_id=c.offer_id
      AND p.property_id=c.property_id AND p.organization_id=c.hotel_organization_id
    JOIN marketplace.creator_profiles cp ON cp.id=c.creator_profile_id
      AND cp.organization_id=c.creator_organization_id AND cp.profile_status='active'
    LEFT JOIN marketplace.affiliate_participations m ON m.program_id=p.id
      AND m.creator_profile_id=c.creator_profile_id
      AND m.creator_organization_id=c.creator_organization_id
    LEFT JOIN LATERAL (
      SELECT candidate.id,candidate.terms_id FROM marketplace.affiliate_participation_attempts candidate
      WHERE candidate.participation_id=m.id
      ORDER BY EXISTS (
        SELECT 1 FROM marketplace.affiliate_agreement_activations x WHERE x.attempt_id=candidate.id
      ) DESC,candidate.attempt_number DESC LIMIT 1
    ) a ON true
    LEFT JOIN marketplace.affiliate_published_terms at ON at.id=a.terms_id AND at.program_id=p.id
    LEFT JOIN LATERAL (
      SELECT published.id,published.disclosure,published.disclosure_hash FROM marketplace.affiliate_published_terms published
      WHERE published.program_id=p.id AND published.effective_at<=now()
      ORDER BY published.effective_at DESC,published.recorded_at DESC,published.id DESC LIMIT 1
    ) latest ON true
    LEFT JOIN marketplace.affiliate_assent_decisions d ON d.attempt_id=a.id
    WHERE c.matches=1 AND COALESCE(at.id,latest.id) IS NOT NULL
    GROUP BY c.property_id,c.offer_id,p.id,c.creator_profile_id,a.id,at.id,at.disclosure,
      at.disclosure_hash,latest.id,latest.disclosure,latest.disclosure_hash`,
    [collaborationId, context.selectedOrganization.organizationId, hotel],
  );
  return scope.rows[0] ?? null;
}

function deterministicAttemptId(
  programId: string,
  creatorProfileId: string,
  termsId: string,
): string {
  const value = createHash("sha256")
    .update(`marketplace-affiliate-attempt:v1:${programId}:${creatorProfileId}:${termsId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  value[12] = "4";
  value[16] = ((Number.parseInt(value[16]!, 16) & 3) | 8).toString(16);
  const id = value.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
