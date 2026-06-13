import { createHash } from "node:crypto";

import type { FinanceRoutePaymentProvider } from "@vayada/domain-finance";
import pg from "pg";

export const FINANCE_PROPERTY_PAYOUT_DISPATCH_QUEUE = "finance-property-payout-dispatch";
export const DEFAULT_FINANCE_PROPERTY_PAYOUT_DISPATCH_LIMIT = 100;

export type FinancePropertyPayoutDispatchCandidate = {
  payoutId: string;
  propertyId: string;
  amount: string;
  currency: string;
  provider: Extract<FinanceRoutePaymentProvider, "stripe" | "xendit">;
  providerAccountId: string;
  retryCount: number;
  maxAttempts: number;
  scheduledAt: string;
  reconciliationReady: boolean;
  legacySchedulerFrozen: boolean;
  activeLegacyTransferWindow: boolean;
  providerPayoutId: string | null;
};

export type FinancePropertyPayoutDispatchContext = {
  now: Date;
  workerId: string;
  correlationId: string;
};

export type FinancePayoutProviderSuccess = {
  ok: true;
  providerPayoutId: string;
  providerRequestId: string;
  status: "processing" | "paid";
};

export type FinancePayoutProviderFailure = {
  ok: false;
  providerRequestId?: string;
  retryable: boolean;
  errorCategory:
    | "provider_429"
    | "provider_5xx"
    | "network_timeout"
    | "provider_rejected"
    | "validation_failed";
  message: string;
};

export type FinancePayoutProviderResult =
  | FinancePayoutProviderSuccess
  | FinancePayoutProviderFailure;

export type FinancePayoutProvider = {
  dispatchPropertyPayout(
    candidate: FinancePropertyPayoutDispatchCandidate,
    context: FinancePropertyPayoutDispatchContext,
  ): Promise<FinancePayoutProviderResult>;
};

export type FinancePayoutProviderAttemptRecord = {
  payoutId: string;
  propertyId: string;
  provider: FinancePropertyPayoutDispatchCandidate["provider"];
  attemptNumber: number;
  idempotencyKey: string;
  requestPayloadHash: string;
  status: "succeeded" | "failed" | "skipped";
  providerPayoutId: string | null;
  providerRequestId: string | null;
  errorCategory: FinancePayoutProviderFailure["errorCategory"] | null;
  errorMessage: string | null;
  retryable: boolean;
  recordedAt: string;
  workerId: string;
};

export type FinancePropertyPayoutDispatchMutationResult = {
  payoutId: string;
  propertyId: string;
  status: "dispatched" | "retry_scheduled" | "failed";
  providerPayoutId: string | null;
};

export type FinancePropertyPayoutDispatcherStore = {
  findDuePropertyPayoutDispatchCandidates(
    now: Date,
    limit: number,
  ): Promise<FinancePropertyPayoutDispatchCandidate[]>;
  claimPropertyPayoutDispatch(
    candidate: FinancePropertyPayoutDispatchCandidate,
    context: FinancePropertyPayoutDispatchContext,
  ): Promise<boolean>;
  recordProviderAttempt(attempt: FinancePayoutProviderAttemptRecord): Promise<void>;
  markPropertyPayoutDispatched(
    candidate: FinancePropertyPayoutDispatchCandidate,
    result: FinancePayoutProviderSuccess,
    attempt: FinancePayoutProviderAttemptRecord,
    context: FinancePropertyPayoutDispatchContext,
  ): Promise<FinancePropertyPayoutDispatchMutationResult>;
  markPropertyPayoutDispatchFailed(
    candidate: FinancePropertyPayoutDispatchCandidate,
    result: FinancePayoutProviderFailure,
    attempt: FinancePayoutProviderAttemptRecord,
    context: FinancePropertyPayoutDispatchContext,
  ): Promise<FinancePropertyPayoutDispatchMutationResult>;
};

export type FinancePropertyPayoutDispatcherOptions = {
  now?: Date;
  workerId?: string;
  limit?: number;
};

export type PgFinancePropertyPayoutDispatcherStoreConfig = {
  connectionString: string;
  max?: number;
};

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type PropertyPayoutCandidateRow = {
  payoutId: string;
  propertyId: string;
  amount: string;
  currency: string;
  provider: "stripe" | "xendit";
  providerAccountId: string;
  retryCount: number;
  maxAttempts: number | null;
  scheduledAt: Date | string;
  reconciliationReady: boolean | null;
  legacySchedulerFrozen: boolean | null;
  activeLegacyTransferWindow: boolean | null;
  providerPayoutId: string | null;
};

export type FinancePropertyPayoutDispatcherSkipReason =
  | "reconciliation_not_ready"
  | "legacy_scheduler_not_frozen"
  | "active_legacy_transfer_window"
  | "payout_already_dispatched"
  | "dispatch_claim_conflict";

export type FinancePropertyPayoutDispatcherSkipped = {
  payoutId: string;
  propertyId: string;
  reason: FinancePropertyPayoutDispatcherSkipReason;
};

export type FinancePropertyPayoutDispatcherResult = {
  scanned: number;
  dispatched: number;
  retryScheduled: number;
  failed: number;
  skipped: FinancePropertyPayoutDispatcherSkipped[];
  attempts: FinancePayoutProviderAttemptRecord[];
};

export async function runFinancePropertyPayoutDispatcher(
  store: FinancePropertyPayoutDispatcherStore,
  provider: FinancePayoutProvider,
  options: FinancePropertyPayoutDispatcherOptions = {},
): Promise<FinancePropertyPayoutDispatcherResult> {
  const now = options.now ?? new Date();
  const context: FinancePropertyPayoutDispatchContext = {
    now,
    workerId: options.workerId ?? "finance-property-payout-dispatcher",
    correlationId: `finance.dispatch-property-payout:${now.toISOString()}`,
  };
  const candidates = await store.findDuePropertyPayoutDispatchCandidates(
    now,
    options.limit ?? DEFAULT_FINANCE_PROPERTY_PAYOUT_DISPATCH_LIMIT,
  );
  const skipped: FinancePropertyPayoutDispatcherSkipped[] = [];
  const attempts: FinancePayoutProviderAttemptRecord[] = [];
  let dispatched = 0;
  let retryScheduled = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const skipReason = propertyPayoutDispatchBlocker(candidate);
    if (skipReason) {
      skipped.push({
        payoutId: candidate.payoutId,
        propertyId: candidate.propertyId,
        reason: skipReason,
      });
      continue;
    }

    const claimed = await store.claimPropertyPayoutDispatch(candidate, context);
    if (!claimed) {
      skipped.push({
        payoutId: candidate.payoutId,
        propertyId: candidate.propertyId,
        reason: "dispatch_claim_conflict",
      });
      continue;
    }

    const providerResult = await provider.dispatchPropertyPayout(candidate, context);
    const attempt = buildProviderAttempt(candidate, providerResult, context);
    attempts.push(attempt);
    await store.recordProviderAttempt(attempt);

    if (providerResult.ok) {
      const mutation = await store.markPropertyPayoutDispatched(
        candidate,
        providerResult,
        attempt,
        context,
      );
      if (mutation.status === "dispatched") dispatched += 1;
      continue;
    }

    const mutation = await store.markPropertyPayoutDispatchFailed(
      candidate,
      providerResult,
      attempt,
      context,
    );
    if (mutation.status === "retry_scheduled") retryScheduled += 1;
    if (mutation.status === "failed") failed += 1;
  }

  return {
    scanned: candidates.length,
    dispatched,
    retryScheduled,
    failed,
    skipped,
    attempts,
  };
}

export function createPgFinancePropertyPayoutDispatcherStore(
  config: PgFinancePropertyPayoutDispatcherStoreConfig,
): FinancePropertyPayoutDispatcherStore & { close(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findDuePropertyPayoutDispatchCandidates(now, limit) {
      return selectDuePropertyPayoutDispatchCandidates(pool, now, limit);
    },
    async claimPropertyPayoutDispatch(candidate, context) {
      return claimPropertyPayoutDispatch(pool, candidate, context);
    },
    async recordProviderAttempt(attempt) {
      await insertProviderAttempt(pool, attempt);
    },
    async markPropertyPayoutDispatched(candidate, result, attempt, context) {
      return markPropertyPayoutDispatched(pool, candidate, result, attempt, context);
    },
    async markPropertyPayoutDispatchFailed(candidate, result, attempt, context) {
      return markPropertyPayoutDispatchFailed(pool, candidate, result, attempt, context);
    },
    async close() {
      await pool.end();
    },
  };
}

export function propertyPayoutDispatchBlocker(
  candidate: FinancePropertyPayoutDispatchCandidate,
): FinancePropertyPayoutDispatcherSkipReason | null {
  if (!candidate.reconciliationReady) return "reconciliation_not_ready";
  if (!candidate.legacySchedulerFrozen) return "legacy_scheduler_not_frozen";
  if (candidate.activeLegacyTransferWindow) return "active_legacy_transfer_window";
  if (candidate.providerPayoutId) return "payout_already_dispatched";
  return null;
}

export function buildPropertyPayoutDispatchJobKey(input: {
  propertyId: string;
  payoutId: string;
}): string {
  return `finance.dispatch-property-payout:property:${input.propertyId}:payout:${input.payoutId}:v1`;
}

async function selectDuePropertyPayoutDispatchCandidates(
  db: Queryable,
  now: Date,
  limit: number,
): Promise<FinancePropertyPayoutDispatchCandidate[]> {
  const result = await db.query<PropertyPayoutCandidateRow>(
    `SELECT
       payout.id::text AS "payoutId",
       payout.property_id::text AS "propertyId",
       payout.amount::text,
       payout.currency,
       account.provider,
       account.provider_account_id AS "providerAccountId",
       payout.retry_count AS "retryCount",
       COALESCE((payout.payout_metadata ->> 'maxDispatchAttempts')::int, 3) AS "maxAttempts",
       payout.scheduled_at AS "scheduledAt",
       (
         payout.payout_metadata ? 'reconciliationReadyAt'
         AND COALESCE(reconciliation.blockers, 0) = 0
       ) AS "reconciliationReady",
       (payout.payout_metadata ? 'legacyPropertyPayoutSchedulerFrozenAt')
         AS "legacySchedulerFrozen",
       COALESCE((payout.payout_metadata ->> 'activeLegacyTransferWindow')::boolean, false)
         AS "activeLegacyTransferWindow",
       payout.provider_payout_id AS "providerPayoutId"
     FROM finance.payouts payout
     JOIN finance.payment_provider_accounts account
       ON account.id = payout.property_provider_account_id
      AND account.property_id = payout.property_id
      AND account.account_scope = 'property'
      AND account.provider IN ('stripe', 'xendit')
      AND account.status = 'active'
      AND account.payouts_enabled = TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS blockers
       FROM platform.jobs job
       WHERE job.tenant_scope = 'property'
         AND job.property_id = payout.property_id
         AND job.resource_product = 'finance'
         AND job.resource_type = 'payout'
         AND job.resource_id IN (
           payout.id::text,
           COALESCE(payout.provider_payout_id, ''),
           payout.property_id::text
         )
         AND job.job_type = 'finance.reconcile-payout'
         AND job.status IN ('pending', 'running', 'failed', 'dead_lettered')
     ) reconciliation ON TRUE
     WHERE payout.owner_scope = 'property'
       AND payout.payout_status IN ('pending', 'scheduled', 'failed')
       AND payout.provider_payout_id IS NULL
       AND COALESCE(payout.scheduled_at, payout.created_at) <= $1::timestamptz
       AND payout.retry_count < COALESCE((payout.payout_metadata ->> 'maxDispatchAttempts')::int, 3)
     ORDER BY COALESCE(payout.scheduled_at, payout.created_at), payout.id
     LIMIT $2`,
    [now.toISOString(), limit],
  );
  return result.rows.map((row) => ({
    payoutId: row.payoutId,
    propertyId: row.propertyId,
    amount: row.amount,
    currency: row.currency,
    provider: row.provider,
    providerAccountId: row.providerAccountId,
    retryCount: row.retryCount,
    maxAttempts: row.maxAttempts ?? 3,
    scheduledAt: dateString(row.scheduledAt),
    reconciliationReady: Boolean(row.reconciliationReady),
    legacySchedulerFrozen: Boolean(row.legacySchedulerFrozen),
    activeLegacyTransferWindow: Boolean(row.activeLegacyTransferWindow),
    providerPayoutId: row.providerPayoutId,
  }));
}

async function insertProviderAttempt(
  db: Queryable,
  attempt: FinancePayoutProviderAttemptRecord,
): Promise<void> {
  await db.query(
    `INSERT INTO platform.job_attempts (
       job_id,
       attempt_number,
       status,
       worker_id,
       started_at,
       finished_at,
       error_type,
       error_message,
       error_metadata
     )
     SELECT
       job.id,
       $2,
       $3,
       $4,
       $5::timestamptz,
       $5::timestamptz,
       $6,
       $7,
       $8::jsonb
     FROM platform.jobs job
     WHERE job.queue_name = $9
       AND job.job_key = $1
     ON CONFLICT (job_id, attempt_number) DO NOTHING`,
    [
      attempt.idempotencyKey,
      attempt.attemptNumber,
      attempt.status === "succeeded" ? "succeeded" : "failed",
      attempt.workerId,
      attempt.recordedAt,
      attempt.errorCategory,
      attempt.errorMessage,
      JSON.stringify({
        provider: attempt.provider,
        providerRequestId: attempt.providerRequestId,
        providerPayoutId: attempt.providerPayoutId,
        requestPayloadHash: attempt.requestPayloadHash,
        retryable: attempt.retryable,
      }),
      FINANCE_PROPERTY_PAYOUT_DISPATCH_QUEUE,
    ],
  );
}

async function claimPropertyPayoutDispatch(
  db: Queryable,
  candidate: FinancePropertyPayoutDispatchCandidate,
  context: FinancePropertyPayoutDispatchContext,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE finance.payouts
     SET payout_status = 'processing',
         updated_at = $1::timestamptz,
         payout_metadata = payout_metadata || $2::jsonb
     WHERE id = $3::uuid
       AND property_id = $4::uuid
       AND provider_payout_id IS NULL
       AND payout_status IN ('pending', 'scheduled', 'failed')
     RETURNING id`,
    [
      context.now.toISOString(),
      JSON.stringify({
        dispatchClaimedAt: context.now.toISOString(),
        dispatchWorkerId: context.workerId,
        dispatchJobKey: buildPropertyPayoutDispatchJobKey(candidate),
      }),
      candidate.payoutId,
      candidate.propertyId,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function markPropertyPayoutDispatched(
  db: Queryable,
  candidate: FinancePropertyPayoutDispatchCandidate,
  result: FinancePayoutProviderSuccess,
  attempt: FinancePayoutProviderAttemptRecord,
  context: FinancePropertyPayoutDispatchContext,
): Promise<FinancePropertyPayoutDispatchMutationResult> {
  await db.query(
    `UPDATE finance.payouts
     SET payout_status = $1,
         provider_payout_id = $2,
         retry_count = GREATEST(retry_count, $3),
         updated_at = $4::timestamptz,
         payout_metadata = payout_metadata || $5::jsonb
     WHERE id = $6::uuid
       AND property_id = $7::uuid
       AND provider_payout_id IS NULL`,
    [
      result.status,
      result.providerPayoutId,
      attempt.attemptNumber,
      context.now.toISOString(),
      JSON.stringify({
        lastDispatchAttemptAt: attempt.recordedAt,
        lastDispatchWorkerId: context.workerId,
        providerRequestId: result.providerRequestId,
      }),
      candidate.payoutId,
      candidate.propertyId,
    ],
  );
  await markDispatchJobFinished(db, candidate, "succeeded", context);
  return {
    payoutId: candidate.payoutId,
    propertyId: candidate.propertyId,
    status: "dispatched",
    providerPayoutId: result.providerPayoutId,
  };
}

async function markPropertyPayoutDispatchFailed(
  db: Queryable,
  candidate: FinancePropertyPayoutDispatchCandidate,
  result: FinancePayoutProviderFailure,
  attempt: FinancePayoutProviderAttemptRecord,
  context: FinancePropertyPayoutDispatchContext,
): Promise<FinancePropertyPayoutDispatchMutationResult> {
  const exhausted = !result.retryable || attempt.attemptNumber >= candidate.maxAttempts;
  await db.query(
    `UPDATE finance.payouts
     SET payout_status = $1,
         retry_count = GREATEST(retry_count, $2),
         failure_code = $3,
         failed_at = CASE WHEN $1 = 'failed' THEN $4::timestamptz ELSE failed_at END,
         updated_at = $4::timestamptz,
         payout_metadata = payout_metadata || $5::jsonb
     WHERE id = $6::uuid
       AND property_id = $7::uuid
       AND provider_payout_id IS NULL`,
    [
      exhausted ? "failed" : "scheduled",
      attempt.attemptNumber,
      result.errorCategory,
      context.now.toISOString(),
      JSON.stringify({
        lastDispatchAttemptAt: attempt.recordedAt,
        lastDispatchWorkerId: context.workerId,
        providerRequestId: result.providerRequestId ?? null,
        retryable: result.retryable,
        rollbackRule:
          "No provider payout id was recorded; legacy may only be re-enabled after reconciliation confirms no successful target transfer.",
      }),
      candidate.payoutId,
      candidate.propertyId,
    ],
  );
  await markDispatchJobFinished(db, candidate, exhausted ? "failed" : "pending", context);
  return {
    payoutId: candidate.payoutId,
    propertyId: candidate.propertyId,
    status: exhausted ? "failed" : "retry_scheduled",
    providerPayoutId: null,
  };
}

async function markDispatchJobFinished(
  db: Queryable,
  candidate: FinancePropertyPayoutDispatchCandidate,
  status: "succeeded" | "failed" | "pending",
  context: FinancePropertyPayoutDispatchContext,
): Promise<void> {
  await db.query(
    `UPDATE platform.jobs
     SET status = $1,
         attempts_count = attempts_count + 1,
         run_after = CASE WHEN $1 = 'pending' THEN $2::timestamptz + interval '15 minutes' ELSE run_after END,
         finished_at = CASE WHEN $1 IN ('succeeded', 'failed') THEN $2::timestamptz ELSE NULL END,
         updated_at = $2::timestamptz
     WHERE queue_name = $3
       AND job_key = $4`,
    [
      status,
      context.now.toISOString(),
      FINANCE_PROPERTY_PAYOUT_DISPATCH_QUEUE,
      buildPropertyPayoutDispatchJobKey(candidate),
    ],
  );
}

function buildProviderAttempt(
  candidate: FinancePropertyPayoutDispatchCandidate,
  result: FinancePayoutProviderResult,
  context: FinancePropertyPayoutDispatchContext,
): FinancePayoutProviderAttemptRecord {
  return {
    payoutId: candidate.payoutId,
    propertyId: candidate.propertyId,
    provider: candidate.provider,
    attemptNumber: candidate.retryCount + 1,
    idempotencyKey: buildPropertyPayoutDispatchJobKey(candidate),
    requestPayloadHash: sha256(
      stableJson({
        payoutId: candidate.payoutId,
        amount: candidate.amount,
        currency: candidate.currency,
        provider: candidate.provider,
        providerAccountId: candidate.providerAccountId,
      }),
    ),
    status: result.ok ? "succeeded" : "failed",
    providerPayoutId: result.ok ? result.providerPayoutId : null,
    providerRequestId: result.providerRequestId ?? null,
    errorCategory: result.ok ? null : result.errorCategory,
    errorMessage: result.ok ? null : result.message,
    retryable: result.ok ? false : result.retryable,
    recordedAt: context.now.toISOString(),
    workerId: context.workerId,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
