import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import {
  requireActiveEntitlement,
  requirePropertyAccess,
  requireResourceAccess,
} from "@vayada/backend-authorization";

type ActivationScope = {
  propertyId: string;
  hotelOrganizationId: string;
  offerId: string;
  programId: string;
  participationId: string;
  attemptId: string;
  termsId: string;
  creatorProfileId: string;
  creatorOrganizationId: string;
};

type Readiness =
  | {
      status: "ready";
      scope: ActivationScope;
      enrollmentOpen: true;
      evidenceReferences: string[];
    }
  | { status: "blocked"; reasons: string[] };

/** Trusted internal owner-domain port. It must recheck current enrollment and
 * cross-domain commercial, destination, and tracking readiness in this transaction.
 */
export type AffiliateAgreementActivationReadiness = (
  client: pg.PoolClient,
  scope: ActivationScope,
) => Promise<Readiness>;

export const unresolvedAffiliateAgreementActivationReadiness: AffiliateAgreementActivationReadiness =
  async () => ({
    status: "blocked",
    reasons: ["activation_readiness_adapter_missing"],
  });

type Input = {
  context: RequestContext;
  propertyId: string;
  programId: string;
  creatorProfileId: string;
  attemptId: string;
  termsId: string;
  expectedRevision: 0;
  idempotencyKey: string;
};

type Result =
  | {
      ok: true;
      agreementId: string;
      activationId: string;
      effectiveAt: string;
      replayed: boolean;
    }
  | { ok: false; code: string; reasons?: string[] };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const operation = "marketplace.affiliate_agreement.activate";
const activationScopeKeys = [
  "propertyId",
  "hotelOrganizationId",
  "offerId",
  "programId",
  "participationId",
  "attemptId",
  "termsId",
  "creatorProfileId",
  "creatorOrganizationId",
] as const satisfies readonly (keyof ActivationScope)[];
const sameScope = (left: unknown, right: ActivationScope) =>
  typeof left === "object" &&
  left !== null &&
  Object.keys(left).length === activationScopeKeys.length &&
  activationScopeKeys.every(
    (key) => (left as Record<keyof ActivationScope, unknown>)[key] === right[key],
  );

/** Internal command only. Successful activation is the boundary that permits a later link command. */
export async function activateMarketplaceAffiliateAgreement(
  pool: pg.Pool,
  input: Input,
  resolveReadiness: AffiliateAgreementActivationReadiness = unresolvedAffiliateAgreementActivationReadiness,
): Promise<Result> {
  if (
    ![
      input.propertyId,
      input.programId,
      input.creatorProfileId,
      input.attemptId,
      input.termsId,
    ].every((value) => typeof value === "string" && uuid.test(value)) ||
    input.expectedRevision !== 0 ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200 ||
    !input.context.audit.requestId.trim() ||
    input.context.audit.requestId.length > 200
  )
    return { ok: false, code: "invalid_request" };

  const propertyId = input.propertyId.toLowerCase();
  const programId = input.programId.toLowerCase();
  const creatorProfileId = input.creatorProfileId.toLowerCase();
  const attemptId = input.attemptId.toLowerCase();
  const termsId = input.termsId.toLowerCase();
  const { context } = input;
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

  const resource = {
    product: "marketplace" as const,
    resourceType: hotel ? ("hotel_profile" as const) : ("creator_profile" as const),
    resourceId: hotel ? propertyId : creatorProfileId,
  };
  requireResourceAccess(context, {
    permission: "marketplace.collaboration.write",
    resource: { ...resource, allowedRelationships: hotel ? ["owner", "operator"] : ["owner"] },
  });
  if (hotel) {
    requireActiveEntitlement(context, {
      product: "marketplace",
      key: "marketplace-hotel-profile",
      resource,
    });
    await requirePropertyAccess(
      context,
      { findMembershipPropertyScope: async () => null },
      {
        propertyId,
        targetResource: { product: "marketplace", resourceType: "hotel_profile" },
        allowedRelationships: ["owner", "operator"],
      },
    );
  } else {
    const owned = context.linkedResources.filter(
      (link) =>
        link.product === "marketplace" &&
        link.resourceType === "creator_profile" &&
        link.relationship === "owner" &&
        link.status === "active",
    );
    if (owned.length !== 1 || owned[0]!.resourceId !== creatorProfileId)
      return { ok: false, code: "scope_unavailable" };
  }

  const key = hash(JSON.stringify([programId, creatorProfileId, input.idempotencyKey]));
  const fingerprint = hash(
    JSON.stringify([
      organizationId,
      actorId,
      propertyId,
      programId,
      creatorProfileId,
      attemptId,
      termsId,
      input.expectedRevision,
    ]),
  );
  const client = await pool.connect();
  const fail = async (code: string, reasons?: string[]): Promise<Result> => {
    await client.query("ROLLBACK");
    return reasons ? { ok: false, code, reasons } : { ok: false, code };
  };

  try {
    await client.query("BEGIN");
    const target = (
      await client.query(
        `SELECT p.offer_id,p.organization_id AS hotel_organization_id,
          m.id AS participation_id,m.creator_organization_id,c.owner_user_id,a.terms_id
        FROM marketplace.affiliate_programs p
        JOIN marketplace.marketplace_offers o ON o.id=p.offer_id
          AND o.property_id=p.property_id AND o.organization_id=p.organization_id
        JOIN marketplace.affiliate_participations m ON m.program_id=p.id
          AND m.creator_profile_id=$3
        JOIN marketplace.creator_profiles c ON c.id=m.creator_profile_id
          AND c.organization_id=m.creator_organization_id
        JOIN marketplace.affiliate_participation_attempts a ON a.id=$4
          AND a.participation_id=m.id AND a.program_id=p.id AND a.terms_id=$5
        JOIN marketplace.affiliate_published_terms t ON t.id=a.terms_id
          AND t.program_id=p.id AND t.offer_id=p.offer_id AND t.property_id=p.property_id
          AND t.organization_id=p.organization_id
        WHERE p.id=$1 AND p.property_id=$2 AND o.offer_status='verified'
          AND c.profile_status='active'
        FOR UPDATE OF p,o,m,c,a,t`,
        [programId, propertyId, creatorProfileId, attemptId, termsId],
      )
    ).rows[0];
    if (
      !target ||
      (hotel
        ? target.hotel_organization_id !== organizationId
        : target.creator_organization_id !== organizationId || target.owner_user_id !== actorId)
    )
      return await fail("scope_unavailable");

    if (hotel)
      requireResourceAccess(context, {
        permission: "marketplace.collaboration.write",
        resource: {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: target.offer_id,
          allowedRelationships: ["owner", "operator"],
        },
      });

    const persistedLinks = await client.query(
      `SELECT id FROM identity.organization_resource_links
      WHERE organization_id=$1 AND product='marketplace' AND status='active'
        AND resource_type=$2 AND resource_id=$3 AND relationship=ANY($4::text[])
      ORDER BY id FOR SHARE`,
      [
        organizationId,
        hotel ? "hotel_profile" : "creator_profile",
        hotel ? propertyId : creatorProfileId,
        hotel ? ["owner", "operator"] : ["owner"],
      ],
    );
    if (!persistedLinks.rowCount) return await fail("scope_unavailable");
    if (hotel) {
      const offerLinks = await client.query(
        `SELECT id FROM identity.organization_resource_links
        WHERE organization_id=$1 AND product='marketplace' AND status='active'
          AND resource_type='marketplace_offer' AND resource_id=$2
          AND relationship IN ('owner','operator') ORDER BY id FOR SHARE`,
        [organizationId, target.offer_id],
      );
      if (!offerLinks.rowCount) return await fail("scope_unavailable");
    }

    const prior = (
      await client.query(
        `SELECT k.status,k.request_fingerprint_hash,x.id AS activation_id,x.agreement_id,x.effective_at
        FROM platform.idempotency_keys k
        LEFT JOIN marketplace.affiliate_agreement_activations x
          ON x.id::text=k.response_resource_id AND x.attempt_id=$4 AND x.terms_id=$5
        LEFT JOIN marketplace.affiliate_agreements g ON g.id=x.agreement_id
          AND g.participation_id=$6 AND g.program_id=$7 AND g.creator_profile_id=$8
        WHERE k.operation_scope='marketplace' AND k.operation=$1
          AND k.tenant_scope='property' AND k.property_id=$2 AND k.key_hash=$3`,
        [
          operation,
          propertyId,
          key,
          attemptId,
          termsId,
          target.participation_id,
          programId,
          creatorProfileId,
        ],
      )
    ).rows[0];
    if (prior) {
      await client.query("ROLLBACK");
      return prior.status === "completed" &&
        prior.request_fingerprint_hash === fingerprint &&
        prior.activation_id &&
        prior.agreement_id
        ? {
            ok: true,
            agreementId: prior.agreement_id,
            activationId: prior.activation_id,
            effectiveAt: prior.effective_at.toISOString(),
            replayed: true,
          }
        : { ok: false, code: "idempotency_conflict" };
    }

    const decisions = (
      await client.query(
        `SELECT id,decision,actor_organization_id FROM marketplace.affiliate_assent_decisions
        WHERE attempt_id=$1 AND terms_id=$2 ORDER BY revision FOR SHARE`,
        [attemptId, termsId],
      )
    ).rows;
    const hotelApproval = decisions.find((row) => row.decision === "hotel_approval");
    const creatorAcceptance = decisions.find((row) => row.decision === "creator_acceptance");
    if (
      decisions.length !== 2 ||
      !hotelApproval ||
      !creatorAcceptance ||
      hotelApproval.actor_organization_id !== target.hotel_organization_id ||
      creatorAcceptance.actor_organization_id !== target.creator_organization_id
    )
      return await fail("assent_not_matched");

    const existing = await client.query(
      `SELECT x.id FROM marketplace.affiliate_agreement_activations x
      JOIN marketplace.affiliate_agreements g ON g.id=x.agreement_id
      WHERE g.participation_id=$1 LIMIT 1`,
      [target.participation_id],
    );
    if (existing.rowCount) return await fail("agreement_already_active");

    const scope: ActivationScope = {
      propertyId,
      hotelOrganizationId: target.hotel_organization_id,
      offerId: target.offer_id,
      programId,
      participationId: target.participation_id,
      attemptId,
      termsId,
      creatorProfileId,
      creatorOrganizationId: target.creator_organization_id,
    };
    const readiness = (await resolveReadiness(client, structuredClone(scope))) as
      | Readiness
      | {
          status?: unknown;
          scope?: unknown;
          enrollmentOpen?: unknown;
          evidenceReferences?: unknown;
          reasons?: unknown;
        };
    if (readiness.status === "blocked") {
      if (
        !Array.isArray(readiness.reasons) ||
        !readiness.reasons.length ||
        readiness.reasons.some(
          (reason) => typeof reason !== "string" || !reason.trim() || reason.length > 200,
        )
      )
        throw new Error("Invalid affiliate activation readiness proof");
      return await fail("activation_blocked", readiness.reasons);
    }
    if (
      readiness.status !== "ready" ||
      !sameScope(readiness.scope, scope) ||
      readiness.enrollmentOpen !== true ||
      !Array.isArray(readiness.evidenceReferences) ||
      !readiness.evidenceReferences.length ||
      readiness.evidenceReferences.length > 100 ||
      readiness.evidenceReferences.some(
        (reference) => typeof reference !== "string" || !reference.trim() || reference.length > 256,
      )
    )
      throw new Error("Invalid affiliate activation readiness proof");

    const agreementId = randomUUID();
    const activationId = randomUUID();
    await client.query(
      `INSERT INTO marketplace.affiliate_agreements
      (id,participation_id,program_id,offer_id,property_id,hotel_organization_id,
       creator_profile_id,creator_organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        agreementId,
        scope.participationId,
        programId,
        scope.offerId,
        propertyId,
        scope.hotelOrganizationId,
        creatorProfileId,
        scope.creatorOrganizationId,
      ],
    );
    const activation = (
      await client.query(
        `INSERT INTO marketplace.affiliate_agreement_activations
        (id,agreement_id,participation_id,program_id,attempt_id,terms_id,
         hotel_approval_id,creator_acceptance_id,contract_version,readiness_evidence,
         actor_user_id,actor_organization_id,request_id,effective_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
          'marketplace-affiliate-agreement-activation.v1',$9,$10,$11,$12,clock_timestamp())
        RETURNING effective_at`,
        [
          activationId,
          agreementId,
          scope.participationId,
          programId,
          attemptId,
          termsId,
          hotelApproval.id,
          creatorAcceptance.id,
          JSON.stringify(readiness.evidenceReferences),
          actorId,
          organizationId,
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
        'affiliate_agreement_activation',$5,$6,now(),now()+interval '90 days')`,
      [
        operation,
        key,
        fingerprint,
        propertyId,
        activationId,
        context.audit.correlationId ?? context.audit.requestId,
      ],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      agreementId,
      activationId,
      effectiveAt: activation.effective_at.toISOString(),
      replayed: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
