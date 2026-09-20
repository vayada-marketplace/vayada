import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import { requireResourceAccess } from "@vayada/backend-authorization";
import {
  buildMarketplaceAffiliateSharePath,
  MARKETPLACE_AFFILIATE_LINK_CONTRACT_VERSION,
  type MarketplaceAffiliateLink,
} from "@vayada/domain-marketplace";
import { readMarketplaceAffiliateAgreementLifecycle } from "./marketplaceAffiliateAgreementLifecycle.js";

type Scope = {
  agreementId: string;
  activationId: string;
  propertyId: string;
  programId: string;
  termsId: string;
};

/** Trusted owner-domain check for current lifecycle and booking-destination readiness. */
export type AffiliateLinkCreationReadiness = (
  client: pg.PoolClient,
  scope: Scope,
) => Promise<{ status: "ready"; scope: Scope } | { status: "blocked"; reasons: string[] }>;

export const unresolvedAffiliateLinkCreationReadiness: AffiliateLinkCreationReadiness =
  async () => ({
    status: "blocked",
    reasons: ["link_creation_readiness_adapter_missing"],
  });

type Input = { context: RequestContext; agreementId: string; idempotencyKey: string };
type Link = MarketplaceAffiliateLink & { path: string; replayed: boolean };
type Result = ({ ok: true } & Link) | { ok: false; code: string; reasons?: string[] };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const operation = "marketplace.affiliate_link.create";
const scopeKeys = ["agreementId", "activationId", "propertyId", "programId", "termsId"] as const;
const sameScope = (left: unknown, right: Scope) =>
  typeof left === "object" &&
  left !== null &&
  Object.keys(left).length === scopeKeys.length &&
  scopeKeys.every((key) => (left as Record<keyof Scope, unknown>)[key] === right[key]);

/** Internal creator command. Public link resolution is a separate trust boundary. */
export async function createMarketplaceAffiliateLink(
  pool: pg.Pool,
  input: Input,
  resolveReadiness: AffiliateLinkCreationReadiness = unresolvedAffiliateLinkCreationReadiness,
): Promise<Result> {
  if (
    typeof input.agreementId !== "string" ||
    !uuid.test(input.agreementId) ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200 ||
    !input.context.audit.requestId.trim() ||
    input.context.audit.requestId.length > 200
  )
    return { ok: false, code: "invalid_request" };

  const agreementId = input.agreementId.toLowerCase();
  const { context } = input;
  const actorId = context.actor.internalUserId;
  const organizationId = context.selectedOrganization.organizationId;
  if (
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.status !== "active" ||
    context.selectedOrganization.kind !== "creator_workspace"
  )
    return { ok: false, code: "scope_unavailable" };

  const client = await pool.connect();
  const fail = async (code: string, reasons?: string[]): Promise<Result> => {
    await client.query("ROLLBACK");
    return reasons ? { ok: false, code, reasons } : { ok: false, code };
  };
  const success = (row: {
    id: string;
    agreement_id: string;
    property_id: string;
    public_token: string;
    created_at: Date;
  }): { ok: true } & Link => {
    const share = buildMarketplaceAffiliateSharePath(row.public_token);
    if (!share.ok) throw new Error("Invalid stored affiliate link token");
    return {
      ok: true,
      contractVersion: MARKETPLACE_AFFILIATE_LINK_CONTRACT_VERSION,
      linkId: row.id,
      agreementId: row.agreement_id,
      propertyId: row.property_id,
      publicToken: row.public_token,
      path: share.path,
      createdAt: row.created_at.toISOString(),
      replayed: false,
    };
  };

  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const target = (
      await client.query(
        `SELECT g.id AS agreement_id,g.property_id,g.program_id,g.creator_profile_id,
          g.creator_organization_id,c.owner_user_id,c.profile_status,
          a.id AS activation_id,a.terms_id
        FROM marketplace.affiliate_agreements g
        JOIN marketplace.affiliate_agreement_activations a ON a.agreement_id=g.id
        JOIN marketplace.creator_profiles c ON c.id=g.creator_profile_id
          AND c.organization_id=g.creator_organization_id
        WHERE g.id=$1 FOR UPDATE OF g,c,a`,
        [agreementId],
      )
    ).rows[0];
    if (
      !target ||
      target.creator_organization_id !== organizationId ||
      target.owner_user_id !== actorId ||
      target.profile_status !== "active"
    )
      return await fail("scope_unavailable");

    requireResourceAccess(context, {
      permission: "marketplace.collaboration.write",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: target.creator_profile_id,
        allowedRelationships: ["owner"],
      },
    });
    const owner = await client.query(
      `SELECT id FROM identity.organization_resource_links
       WHERE organization_id=$1 AND product='marketplace' AND status='active'
         AND resource_type='creator_profile' AND resource_id=$2 AND relationship='owner'
       FOR SHARE`,
      [organizationId, target.creator_profile_id],
    );
    if (!owner.rowCount) return await fail("scope_unavailable");

    const key = hash(JSON.stringify([agreementId, input.idempotencyKey]));
    const fingerprint = hash(JSON.stringify([agreementId, organizationId, actorId]));
    const prior = (
      await client.query(
        `SELECT k.status,k.request_fingerprint_hash,l.id,l.agreement_id,l.property_id,
          l.public_token,l.created_at
         FROM platform.idempotency_keys k
         LEFT JOIN marketplace.affiliate_links l ON l.id::text=k.response_resource_id
           AND l.agreement_id=$4
         WHERE k.operation_scope='marketplace' AND k.operation=$1
           AND k.tenant_scope='property' AND k.property_id=$2 AND k.key_hash=$3`,
        [operation, target.property_id, key, agreementId],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.status !== "completed" ||
        prior.request_fingerprint_hash !== fingerprint ||
        !prior.id
      )
        return await fail("idempotency_conflict");
      const result = success(prior);
      await client.query("ROLLBACK");
      return { ...result, replayed: true };
    }

    const existing = (
      await client.query(
        `SELECT id,agreement_id,property_id,public_token,created_at
         FROM marketplace.affiliate_links WHERE agreement_id=$1`,
        [agreementId],
      )
    ).rows[0];
    if (existing) {
      const result = success(existing);
      await client.query("ROLLBACK");
      return { ...result, replayed: true };
    }

    const lifecycle = await readMarketplaceAffiliateAgreementLifecycle(client, agreementId);
    if (lifecycle.status !== "active") return await fail("agreement_not_active");

    const scope: Scope = {
      agreementId,
      activationId: target.activation_id,
      propertyId: target.property_id,
      programId: target.program_id,
      termsId: target.terms_id,
    };
    const readiness = await resolveReadiness(client, structuredClone(scope));
    if (readiness.status === "blocked") {
      if (
        !Array.isArray(readiness.reasons) ||
        !readiness.reasons.length ||
        readiness.reasons.some(
          (reason) => typeof reason !== "string" || !reason.trim() || reason.length > 200,
        )
      )
        throw new Error("Invalid affiliate link readiness proof");
      return await fail("link_creation_blocked", readiness.reasons);
    }
    if (readiness.status !== "ready" || !sameScope(readiness.scope, scope))
      throw new Error("Invalid affiliate link readiness proof");

    const token = `va_${randomBytes(16).toString("base64url")}`;
    const created = (
      await client.query(
        `INSERT INTO marketplace.affiliate_links
         (id,agreement_id,activation_id,participation_id,program_id,property_id,public_token,
          contract_version,actor_user_id,actor_organization_id,request_id)
         SELECT $1,g.id,$2,g.participation_id,g.program_id,g.property_id,$3,$4,$5,$6,$7
         FROM marketplace.affiliate_agreements g WHERE g.id=$8
         RETURNING id,agreement_id,property_id,public_token,created_at`,
        [
          randomUUID(),
          scope.activationId,
          token,
          MARKETPLACE_AFFILIATE_LINK_CONTRACT_VERSION,
          actorId,
          organizationId,
          context.audit.requestId,
          agreementId,
        ],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO platform.idempotency_keys
       (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,
        response_status_code,response_resource_product,response_resource_type,response_resource_id,
        correlation_id,completed_at,expires_at)
       VALUES ('marketplace',$1,$2,$3,'completed','property',$4,201,'marketplace',
         'affiliate_link',$5,$6,now(),now()+interval '90 days')`,
      [
        operation,
        key,
        fingerprint,
        scope.propertyId,
        created.id,
        context.audit.correlationId ?? context.audit.requestId,
      ],
    );
    await client.query("COMMIT");
    return success(created);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
