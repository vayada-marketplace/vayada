import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  identifyAffiliateEvidenceReplay,
  parseAffiliateBookingEvidence,
  type AffiliateBookingEvidenceObservation,
  type AffiliateEvidenceBinding,
  type matchesAffiliateEvidenceBinding,
} from "@vayada/domain-booking";

type Authority = {
  binding: AffiliateEvidenceBinding;
  evidence: Parameters<typeof matchesAffiliateEvidenceBinding>[2];
  mappingVersion: string;
};
/** Server-owned dependency: reauthorize and lock scope/reference rows until commit. */
export type ResolveAffiliateEvidenceAuthority = (
  client: pg.PoolClient,
  observation: AffiliateBookingEvidenceObservation,
) => Promise<Authority | null>;
type Result =
  | {
      outcome: "accepted" | "duplicate";
      observationId: string;
      receivedAt: string;
      processing: "pending" | "review";
    }
  | {
      outcome: "rejected";
      code: "invalid_contract" | "unauthorized_connection" | "event_key_conflict";
    };

/** Internal intake only; no acknowledgement before commit and no attribution effects. */
export async function ingestAffiliateEvidence(
  pool: pg.Pool,
  input: unknown,
  resolveAuthority: ResolveAffiliateEvidenceAuthority,
): Promise<Result> {
  const observation = parseAffiliateBookingEvidence(input);
  if (!observation) return { outcome: "rejected", code: "invalid_contract" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const authority = await resolveAuthority(client, structuredClone(observation));
    const identity =
      authority &&
      identifyAffiliateEvidenceReplay(
        observation,
        authority.binding,
        authority.evidence,
        authority.mappingVersion,
      );
    if (!identity || !authority) {
      await client.query("ROLLBACK");
      return { outcome: "rejected", code: "unauthorized_connection" };
    }
    const { organizationId, propertyId } = authority.binding;
    const snapshot = JSON.stringify(observation);
    const inserted = await client.query(
      `INSERT INTO booking.affiliate_evidence_observations
       (id,organization_id,property_id,delivery_key,fact_digest,mapping_version,snapshot,connection_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (delivery_key) DO NOTHING RETURNING id`,
      [
        randomUUID(),
        organizationId,
        propertyId,
        identity.deliveryKey,
        identity.factDigest,
        authority.mappingVersion,
        snapshot,
        authority.binding.connectionId,
      ],
    );
    const original = (
      await client.query(
        `SELECT id,received_at,fact_digest FROM booking.affiliate_evidence_observations
       WHERE delivery_key=$1 AND organization_id=$2 AND property_id=$3 FOR UPDATE`,
        [identity.deliveryKey, organizationId, propertyId],
      )
    ).rows[0];
    if (!original) throw new Error("Affiliate evidence scope mismatch");
    await client.query(
      `INSERT INTO booking.affiliate_evidence_deliveries
       (id,observation_id,organization_id,property_id,fact_digest,mapping_version,snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        original.id,
        organizationId,
        propertyId,
        identity.factDigest,
        authority.mappingVersion,
        snapshot,
      ],
    );
    const review = (
      await client.query(
        `SELECT EXISTS (
         SELECT 1 FROM booking.affiliate_evidence_deliveries delivery
         JOIN booking.affiliate_evidence_observations original ON original.id=delivery.observation_id
         WHERE original.id=$1 AND (delivery.fact_digest <> original.fact_digest OR
           ((delivery.snapshot->'provenance') - 'evidenceReference') IS DISTINCT FROM
           ((original.snapshot->'provenance') - 'evidenceReference'))
       ) AS required`,
        [original.id],
      )
    ).rows[0].required;
    await client.query("COMMIT");
    if (original.fact_digest !== identity.factDigest)
      return { outcome: "rejected", code: "event_key_conflict" };
    return {
      outcome: inserted.rowCount ? "accepted" : "duplicate",
      observationId: original.id,
      receivedAt: original.received_at.toISOString(),
      processing: review ? "review" : "pending",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
