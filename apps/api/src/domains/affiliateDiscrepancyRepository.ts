import pg from "pg";
import { randomUUID } from "node:crypto";

import type {
  AffiliateClaim,
  AffiliateClaimCreatorScope,
  AffiliateClaimKind,
  AffiliateDiscrepancyRepository,
} from "./affiliateDiscrepancy.js";

type ClaimRow = {
  claim_id: string;
  kind: AffiliateClaimKind;
  status: AffiliateClaim["status"];
  agreement_id: string;
  property_id: string;
  booking_reference: string;
  payout_id: string | null;
  message: string;
  evidence_references: unknown;
  decision_reason: string | null;
  decision_evidence_references: unknown;
  created_at: Date;
  resolved_at: Date | null;
};

const selectClaim = `
  SELECT claim.id AS claim_id, claim.kind,
         COALESCE(resolution.decision, 'submitted') AS status,
         claim.agreement_id, claim.property_id,
         '••••' || right(claim.booking_id::text, 4) AS booking_reference,
         claim.payout_id, claim.message, claim.evidence_references,
         resolution.reason AS decision_reason,
         COALESCE(resolution.evidence_references, '[]'::jsonb) AS decision_evidence_references,
         claim.created_at, resolution.created_at AS resolved_at
  FROM marketplace.affiliate_discrepancy_claims claim
  LEFT JOIN marketplace.affiliate_discrepancy_resolutions resolution ON resolution.claim_id=claim.id`;

export function createPgAffiliateDiscrepancyRepository(
  connectionString: string,
): AffiliateDiscrepancyRepository {
  const pool = new pg.Pool({ connectionString, max: 3 });
  return {
    async submit(input) {
      const claimId = randomUUID();
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO marketplace.affiliate_discrepancy_claims (
           id, kind, creator_organization_id, creator_profile_id, affiliate_id,
           agreement_id, property_id, booking_id, payout_id, message,
           evidence_references, actor_user_id, request_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
         ON CONFLICT ON CONSTRAINT uq_affiliate_discrepancy_claims_duplicate DO NOTHING
         RETURNING id`,
        [
          claimId,
          input.kind,
          input.scope.organizationId,
          input.scope.creatorProfileId,
          input.scope.affiliateId,
          input.agreementId,
          input.propertyId,
          input.bookingId,
          input.payoutId,
          input.message,
          JSON.stringify(input.evidenceReferences),
          input.actorUserId,
          input.requestId,
        ],
      );
      const persistedId = inserted.rows[0]?.id;
      const result = persistedId
        ? await readById(pool, input.scope, persistedId)
        : await readDuplicate(pool, input);
      if (!result) throw new Error("Affiliate discrepancy claim persistence failed");
      return { claim: result, replayed: !persistedId };
    },
    async list(scope) {
      const result = await pool.query<ClaimRow>(
        `${selectClaim}
         WHERE claim.creator_organization_id=$1 AND claim.creator_profile_id=$2
           AND claim.affiliate_id=$3
         ORDER BY claim.created_at DESC, claim.id DESC`,
        [scope.organizationId, scope.creatorProfileId, scope.affiliateId],
      );
      return result.rows.map(mapClaim);
    },
    get: (scope, claimId) => readById(pool, scope, claimId),
    async resolve(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const target = await client.query<{ property_id: string }>(
          `SELECT property_id FROM marketplace.affiliate_discrepancy_claims
           WHERE id=$1 AND ($2::uuid IS NULL OR property_id=$2)
           FOR UPDATE`,
          [input.claimId, input.propertyId],
        );
        if (!target.rows[0]) {
          await client.query("ROLLBACK");
          return { ok: false, code: "not_found" };
        }
        const resolutionId = randomUUID();
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO marketplace.affiliate_discrepancy_resolutions (
             id, claim_id, decision, reason, evidence_references,
             earning_entry_id, payout_id, idempotency_key, actor_user_id,
             actor_organization_id, request_id
           ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            resolutionId,
            input.claimId,
            input.resolution.decision,
            input.resolution.reason,
            JSON.stringify(input.resolution.evidenceReferences),
            input.resolution.earningEntryId,
            input.resolution.payoutId,
            input.idempotencyKey,
            input.actorUserId,
            input.actorOrganizationId,
            input.requestId,
          ],
        );
        const replayed = !inserted.rows[0];
        if (replayed && !(await sameResolution(client, input))) {
          await client.query("ROLLBACK");
          return { ok: false, code: "idempotency_conflict" };
        }
        const claim = await readResolved(client, input.claimId);
        if (!claim) throw new Error("Affiliate discrepancy resolution persistence failed");
        await client.query("COMMIT");
        return { ok: true, claim, replayed };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function readById(
  pool: pg.Pool,
  scope: AffiliateClaimCreatorScope,
  claimId: string,
): Promise<AffiliateClaim | null> {
  const result = await pool.query<ClaimRow>(
    `${selectClaim}
     WHERE claim.id=$1 AND claim.creator_organization_id=$2
       AND claim.creator_profile_id=$3 AND claim.affiliate_id=$4`,
    [claimId, scope.organizationId, scope.creatorProfileId, scope.affiliateId],
  );
  return result.rows[0] ? mapClaim(result.rows[0]) : null;
}

async function readDuplicate(
  pool: pg.Pool,
  input: Parameters<AffiliateDiscrepancyRepository["submit"]>[0],
): Promise<AffiliateClaim | null> {
  const result = await pool.query<ClaimRow>(
    `${selectClaim}
     WHERE claim.creator_organization_id=$1 AND claim.creator_profile_id=$2
       AND claim.affiliate_id=$3 AND claim.kind=$4 AND claim.agreement_id=$5
       AND claim.booking_id=$6 AND claim.payout_id IS NOT DISTINCT FROM $7::uuid`,
    [
      input.scope.organizationId,
      input.scope.creatorProfileId,
      input.scope.affiliateId,
      input.kind,
      input.agreementId,
      input.bookingId,
      input.payoutId,
    ],
  );
  return result.rows[0] ? mapClaim(result.rows[0]) : null;
}

function mapClaim(row: ClaimRow): AffiliateClaim {
  return {
    claimId: row.claim_id,
    kind: row.kind,
    status: row.status,
    agreementId: row.agreement_id,
    propertyId: row.property_id,
    bookingReference: row.booking_reference,
    payoutId: row.payout_id,
    message: row.message,
    evidenceReferences: references(row.evidence_references),
    decisionReason: row.decision_reason,
    decisionEvidenceReferences: references(row.decision_evidence_references),
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}

function references(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Stored affiliate discrepancy evidence is invalid");
  }
  return value;
}

async function sameResolution(
  client: pg.PoolClient,
  input: Parameters<AffiliateDiscrepancyRepository["resolve"]>[0],
): Promise<boolean> {
  const result = await client.query<{ matches: boolean }>(
    `SELECT decision=$2 AND reason=$3 AND evidence_references=$4::jsonb
       AND earning_entry_id IS NOT DISTINCT FROM $5::uuid
       AND payout_id IS NOT DISTINCT FROM $6::uuid
       AND actor_organization_id=$7 AND idempotency_key=$8 AS matches
     FROM marketplace.affiliate_discrepancy_resolutions WHERE claim_id=$1`,
    [
      input.claimId,
      input.resolution.decision,
      input.resolution.reason,
      JSON.stringify(input.resolution.evidenceReferences),
      input.resolution.earningEntryId,
      input.resolution.payoutId,
      input.actorOrganizationId,
      input.idempotencyKey,
    ],
  );
  return result.rows[0]?.matches === true;
}

async function readResolved(
  client: pg.PoolClient,
  claimId: string,
): Promise<AffiliateClaim | null> {
  const result = await client.query<ClaimRow>(`${selectClaim} WHERE claim.id=$1`, [claimId]);
  return result.rows[0] ? mapClaim(result.rows[0]) : null;
}
