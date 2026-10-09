import { createHash } from "node:crypto";

import type pg from "pg";

import { deterministicUuid } from "./productionBookingValues.js";
import {
  COHORT_READINESS_CRITERIA,
  readCohortReadiness,
  readyForActivation,
  type CohortReadinessCriterion,
} from "./productionPmsCohortReadiness.js";

type QueryClient = Pick<pg.ClientBase, "query">;
const OPERATION = "platform.property.lifecycle.status";
/** PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION (@vayada/domain-hotels). */
export const LIFECYCLE_CONTRACT_VERSION = "platform-property-lifecycle.v1";

export type CohortReadinessSummary = {
  cohortProperties: number;
  active: number;
  provisioning: number;
  /** Provisioning cohort properties missing each criterion; one can miss several. */
  missing: Record<CohortReadinessCriterion, number>;
};
export type CohortActivationReport = CohortReadinessSummary & { activated: number };

/**
 * VAY-1362 (vay2066 coordinator caution 1): after the PMS writes, a carried cohort property whose
 * profile is complete and that meets every setup-completeness criterion a-g on the target becomes
 * lifecycle 'active', as the native lifecycle command activates one
 * (platformPropertyLifecycleCommandRepository: lifecycle_revision + 1, pre-hold status cleared,
 * an idempotency key and an audit row). Anything else stays as it is: a property missing an item
 * stays 'provisioning', and a suspended or retired one is never touched. updated_at is kept, so
 * the catalog's freshness reconciliation keeps comparing the migrated profile.
 */
export async function activateReadyCohortProperties(
  client: QueryClient,
  input: { sourceRunId: string; completedAt: string; propertyIds: string[] },
): Promise<CohortActivationReport> {
  const propertyIds = [...new Set(input.propertyIds)].sort();
  await lockCohortProperties(client, propertyIds);
  const before = await readCohortReadiness(client, propertyIds);
  const ready = before.filter(
    (row) => row.lifecycleStatus === "provisioning" && readyForActivation(row),
  );
  for (const row of ready) await activate(client, input, row.propertyId);
  const after = await readCohortReadiness(client, propertyIds);
  for (const row of ready) {
    const current = after.find((entry) => entry.propertyId === row.propertyId);
    if (current?.lifecycleStatus !== "active" || !readyForActivation(current))
      throw new Error("Post-write cohort activation does not match the readiness evaluation");
  }
  return { ...summarizeCohortReadiness(after), activated: ready.length };
}

/** The import's cohort properties stay locked from before their setup rows are written until
 * the commit. FOR NO KEY UPDATE still serializes with the native settings writers (persistSetting:
 * FOR UPDATE OF property) and lifecycle commands, but not with inserts that only reference a
 * property (KEY SHARE). */
export async function lockCohortProperties(
  client: QueryClient,
  propertyIds: string[],
): Promise<void> {
  if (!propertyIds.length) return;
  await client.query(
    `SELECT id FROM hotel_catalog.properties WHERE id = ANY($1::uuid[]) ORDER BY id
        FOR NO KEY UPDATE`,
    [propertyIds],
  );
}

/** Cohort properties by lifecycle, and how many miss each readiness item. */
export function summarizeCohortReadiness(
  rows: Awaited<ReturnType<typeof readCohortReadiness>>,
): CohortReadinessSummary {
  const provisioning = rows.filter((row) => row.lifecycleStatus === "provisioning");
  const missing = Object.fromEntries(
    COHORT_READINESS_CRITERIA.map((criterion) => [
      criterion,
      provisioning.filter((row) => !row[criterion]).length,
    ]),
  ) as Record<CohortReadinessCriterion, number>;
  return {
    cohortProperties: rows.length,
    active: rows.filter((row) => row.lifecycleStatus === "active").length,
    provisioning: provisioning.length,
    missing,
  };
}

async function activate(
  client: QueryClient,
  input: { sourceRunId: string; completedAt: string },
  propertyId: string,
): Promise<void> {
  const at = new Date(input.completedAt).toISOString();
  const idempotencyId = deterministicUuid(
    "production-pms",
    "cohort-activation",
    input.sourceRunId,
    propertyId,
  );
  const updated = await client.query<{ lifecycleRevision: string }>(
    `UPDATE hotel_catalog.properties
        SET lifecycle_status = 'active', lifecycle_revision = lifecycle_revision + 1,
            pre_hold_profile_status = NULL
      WHERE id = $1::uuid AND lifecycle_status = 'provisioning' AND profile_status = 'complete'
        AND cardinality(completeness_reasons) = 0
     RETURNING lifecycle_revision::text AS "lifecycleRevision"`,
    [propertyId],
  );
  if (updated.rowCount !== 1) throw new Error("Cohort property activation lost its lock");
  const result = {
    contractVersion: LIFECYCLE_CONTRACT_VERSION,
    propertyId,
    lifecycleStatus: "active",
    lifecycleRevision: Number(updated.rows[0]!.lifecycleRevision),
  };
  const key = sha256Hex(`vay1362-migration:${input.sourceRunId}:activation:${propertyId}`);
  await client.query(
    `INSERT INTO platform.idempotency_keys (
       id, operation_scope, operation, key_hash, request_fingerprint_hash, status, tenant_scope,
       property_id, response_status_code, response_body_hash, response_resource_product,
       response_resource_type, response_resource_id, correlation_id, first_seen_at, last_seen_at,
       completed_at, expires_at, idempotency_metadata
     ) VALUES ($1::uuid, 'hotel_catalog', $2, $3, $4, 'completed', 'property', $5::uuid, 200, $6,
       'hotel_catalog', 'property', $5, $7, $8::timestamptz, $8::timestamptz, $8::timestamptz,
       $8::timestamptz + interval '24 hours', jsonb_build_object('result', $9::jsonb))`,
    [
      idempotencyId,
      OPERATION,
      key,
      sha256Hex(JSON.stringify({ propertyId, status: "active", reason: "vay1362_cohort_ready" })),
      propertyId,
      sha256Hex(JSON.stringify(result)),
      `vay1362-migration:${input.sourceRunId}`,
      at,
      JSON.stringify(result),
    ],
  );
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
       target_resource_product, target_resource_type, target_resource_id, idempotency_key_id,
       correlation_id, causation_id, redacted_payload, private_payload, audit_metadata,
       privacy_scope
     ) VALUES ($1, 'hotel_catalog', $2, $3::timestamptz, 'property', $4::uuid, 'migration',
       'hotel_catalog', 'property', $4, $5::uuid, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
       'confidential')`,
    [
      `platform-property-lifecycle:${idempotencyId}`,
      OPERATION,
      at,
      propertyId,
      idempotencyId,
      `vay1362-migration:${input.sourceRunId}`,
      input.sourceRunId,
      JSON.stringify({ status: "active", revision: result.lifecycleRevision }),
      JSON.stringify({ reason: "vay1362_cohort_ready" }),
      JSON.stringify({
        contractVersion: LIFECYCLE_CONTRACT_VERSION,
        migrationRunId: input.sourceRunId,
        criteria: "vay2066-a-g",
      }),
    ],
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
