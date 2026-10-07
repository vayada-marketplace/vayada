import { randomUUID } from "node:crypto";

import pg from "pg";

import {
  enqueueFinanceExpenseGeneration,
  FINANCE_EXPENSE_GENERATION_JOB_TYPE,
  FINANCE_EXPENSE_GENERATION_QUEUE,
  isFinanceGenerationEnabled,
  runPreactivationOtaCommissionJobs,
} from "./financeExpenseGeneration.js";

const PROPERTY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Candidate = { evidenceId: string; depth: number; total: number };
type JobState = { status: string; count: number };
type Unresolved = {
  evidenceId: string;
  jobId: string | null;
  jobStatus: string | null;
  dispatched: boolean;
  lastErrorCode: string | null;
};

export async function backfillPreactivationOtaCommissions(
  pool: pg.Pool,
  options: { propertyId: string; apply?: boolean; limit?: number; clock?: () => Date },
) {
  const propertyId = options.propertyId.toLowerCase();
  const limit = options.limit ?? 25;
  if (!PROPERTY_ID.test(propertyId) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid_property_or_limit");

  const client = await pool.connect();
  let selected: Candidate[] = [];
  try {
    await client.query(options.apply ? "BEGIN" : "BEGIN READ ONLY");
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
    const property = await client.query(
      `SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid ${options.apply ? "FOR UPDATE" : ""}`,
      [propertyId],
    );
    if (property.rowCount !== 1) throw new Error("property_missing");
    const gate = (
      await client.query<{ eligible: boolean }>(
        `SELECT EXISTS(
          SELECT 1 FROM identity.organization_resource_links link
          JOIN identity.organizations organization ON organization.id=link.organization_id
            AND organization.kind='hotel_group' AND organization.status='active'
          JOIN identity.product_entitlements base ON base.organization_id=link.organization_id
            AND base.product='pms' AND base.entitlement_key='property-management' AND base.status='active'
            AND (base.resource_product IS NULL OR (base.resource_product='pms' AND base.resource_type='pms_property' AND base.resource_id=$1::text))
            AND (base.starts_at IS NULL OR base.starts_at<=now()) AND (base.expires_at IS NULL OR base.expires_at>now())
          WHERE link.product='pms' AND link.resource_type='pms_property' AND link.resource_id=$1::text
            AND link.relationship IN ('owner','finance_manager') AND link.status='active'
            AND NOT EXISTS(SELECT 1 FROM identity.product_entitlements suspension
              WHERE suspension.organization_id=link.organization_id AND suspension.product='pms'
                AND suspension.entitlement_key='property-management' AND suspension.status='suspended'
                AND (suspension.resource_product IS NULL OR (suspension.resource_product='pms' AND suspension.resource_type='pms_property' AND suspension.resource_id=$1::text))
                AND (suspension.starts_at IS NULL OR suspension.starts_at<=now()) AND (suspension.expires_at IS NULL OR suspension.expires_at>now()))
        ) AS eligible`,
        [propertyId],
      )
    ).rows[0]!;
    if (!gate.eligible) throw new Error("property_not_finance_eligible");
    if (await isFinanceGenerationEnabled(client, propertyId))
      throw new Error("financials_already_active");

    selected = (
      await client.query<Candidate>(
        `WITH RECURSIVE lineage AS (
          SELECT evidence.id,0 AS depth FROM finance.ota_commission_evidence evidence
          WHERE evidence.property_id=$1::uuid AND evidence.corrects_commission_evidence_id IS NULL
          UNION ALL
          SELECT evidence.id,lineage.depth+1 FROM finance.ota_commission_evidence evidence
          JOIN lineage ON lineage.id=evidence.corrects_commission_evidence_id
          WHERE evidence.property_id=$1::uuid
        ), pending AS (
          SELECT evidence.id::text AS "evidenceId",lineage.depth,evidence.created_at
          FROM finance.ota_commission_evidence evidence JOIN lineage ON lineage.id=evidence.id
          WHERE evidence.property_id=$1::uuid AND evidence.evidence_state='applied'
            AND evidence.commission_amount<>0
            AND NOT EXISTS(SELECT 1 FROM finance.expenses expense WHERE expense.property_id=$1::uuid
              AND expense.origin='ota_commission' AND (expense.source_key='ota_commission_evidence:'||evidence.id::text
                OR expense.source_key LIKE 'ota_commission_evidence:'||evidence.id::text||':%'))
        ) SELECT "evidenceId",depth,count(*) OVER()::int AS total FROM pending
          ORDER BY depth,created_at,"evidenceId" LIMIT $2`,
        [propertyId, limit],
      )
    ).rows;
    if (options.apply) {
      if (selected.length) {
        const prerequisites = (
          await client.query<{ categoryReady: boolean; currencyReady: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM finance.expense_categories category
                WHERE category.property_id=$1::uuid AND category.system_key='ota_commission'
                  AND category.archived_at IS NULL) AS "categoryReady",
              NOT EXISTS(SELECT 1 FROM finance.ota_commission_evidence evidence
                WHERE evidence.id=ANY($2::uuid[]) AND NOT EXISTS(SELECT 1 FROM pms.property_pricing_settings pricing
                  WHERE pricing.property_id=$1::uuid AND pricing.currency=evidence.currency)) AS "currencyReady"`,
            [propertyId, selected.map((row) => row.evidenceId)],
          )
        ).rows[0]!;
        if (!prerequisites.categoryReady) throw new Error("ota_category_missing_or_archived");
        if (!prerequisites.currencyReady) throw new Error("commission_currency_mismatch");
      }
      const requestedAt = (options.clock ?? (() => new Date()))().toISOString();
      for (const candidate of selected) {
        await enqueueFinanceExpenseGeneration(client, {
          family: "ota_commission",
          propertyId,
          commissionEvidenceId: candidate.evidenceId,
          requestId: `financials-preactivation:${candidate.evidenceId}`,
          correlationId: `financials-preactivation:${propertyId}`,
          causationId: randomUUID(),
          requestedAt,
        });
        const dispatch = await client.query(
          `UPDATE finance.expense_generation_dispatches
            SET dispatched_at=COALESCE(dispatched_at,$3::timestamptz)
            WHERE family='ota_commission' AND evidence_id=$1::uuid AND property_id=$2::uuid
            RETURNING evidence_id`,
          [candidate.evidenceId, propertyId, requestedAt],
        );
        if (dispatch.rowCount !== 1) throw new Error("commission_dispatch_missing");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const counters = options.apply
    ? await runPreactivationOtaCommissionJobs(pool, {
        propertyId,
        evidenceIds: selected.map((row) => row.evidenceId),
        clock: options.clock,
      })
    : null;
  const states = (
    await pool.query<JobState>(
      `SELECT status,count(*)::int AS count FROM platform.jobs WHERE queue_name=$1 AND job_type=$2
        AND property_id=$3::uuid AND resource_type='ota_commission_evidence' GROUP BY status ORDER BY status`,
      [FINANCE_EXPENSE_GENERATION_QUEUE, FINANCE_EXPENSE_GENERATION_JOB_TYPE, propertyId],
    )
  ).rows;
  const dispatchStates = (
    await pool.query<JobState>(
      `SELECT CASE WHEN dispatched_at IS NULL THEN 'undispatched' ELSE 'dispatched' END AS status,
        count(*)::int AS count FROM finance.expense_generation_dispatches
        WHERE family='ota_commission' AND property_id=$1::uuid GROUP BY status ORDER BY status`,
      [propertyId],
    )
  ).rows;
  const pendingAfter = (
    await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM finance.ota_commission_evidence evidence
        WHERE evidence.property_id=$1::uuid AND evidence.evidence_state='applied'
          AND evidence.commission_amount<>0
          AND NOT EXISTS(SELECT 1 FROM finance.expenses expense WHERE expense.property_id=$1::uuid
            AND expense.origin='ota_commission' AND (expense.source_key='ota_commission_evidence:'||evidence.id::text
              OR expense.source_key LIKE 'ota_commission_evidence:'||evidence.id::text||':%'))`,
      [propertyId],
    )
  ).rows[0]!.count;
  const unresolved = (
    await pool.query<Unresolved>(
      `SELECT evidence.id::text AS "evidenceId",job.id::text AS "jobId",
        job.status AS "jobStatus",COALESCE(dispatch.dispatched_at IS NOT NULL,false) AS dispatched,
        job.job_metadata->>'lastErrorCode' AS "lastErrorCode"
      FROM finance.ota_commission_evidence evidence
      LEFT JOIN finance.expense_generation_dispatches dispatch ON dispatch.family='ota_commission'
        AND dispatch.evidence_id=evidence.id AND dispatch.property_id=evidence.property_id
      LEFT JOIN LATERAL (SELECT job.id,job.status,job.job_metadata FROM platform.jobs job
        WHERE job.queue_name=$2 AND job.job_type=$3 AND job.property_id=evidence.property_id
          AND job.resource_type='ota_commission_evidence' AND job.resource_id=evidence.id::text
        ORDER BY job.created_at DESC LIMIT 1) job ON true
      WHERE evidence.property_id=$1::uuid AND evidence.evidence_state='applied'
        AND evidence.commission_amount<>0
        AND NOT EXISTS(SELECT 1 FROM finance.expenses expense WHERE expense.property_id=$1::uuid
          AND expense.origin='ota_commission' AND (expense.source_key='ota_commission_evidence:'||evidence.id::text
            OR expense.source_key LIKE 'ota_commission_evidence:'||evidence.id::text||':%'))
      ORDER BY evidence.created_at,evidence.id LIMIT 100`,
      [propertyId, FINANCE_EXPENSE_GENERATION_QUEUE, FINANCE_EXPENSE_GENERATION_JOB_TYPE],
    )
  ).rows;
  return {
    propertyId,
    mode: options.apply ? "apply" : "dry_run",
    selectedEvidenceIds: selected.map((row) => row.evidenceId),
    pendingAtStart: selected[0]?.total ?? 0,
    pendingAfter,
    unresolved,
    unresolvedTruncated: pendingAfter > unresolved.length,
    selectedCount: selected.length,
    jobStates: states,
    dispatchStates,
    counters,
  };
}
