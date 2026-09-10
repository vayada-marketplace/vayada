import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import { requireActiveEntitlement, requireResourceAccess } from "@vayada/backend-authorization";
import {
  parseMarketplaceAffiliateOfferTerms,
  type MarketplaceAffiliateOfferTerms,
} from "@vayada/domain-marketplace";
import { readBookingAffiliateDestinations } from "./bookingAffiliateDestinationRepository.js";
import { resolvePgFinanceAffiliatePercentagePolicy } from "./financeAffiliatePercentagePolicyResolver.js";

type Scope = {
  propertyId: string;
  organizationId: string;
  offerId: string;
  draftId: string;
  terms: MarketplaceAffiliateOfferTerms;
};
type Proof =
  | {
      status: "ready";
      scope: Scope;
      conditionsText: string;
      attributionPolicyVersion: string;
      evidenceReferences: string[];
    }
  | { status: "blocked"; reasons: string[] };
/** Trusted internal owner-domain port, never request payload. Must verify complete commercial
 * conditions and current authenticated tracking evidence for the exact scope within this transaction.
 * A future adapter must preserve consistency with publication (locks/version fencing, no network I/O).
 */
export type AffiliatePublicationPrerequisites = (
  client: pg.PoolClient,
  scope: Scope,
) => Promise<Proof>;
export const unresolvedAffiliatePublicationPrerequisites: AffiliatePublicationPrerequisites =
  async () => ({
    status: "blocked",
    reasons: ["commercial_conditions_unresolved", "tracking_evidence_adapter_missing"],
  });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const operation = "marketplace.affiliate_terms.publish";
type Input = {
  context: RequestContext;
  propertyId: string;
  offerId: string;
  draftId: string;
  expectedRevision: number;
  idempotencyKey: string;
};
type Result =
  | { ok: true; termsVersionId: string; programId: string; replayed: boolean }
  | { ok: false; code: string; reasons?: string[] };

/** Internal command only. No HTTP route, creator acceptance or link activation. */
export async function publishMarketplaceAffiliateTerms(
  pool: pg.Pool,
  input: Input,
  resolvePrerequisites: AffiliatePublicationPrerequisites = unresolvedAffiliatePublicationPrerequisites,
): Promise<Result> {
  const { context } = input;
  if (
    ![input.propertyId, input.offerId, input.draftId].every(
      (value) => typeof value === "string" && uuid.test(value),
    ) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    input.expectedRevision > 2147483647 ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200
  )
    return { ok: false, code: "invalid_request" };
  const propertyId = input.propertyId.toLowerCase(),
    offerId = input.offerId.toLowerCase(),
    draftId = input.draftId.toLowerCase();
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
  const organizationId = context.selectedOrganization.organizationId,
    actorId = context.actor.internalUserId;
  const key = hash(JSON.stringify([offerId, input.idempotencyKey]));
  const fingerprint = hash(
    JSON.stringify([organizationId, actorId, propertyId, offerId, draftId, input.expectedRevision]),
  );
  const client = await pool.connect();
  const fail = async (code: string, reasons?: string[]): Promise<Result> => {
    await client.query("ROLLBACK");
    return reasons ? { ok: false, code, reasons } : { ok: false, code };
  };
  try {
    await client.query("BEGIN");
    const offer = await client.query(
      `SELECT id,offer_status FROM marketplace.marketplace_offers
      WHERE id=$1 AND property_id=$2 AND organization_id=$3 FOR UPDATE`,
      [offerId, propertyId, organizationId],
    );
    if (!offer.rowCount) return await fail("scope_unavailable");
    const scope = await client.query(
      `SELECT p.id FROM hotel_catalog.properties p
      JOIN identity.organization_resource_links l ON l.resource_id=p.id::text
      WHERE p.id=$1 AND p.profile_status <> 'disabled' AND l.organization_id=$2
        AND l.product='marketplace' AND l.resource_type='hotel_profile' AND l.status='active'
        AND l.relationship IN ('owner','operator') ORDER BY l.id FOR UPDATE OF p,l`,
      [propertyId, organizationId],
    );
    if (!scope.rowCount) return await fail("scope_unavailable");
    const offerLink = await client.query(
      `SELECT id FROM identity.organization_resource_links
      WHERE organization_id=$1 AND resource_id=$2 AND product='marketplace'
        AND resource_type='marketplace_offer' AND status='active' AND relationship IN ('owner','operator')
      ORDER BY id FOR UPDATE`,
      [organizationId, offerId],
    );
    if (!offerLink.rowCount) return await fail("scope_unavailable");
    const prior = await client.query(
      `SELECT k.status,k.request_fingerprint_hash,t.id,t.program_id
      FROM platform.idempotency_keys k LEFT JOIN marketplace.affiliate_published_terms t
        ON t.id::text=k.response_resource_id AND t.offer_id=$4 AND t.organization_id=$5
        AND t.property_id=$2 AND t.actor_user_id=$6
      WHERE k.operation_scope='marketplace' AND k.operation=$1 AND k.tenant_scope='property'
        AND k.property_id=$2 AND k.key_hash=$3`,
      [operation, propertyId, key, offerId, organizationId, actorId],
    );
    if (prior.rows[0]) {
      const saved = prior.rows[0];
      await client.query("ROLLBACK");
      return saved.status === "completed" &&
        saved.request_fingerprint_hash === fingerprint &&
        saved.id
        ? { ok: true, termsVersionId: saved.id, programId: saved.program_id, replayed: true }
        : { ok: false, code: "idempotency_conflict" };
    }
    if (offer.rows[0].offer_status !== "verified") return await fail("offer_not_verified");
    const draft = await client.query(
      `SELECT * FROM marketplace.affiliate_offer_terms_drafts
      WHERE offer_id=$1 AND property_id=$2 AND organization_id=$3 ORDER BY revision DESC LIMIT 1`,
      [offerId, propertyId, organizationId],
    );
    const row = draft.rows[0];
    if (!row || row.id !== draftId || row.revision !== input.expectedRevision)
      return await fail("revision_conflict");
    const parsed = parseMarketplaceAffiliateOfferTerms({
      bookingDestinationId: row.booking_destination_id,
      financePolicyVersionId: row.finance_policy_version_id,
      attributionWindowDays: row.attribution_window_days,
    });
    if (!parsed.ok) throw new Error("Invalid stored affiliate draft");
    const existing = await client.query(
      "SELECT id FROM marketplace.affiliate_published_terms WHERE source_draft_id=$1",
      [draftId],
    );
    if (existing.rowCount) return await fail("draft_already_published");
    const commission = await resolvePgFinanceAffiliatePercentagePolicy(client, {
      propertyId,
      policyVersionId: parsed.terms.financePolicyVersionId,
    });
    if (commission.status !== "available") return await fail("policy_unavailable");
    const [destination] = await readBookingAffiliateDestinations(
      client,
      propertyId,
      organizationId,
      parsed.terms.bookingDestinationId,
    );
    if (!destination) return await fail("destination_unavailable");
    const proofScope = { propertyId, organizationId, offerId, draftId, terms: parsed.terms };
    const proof = await resolvePrerequisites(client, structuredClone(proofScope));
    if (proof.status === "blocked") return await fail("publication_blocked", proof.reasons);
    if (
      proof.scope.propertyId !== propertyId ||
      proof.scope.organizationId !== organizationId ||
      proof.scope.offerId !== offerId ||
      proof.scope.draftId !== draftId ||
      proof.scope.terms.bookingDestinationId !== parsed.terms.bookingDestinationId ||
      proof.scope.terms.financePolicyVersionId !== parsed.terms.financePolicyVersionId ||
      proof.scope.terms.attributionWindowDays !== parsed.terms.attributionWindowDays ||
      !proof.conditionsText.trim() ||
      proof.conditionsText.length > 50000 ||
      !proof.attributionPolicyVersion.trim() ||
      proof.attributionPolicyVersion.length > 200 ||
      !proof.evidenceReferences.length ||
      proof.evidenceReferences.length > 100 ||
      proof.evidenceReferences.some((ref) => !ref.trim() || ref.length > 256)
    )
      throw new Error("Invalid publication prerequisite proof");
    const disclosure = JSON.stringify({
      contractVersion: "marketplace-published-affiliate-terms.v1",
      terms: parsed.terms,
      commission,
      destination: destination.configuration,
      conditionsText: proof.conditionsText,
    });
    const termsVersionId = randomUUID();
    const program = await client.query(
      "SELECT id FROM marketplace.affiliate_programs WHERE offer_id=$1",
      [offerId],
    );
    const programId: string = program.rows[0]?.id ?? randomUUID();
    if (!program.rowCount)
      await client.query("INSERT INTO marketplace.affiliate_programs VALUES ($1,$2,$3,$4)", [
        programId,
        offerId,
        propertyId,
        organizationId,
      ]);
    await client.query(
      `INSERT INTO marketplace.affiliate_published_terms
      (id,program_id,offer_id,property_id,organization_id,source_draft_id,disclosure,disclosure_hash,
       attribution_policy_version,evidence_references,actor_user_id,request_id,effective_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp())`,
      [
        termsVersionId,
        programId,
        offerId,
        propertyId,
        organizationId,
        draftId,
        disclosure,
        hash(disclosure),
        proof.attributionPolicyVersion,
        JSON.stringify(proof.evidenceReferences),
        actorId,
        context.audit.requestId,
      ],
    );
    await client.query(
      `INSERT INTO platform.idempotency_keys
      (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,
       response_status_code,response_resource_product,response_resource_type,response_resource_id,correlation_id,completed_at,expires_at)
      VALUES ('marketplace',$1,$2,$3,'completed','property',$4,201,'marketplace','affiliate_published_terms',$5,$6,now(),now()+interval '90 days')`,
      [
        operation,
        key,
        fingerprint,
        propertyId,
        termsVersionId,
        context.audit.correlationId ?? context.audit.requestId,
      ],
    );
    await client.query("COMMIT");
    return { ok: true, termsVersionId, programId, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
