import { createHash } from "node:crypto";

import type {
  FinanceAffiliatePayoutProvider,
  FinanceRoutePaymentProvider,
} from "@vayada/domain-finance";
import pg from "pg";

export const FINANCE_PROPERTY_PAYOUT_DISPATCH_QUEUE = "finance-property-payout-dispatch";
export const FINANCE_AFFILIATE_PAYOUT_DISPATCH_QUEUE = "finance-affiliate-payout-dispatch";
export const DEFAULT_FINANCE_PROPERTY_PAYOUT_DISPATCH_LIMIT = 100;
export const DEFAULT_FINANCE_AFFILIATE_PAYOUT_DISPATCH_LIMIT = 100;

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

export type FinanceAffiliatePayoutDispatchCandidate = {
  payoutId: string;
  affiliateId: string;
  organizationId: string;
  amount: string;
  currency: string;
  provider: FinanceAffiliatePayoutProvider;
  providerAccountId: string | null;
  retryCount: number;
  maxAttempts: number;
  scheduledAt: string;
  payoutSchedule: "manual" | "monthly" | "threshold";
  affiliateResourceLinked: boolean;
  legacySchedulerFrozen: boolean;
  notificationAuditReady: boolean;
  providerPayoutId: string | null;
};

export type FinanceAffiliatePayoutDispatchContext = FinancePropertyPayoutDispatchContext;

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

export type FinanceAffiliatePayoutProviderClient = {
  dispatchAffiliatePayout(
    candidate: FinanceAffiliatePayoutDispatchCandidate,
    context: FinanceAffiliatePayoutDispatchContext,
  ): Promise<FinancePayoutProviderResult>;
};

export type FinancePayoutProviderAttemptRecord = {
  payoutId: string;
  propertyId: string | null;
  affiliateId?: string;
  organizationId?: string;
  provider: FinancePropertyPayoutDispatchCandidate["provider"] | FinanceAffiliatePayoutProvider;
  attemptNumber: number;
  idempotencyKey: string;
  queueName: string;
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

export type FinanceAffiliatePayoutDispatchMutationResult = {
  payoutId: string;
  affiliateId: string;
  organizationId: string;
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

export type FinanceAffiliatePayoutDispatcherStore = {
  findDueAffiliatePayoutDispatchCandidates(
    now: Date,
    limit: number,
  ): Promise<FinanceAffiliatePayoutDispatchCandidate[]>;
  claimAffiliatePayoutDispatch(
    candidate: FinanceAffiliatePayoutDispatchCandidate,
    context: FinanceAffiliatePayoutDispatchContext,
  ): Promise<boolean>;
  recordProviderAttempt(attempt: FinancePayoutProviderAttemptRecord): Promise<void>;
  markAffiliatePayoutDispatched(
    candidate: FinanceAffiliatePayoutDispatchCandidate,
    result: FinancePayoutProviderSuccess,
    attempt: FinancePayoutProviderAttemptRecord,
    context: FinanceAffiliatePayoutDispatchContext,
  ): Promise<FinanceAffiliatePayoutDispatchMutationResult>;
  markAffiliatePayoutDispatchFailed(
    candidate: FinanceAffiliatePayoutDispatchCandidate,
    result: FinancePayoutProviderFailure,
    attempt: FinancePayoutProviderAttemptRecord,
    context: FinanceAffiliatePayoutDispatchContext,
  ): Promise<FinanceAffiliatePayoutDispatchMutationResult>;
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

type AffiliatePayoutCandidateRow = {
  payoutId: string;
  affiliateId: string | null;
  organizationId: string;
  amount: string;
  currency: string;
  provider: FinanceAffiliatePayoutProvider | "bank" | "bank_account" | null;
  providerAccountId: string | null;
  retryCount: number;
  maxAttempts: number | null;
  scheduledAt: Date | string;
  payoutSchedule: string | null;
  affiliateResourceLinked: boolean | null;
  legacySchedulerFrozen: boolean | null;
  notificationAuditReady: boolean | null;
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

export type FinanceAffiliatePayoutDispatcherSkipReason =
  | "affiliate_resource_not_linked"
  | "non_monthly_schedule"
  | "legacy_scheduler_not_frozen"
  | "notification_audit_not_ready"
  | "payout_already_dispatched"
  | "dispatch_claim_conflict";

export type FinanceAffiliatePayoutDispatcherSkipped = {
  payoutId: string;
  affiliateId: string;
  reason: FinanceAffiliatePayoutDispatcherSkipReason;
};

export type FinanceAffiliatePayoutDispatcherResult = {
  scanned: number;
  dispatched: number;
  retryScheduled: number;
  failed: number;
  skipped: FinanceAffiliatePayoutDispatcherSkipped[];
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

export async function runFinanceAffiliatePayoutDispatcher(
  store: FinanceAffiliatePayoutDispatcherStore,
  provider: FinanceAffiliatePayoutProviderClient,
  options: FinancePropertyPayoutDispatcherOptions = {},
): Promise<FinanceAffiliatePayoutDispatcherResult> {
  const now = options.now ?? new Date();
  const context: FinanceAffiliatePayoutDispatchContext = {
    now,
    workerId: options.workerId ?? "finance-affiliate-payout-dispatcher",
    correlationId: `finance.dispatch-affiliate-payout:${now.toISOString()}`,
  };
  const candidates = await store.findDueAffiliatePayoutDispatchCandidates(
    now,
    options.limit ?? DEFAULT_FINANCE_AFFILIATE_PAYOUT_DISPATCH_LIMIT,
  );
  const skipped: FinanceAffiliatePayoutDispatcherSkipped[] = [];
  const attempts: FinancePayoutProviderAttemptRecord[] = [];
  let dispatched = 0;
  let retryScheduled = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const skipReason = affiliatePayoutDispatchBlocker(candidate);
    if (skipReason) {
      skipped.push({
        payoutId: candidate.payoutId,
        affiliateId: candidate.affiliateId,
        reason: skipReason,
      });
      continue;
    }

    const claimed = await store.claimAffiliatePayoutDispatch(candidate, context);
    if (!claimed) {
      skipped.push({
        payoutId: candidate.payoutId,
        affiliateId: candidate.affiliateId,
        reason: "dispatch_claim_conflict",
      });
      continue;
    }

    const providerResult = await provider.dispatchAffiliatePayout(candidate, context);
    const attempt = buildAffiliateProviderAttempt(candidate, providerResult, context);
    attempts.push(attempt);
    await store.recordProviderAttempt(attempt);

    if (providerResult.ok) {
      const mutation = await store.markAffiliatePayoutDispatched(
        candidate,
        providerResult,
        attempt,
        context,
      );
      if (mutation.status === "dispatched") dispatched += 1;
      continue;
    }

    const mutation = await store.markAffiliatePayoutDispatchFailed(
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

export function createPgFinanceAffiliatePayoutDispatcherStore(
  config: PgFinancePropertyPayoutDispatcherStoreConfig,
): FinanceAffiliatePayoutDispatcherStore & { close(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findDueAffiliatePayoutDispatchCandidates(now, limit) {
      return selectDueAffiliatePayoutDispatchCandidates(pool, now, limit);
    },
    async claimAffiliatePayoutDispatch(candidate, context) {
      return claimAffiliatePayoutDispatch(pool, candidate, context);
    },
    async recordProviderAttempt(attempt) {
      await insertProviderAttempt(pool, attempt);
    },
    async markAffiliatePayoutDispatched(candidate, result, attempt, context) {
      return markAffiliatePayoutDispatched(pool, candidate, result, attempt, context);
    },
    async markAffiliatePayoutDispatchFailed(candidate, result, attempt, context) {
      return markAffiliatePayoutDispatchFailed(pool, candidate, result, attempt, context);
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

export function affiliatePayoutDispatchBlocker(
  candidate: FinanceAffiliatePayoutDispatchCandidate,
): FinanceAffiliatePayoutDispatcherSkipReason | null {
  if (!candidate.affiliateResourceLinked) return "affiliate_resource_not_linked";
  if (candidate.payoutSchedule !== "monthly") return "non_monthly_schedule";
  if (!candidate.legacySchedulerFrozen) return "legacy_scheduler_not_frozen";
  if (!candidate.notificationAuditReady) return "notification_audit_not_ready";
  if (candidate.providerPayoutId) return "payout_already_dispatched";
  return null;
}

export function buildPropertyPayoutDispatchJobKey(input: {
  propertyId: string;
  payoutId: string;
}): string {
  return `finance.dispatch-property-payout:property:${input.propertyId}:payout:${input.payoutId}:v1`;
}

export function buildAffiliatePayoutDispatchJobKey(input: {
  affiliateId: string;
  payoutId: string;
}): string {
  return `finance.dispatch-affiliate-payout:affiliate:${input.affiliateId}:payout:${input.payoutId}:v1`;
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

async function selectDueAffiliatePayoutDispatchCandidates(
  db: Queryable,
  now: Date,
  limit: number,
): Promise<FinanceAffiliatePayoutDispatchCandidate[]> {
  const result = await db.query<AffiliatePayoutCandidateRow>(
    `SELECT
       payout.id::text AS "payoutId",
       link.resource_id AS "affiliateId",
       payout.organization_id::text AS "organizationId",
       payout.amount::text,
       payout.currency,
       COALESCE(account.provider, settings.payout_method, 'manual') AS provider,
       account.provider_account_id AS "providerAccountId",
       payout.retry_count AS "retryCount",
       COALESCE((payout.payout_metadata ->> 'maxDispatchAttempts')::int, 3) AS "maxAttempts",
       COALESCE(payout.scheduled_at, payout.created_at) AS "scheduledAt",
       COALESCE(settings.schedule ->> 'type', 'monthly') AS "payoutSchedule",
       link.id IS NOT NULL AS "affiliateResourceLinked",
       (payout.payout_metadata ? 'legacyAffiliatePayoutSchedulerFrozenAt')
         AS "legacySchedulerFrozen",
       (payout.payout_metadata ? 'notificationAuditReadyAt')
         AS "notificationAuditReady",
       payout.provider_payout_id AS "providerPayoutId"
     FROM finance.payouts payout
     LEFT JOIN identity.organization_resource_links link
       ON link.organization_id = payout.organization_id
      AND link.product = 'affiliate'
      AND link.resource_type = 'affiliate'
      AND link.status = 'active'
     LEFT JOIN finance.payout_settings settings
       ON settings.id = payout.payout_setting_id
      AND settings.organization_id = payout.organization_id
      AND settings.owner_scope = 'organization'
     LEFT JOIN finance.payment_provider_accounts account
       ON account.id = payout.organization_provider_account_id
      AND account.organization_id = payout.organization_id
      AND account.account_scope = 'organization'
      AND account.status = 'active'
      AND account.payouts_enabled = TRUE
     WHERE payout.owner_scope = 'organization'
       AND payout.payout_status IN ('pending', 'scheduled', 'failed')
       AND payout.provider_payout_id IS NULL
       AND COALESCE(payout.scheduled_at, payout.created_at) <= $1::timestamptz
       AND payout.retry_count < COALESCE((payout.payout_metadata ->> 'maxDispatchAttempts')::int, 3)
       AND COALESCE(settings.schedule ->> 'type', 'monthly') = 'monthly'
     ORDER BY COALESCE(payout.scheduled_at, payout.created_at), payout.id
     LIMIT $2`,
    [now.toISOString(), limit],
  );
  return result.rows.map((row) => ({
    payoutId: row.payoutId,
    affiliateId: row.affiliateId ?? "unlinked",
    organizationId: row.organizationId,
    amount: row.amount,
    currency: row.currency,
    provider: affiliatePayoutProvider(row.provider),
    providerAccountId: row.providerAccountId,
    retryCount: row.retryCount,
    maxAttempts: row.maxAttempts ?? 3,
    scheduledAt: dateString(row.scheduledAt),
    payoutSchedule: affiliatePayoutSchedule(row.payoutSchedule),
    affiliateResourceLinked: Boolean(row.affiliateResourceLinked && row.affiliateId),
    legacySchedulerFrozen: Boolean(row.legacySchedulerFrozen),
    notificationAuditReady: Boolean(row.notificationAuditReady),
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
        affiliateId: attempt.affiliateId ?? null,
        organizationId: attempt.organizationId ?? null,
        provider: attempt.provider,
        providerRequestId: attempt.providerRequestId,
        providerPayoutId: attempt.providerPayoutId,
        requestPayloadHash: attempt.requestPayloadHash,
        retryable: attempt.retryable,
      }),
      attempt.queueName,
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

async function claimAffiliatePayoutDispatch(
  db: Queryable,
  candidate: FinanceAffiliatePayoutDispatchCandidate,
  context: FinanceAffiliatePayoutDispatchContext,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE finance.payouts
     SET payout_status = 'processing',
         updated_at = $1::timestamptz,
         payout_metadata = payout_metadata || $2::jsonb
     WHERE id = $3::uuid
       AND organization_id = $4::uuid
       AND owner_scope = 'organization'
       AND provider_payout_id IS NULL
       AND payout_status IN ('pending', 'scheduled', 'failed')
     RETURNING id`,
    [
      context.now.toISOString(),
      JSON.stringify({
        affiliateDispatchClaimedAt: context.now.toISOString(),
        affiliateDispatchWorkerId: context.workerId,
        affiliateDispatchJobKey: buildAffiliatePayoutDispatchJobKey(candidate),
      }),
      candidate.payoutId,
      candidate.organizationId,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function markAffiliatePayoutDispatched(
  db: Queryable,
  candidate: FinanceAffiliatePayoutDispatchCandidate,
  result: FinancePayoutProviderSuccess,
  attempt: FinancePayoutProviderAttemptRecord,
  context: FinanceAffiliatePayoutDispatchContext,
): Promise<FinanceAffiliatePayoutDispatchMutationResult> {
  await db.query(
    `UPDATE finance.payouts
     SET payout_status = $1,
         provider_payout_id = $2,
         retry_count = GREATEST(retry_count, $3),
         updated_at = $4::timestamptz,
         payout_metadata = payout_metadata || $5::jsonb
     WHERE id = $6::uuid
       AND organization_id = $7::uuid
       AND owner_scope = 'organization'
       AND provider_payout_id IS NULL`,
    [
      result.status,
      result.providerPayoutId,
      attempt.attemptNumber,
      context.now.toISOString(),
      JSON.stringify({
        lastAffiliateDispatchAttemptAt: attempt.recordedAt,
        lastAffiliateDispatchWorkerId: context.workerId,
        providerRequestId: result.providerRequestId,
        notificationAuditRecordedAt: context.now.toISOString(),
      }),
      candidate.payoutId,
      candidate.organizationId,
    ],
  );
  await recordAffiliatePayoutNotificationAudit(db, candidate, result, context);
  await markAffiliateDispatchJobFinished(db, candidate, "succeeded", context);
  return {
    payoutId: candidate.payoutId,
    affiliateId: candidate.affiliateId,
    organizationId: candidate.organizationId,
    status: "dispatched",
    providerPayoutId: result.providerPayoutId,
  };
}

async function markAffiliatePayoutDispatchFailed(
  db: Queryable,
  candidate: FinanceAffiliatePayoutDispatchCandidate,
  result: FinancePayoutProviderFailure,
  attempt: FinancePayoutProviderAttemptRecord,
  context: FinanceAffiliatePayoutDispatchContext,
): Promise<FinanceAffiliatePayoutDispatchMutationResult> {
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
       AND organization_id = $7::uuid
       AND owner_scope = 'organization'
       AND provider_payout_id IS NULL`,
    [
      exhausted ? "failed" : "scheduled",
      attempt.attemptNumber,
      result.errorCategory,
      context.now.toISOString(),
      JSON.stringify({
        lastAffiliateDispatchAttemptAt: attempt.recordedAt,
        lastAffiliateDispatchWorkerId: context.workerId,
        providerRequestId: result.providerRequestId ?? null,
        retryable: result.retryable,
        rollbackRule:
          "No affiliate provider payout id was recorded; legacy may only be re-enabled for the next approved monthly window after reconciliation confirms no successful target transfer.",
      }),
      candidate.payoutId,
      candidate.organizationId,
    ],
  );
  await markAffiliateDispatchJobFinished(db, candidate, exhausted ? "failed" : "pending", context);
  return {
    payoutId: candidate.payoutId,
    affiliateId: candidate.affiliateId,
    organizationId: candidate.organizationId,
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

async function markAffiliateDispatchJobFinished(
  db: Queryable,
  candidate: FinanceAffiliatePayoutDispatchCandidate,
  status: "succeeded" | "failed" | "pending",
  context: FinanceAffiliatePayoutDispatchContext,
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
      FINANCE_AFFILIATE_PAYOUT_DISPATCH_QUEUE,
      buildAffiliatePayoutDispatchJobKey(candidate),
    ],
  );
}

async function recordAffiliatePayoutNotificationAudit(
  db: Queryable,
  candidate: FinanceAffiliatePayoutDispatchCandidate,
  result: FinancePayoutProviderSuccess,
  context: FinanceAffiliatePayoutDispatchContext,
): Promise<void> {
  await db.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'finance',
       'finance.affiliate_payout.notification_audited',
       1,
       $2::timestamptz,
       'organization',
       $3::uuid,
       NULL,
       'system',
       NULL,
       'finance',
       'payout',
       $4,
       $5,
       $6,
       $7::jsonb,
       '{}'::jsonb,
       $8::jsonb,
       'financial',
       'confidential'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `finance.affiliate-payout.notification-audit.affiliate.${candidate.affiliateId}.payout.${candidate.payoutId}.v1`,
      context.now.toISOString(),
      candidate.organizationId,
      candidate.payoutId,
      context.correlationId,
      buildAffiliatePayoutDispatchJobKey(candidate),
      JSON.stringify({
        affiliateId: candidate.affiliateId,
        payoutId: candidate.payoutId,
        provider: candidate.provider,
        providerPayoutId: result.providerPayoutId,
      }),
      JSON.stringify({
        notificationAuditReadyAt: context.now.toISOString(),
        monthlyBatch: true,
      }),
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
    queueName: FINANCE_PROPERTY_PAYOUT_DISPATCH_QUEUE,
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

function buildAffiliateProviderAttempt(
  candidate: FinanceAffiliatePayoutDispatchCandidate,
  result: FinancePayoutProviderResult,
  context: FinanceAffiliatePayoutDispatchContext,
): FinancePayoutProviderAttemptRecord {
  return {
    payoutId: candidate.payoutId,
    propertyId: null,
    affiliateId: candidate.affiliateId,
    organizationId: candidate.organizationId,
    provider: candidate.provider,
    attemptNumber: candidate.retryCount + 1,
    idempotencyKey: buildAffiliatePayoutDispatchJobKey(candidate),
    queueName: FINANCE_AFFILIATE_PAYOUT_DISPATCH_QUEUE,
    requestPayloadHash: sha256(
      stableJson({
        payoutId: candidate.payoutId,
        affiliateId: candidate.affiliateId,
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

function affiliatePayoutProvider(value: unknown): FinanceAffiliatePayoutProvider {
  if (value === "stripe" || value === "manual" || value === "bank_transfer") return value;
  if (value === "bank" || value === "bank_account") return "bank_transfer";
  return "manual";
}

function affiliatePayoutSchedule(
  value: unknown,
): FinanceAffiliatePayoutDispatchCandidate["payoutSchedule"] {
  if (value === "manual" || value === "monthly" || value === "threshold") return value;
  return "monthly";
}
