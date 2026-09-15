import pg from "pg";

/** Internal scoped read; route authorization is supplemented with current DB ownership. */
export async function readAffiliateEvidenceReview(
  database: Pick<pg.Pool, "query">,
  propertyId: string,
  organizationId: string,
  observationId: string,
  after: string | null = null,
) {
  const result = await database.query(
    `WITH original AS (
       SELECT o.* FROM booking.affiliate_evidence_observations o
       JOIN hotel_catalog.properties p ON p.id=o.property_id AND p.profile_status <> 'disabled'
       WHERE o.id=$3 AND o.property_id=$1 AND o.organization_id=$2
         AND EXISTS (SELECT 1 FROM identity.organization_resource_links link
           WHERE link.organization_id=$2 AND link.resource_id=$1::text
             AND link.product='marketplace' AND link.resource_type='hotel_profile'
             AND link.status='active' AND link.relationship IN ('owner','operator'))
         AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM booking.affiliate_evidence_deliveries c
           WHERE c.id=$4 AND c.observation_id=o.id))
     ), page AS (
       SELECT d.id,d.received_at AS "receivedAt",d.mapping_version AS "mappingVersion",d.snapshot,
         d.fact_digest<>o.fact_digest AS "factConflict",
         ((d.snapshot->'provenance')-'evidenceReference') IS DISTINCT FROM
           ((o.snapshot->'provenance')-'evidenceReference') AS "provenanceChanged"
       FROM booking.affiliate_evidence_deliveries d JOIN original o ON o.id=d.observation_id
       WHERE $4::uuid IS NULL OR (d.received_at,d.id)<(
         SELECT c.received_at,c.id FROM booking.affiliate_evidence_deliveries c
         WHERE c.id=$4 AND c.observation_id=o.id)
       ORDER BY d.received_at DESC,d.id DESC LIMIT 51
     )
     SELECT o.id AS "observationId",o.received_at AS "receivedAt",o.snapshot,
       o.connection_id AS "connectionId",o.mapping_version AS "mappingVersion",
       EXISTS (SELECT 1 FROM booking.affiliate_evidence_deliveries d WHERE d.observation_id=o.id
         AND (d.fact_digest<>o.fact_digest OR
           ((d.snapshot->'provenance')-'evidenceReference') IS DISTINCT FROM
           ((o.snapshot->'provenance')-'evidenceReference'))) AS "reviewRequired",
       COALESCE((SELECT jsonb_agg(page ORDER BY "receivedAt" DESC,id DESC) FROM page),'[]'::jsonb) AS deliveries
     FROM original o`,
    [propertyId, organizationId, observationId, after],
  );
  const row = result.rows[0];
  if (!row) return null;
  const deliveries = row.deliveries.slice(0, 50);
  return { ...row, deliveries, nextCursor: row.deliveries.length > 50 ? deliveries[49].id : null };
}

export function createPgAffiliateEvidenceReviewRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 3 });
  return {
    read: (
      propertyId: string,
      organizationId: string,
      observationId: string,
      after: string | null,
    ) => readAffiliateEvidenceReview(pool, propertyId, organizationId, observationId, after),
    close: () => pool.end(),
  };
}
export type AffiliateEvidenceReviewRepository = ReturnType<
  typeof createPgAffiliateEvidenceReviewRepository
>;
