import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import {
  requireActiveEntitlement,
  requireResourceAccess,
  requirePropertyAccess,
} from "@vayada/backend-authorization";
import {
  calculateAffiliateEarning,
  normalizeAffiliateEarningCalculation,
  type AffiliateEarningResult,
  type AffiliateEarningSnapshot,
} from "@vayada/domain-finance";
type Calculation = Omit<Parameters<typeof calculateAffiliateEarning>[0], "previous">;
type Request = {
  context: RequestContext;
  propertyId: string;
  bookingId: string;
  stayItemId: string;
  sourceRevision: number;
};
export type TrustedAffiliateEarningRequest = Omit<Request, "context">;
export type AffiliateEarningJournalAudit = {
  actorUserId: string;
  organizationId: string;
  requestId: string;
};
/** Trusted owner-domain resolver for exact canonical projection revision. Must verify scope,
 * historical agreement/policy, evidence authority and ordering in this transaction. No network I/O.
 * Never construct this result from hotel form flags.
 */
export type AffiliateEarningEvidenceResolver = (
  client: pg.PoolClient,
  request: TrustedAffiliateEarningRequest & { context?: RequestContext },
) => Promise<{
  sourceRevision: number;
  calculation: Calculation;
} | null>;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const json = (value: unknown) => JSON.stringify(canonical(value));
const reference = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
export type AffiliateEarningJournalResult =
  | {
      ok: true;
      entryId: string;
      revision: number;
      replayed: boolean;
      outcome: AffiliateEarningResult;
    }
  | { ok: false; code: string };

/** Internal authorized journal command; no payout/balance/hold or public route. */
export async function recordAffiliateEarningCalculation(
  pool: pg.Pool,
  input: Request,
  resolve: AffiliateEarningEvidenceResolver,
): Promise<AffiliateEarningJournalResult> {
  const { context, bookingId, stayItemId, sourceRevision } = input;
  if (
    typeof input.propertyId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.propertyId) ||
    !reference(bookingId) ||
    !reference(stayItemId) ||
    !Number.isSafeInteger(sourceRevision) ||
    sourceRevision < 1 ||
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
  // Fresh caller context must include canonical membership scope, including assigned properties.
  await requirePropertyAccess(
    context,
    { findMembershipPropertyScope: async () => null },
    {
      propertyId,
      targetResource: { product: "marketplace", resourceType: "hotel_profile" },
      allowedRelationships: ["owner", "operator"],
    },
  );
  const client = await pool.connect();
  const fail = async (code: string): Promise<AffiliateEarningJournalResult> => {
    await client.query("ROLLBACK");
    return { ok: false, code };
  };
  try {
    await client.query("BEGIN");
    const access = await client.query(
      `SELECT p.id FROM hotel_catalog.properties p
      JOIN identity.organization_resource_links l ON l.resource_id=p.id::text
      WHERE p.id=$1 AND p.profile_status <> 'disabled' AND l.organization_id=$2
        AND l.product='marketplace' AND l.resource_type='hotel_profile' AND l.status='active'
        AND l.relationship IN ('owner','operator') ORDER BY l.id FOR UPDATE OF p,l`,
      [propertyId, context.selectedOrganization.organizationId],
    );
    if (!access.rowCount) return await fail("scope_unavailable");
    const result = await appendTrustedAffiliateEarningCalculation(
      client,
      { propertyId, bookingId, stayItemId, sourceRevision },
      {
        actorUserId: context.actor.internalUserId,
        organizationId: context.selectedOrganization.organizationId,
        requestId: context.audit.requestId,
      },
      (transaction, trusted) => resolve(transaction, { ...trusted, context }),
    );
    if (!result.ok) return await fail(result.code);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Transaction-scoped sink for trusted internal reconcilers. The caller must establish and
 * lock property/organization authority before calling; this helper only owns journal rules. */
export async function appendTrustedAffiliateEarningCalculation(
  client: pg.PoolClient,
  input: TrustedAffiliateEarningRequest,
  audit: AffiliateEarningJournalAudit,
  resolve: AffiliateEarningEvidenceResolver,
): Promise<AffiliateEarningJournalResult> {
  const { propertyId, bookingId, stayItemId, sourceRevision } = input;
  const key = [propertyId, bookingId, stayItemId];
  const proof = await resolve(client, input);
  if (!proof) return { ok: false, code: "evidence_unavailable" };
  const calculation = normalizeAffiliateEarningCalculation(proof.calculation);
  if (!calculation) return { ok: false, code: "invalid_evidence" };
  if (
    proof.sourceRevision !== sourceRevision ||
    calculation.scope.propertyId !== propertyId ||
    calculation.scope.bookingId !== bookingId ||
    calculation.scope.stayItemId !== stayItemId
  )
    return { ok: false, code: "evidence_scope_mismatch" };
  const payload = json(calculation);
  const digest = createHash("sha256").update(payload).digest("hex");
  const prior = await client.query(
    `SELECT id,revision,input_digest,outcome FROM finance.affiliate_earning_journal
     WHERE property_id=$1 AND booking_id=$2 AND stay_item_id=$3 AND source_revision=$4`,
    [...key, sourceRevision],
  );
  if (prior.rows[0]) {
    const row = prior.rows[0];
    return row.input_digest === digest
      ? { ok: true, entryId: row.id, revision: row.revision, replayed: true, outcome: row.outcome }
      : { ok: false, code: "evidence_revision_conflict" };
  }
  const latest = await client.query(
    `SELECT revision,source_revision FROM finance.affiliate_earning_journal
     WHERE property_id=$1 AND booking_id=$2 AND stay_item_id=$3 ORDER BY revision DESC LIMIT 1`,
    key,
  );
  if (latest.rows[0] && BigInt(latest.rows[0].source_revision) >= BigInt(sourceRevision))
    return { ok: false, code: "stale_evidence_revision" };
  const revision = (latest.rows[0]?.revision ?? 0) + 1;
  if (revision > 2147483647) return { ok: false, code: "revision_limit" };
  const previous = await client.query(
    `SELECT outcome->'snapshot' AS snapshot FROM finance.affiliate_earning_journal
     WHERE property_id=$1 AND booking_id=$2 AND stay_item_id=$3 AND outcome->>'status'='calculated' ORDER BY revision DESC LIMIT 1`,
    key,
  );
  const origin = await client.query(
    `SELECT calculation_input->'scope' AS scope FROM finance.affiliate_earning_journal
     WHERE property_id=$1 AND booking_id=$2 AND stay_item_id=$3 ORDER BY revision LIMIT 1`,
    key,
  );
  const outcome: AffiliateEarningResult =
    origin.rows[0] && json(origin.rows[0].scope) !== json(calculation.scope)
      ? { status: "needs_review", reason: "previous_scope_mismatch" }
      : calculateAffiliateEarning({
          ...calculation,
          previous: (previous.rows[0]?.snapshot ?? null) as AffiliateEarningSnapshot | null,
        });
  if (outcome.status === "needs_review" && outcome.reason === "invalid_input")
    return { ok: false, code: "invalid_evidence" };
  const entryId = randomUUID();
  await client.query(
    `INSERT INTO finance.affiliate_earning_journal
     (id,property_id,booking_id,stay_item_id,revision,source_revision,input_digest,calculation_input,outcome,actor_user_id,organization_id,request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      entryId,
      ...key,
      revision,
      sourceRevision,
      digest,
      payload,
      JSON.stringify(outcome),
      audit.actorUserId,
      audit.organizationId,
      audit.requestId,
    ],
  );
  return { ok: true, entryId, revision, replayed: false, outcome };
}
