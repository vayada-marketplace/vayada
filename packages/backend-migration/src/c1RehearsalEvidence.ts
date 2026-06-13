import type pg from "pg";

export const C1_REHEARSAL_PROVIDERS = ["channex", "stripe", "xendit"] as const;

export type C1RehearsalProvider = (typeof C1_REHEARSAL_PROVIDERS)[number];

export const C1_REHEARSAL_REQUIRED_METRICS = [
  "provider_receipt_counts",
  "provider_dedupe_hits",
  "job_lag_by_provider_domain",
  "job_failures_by_provider_domain",
  "dead_letters_by_provider_domain",
  "legacy_scheduler_frozen_state",
] as const;

export type C1RehearsalMetricId = (typeof C1_REHEARSAL_REQUIRED_METRICS)[number];

export const C1_REHEARSAL_LEGACY_SCHEDULER_JOBS = [
  "expire_pending_bookings",
  "cancel_stale_unpaid_bookings",
  "cleanup_expired_drafts",
  "process_property_payouts",
  "process_affiliate_payouts",
  "poll_xendit_processing_payouts",
  "poll_channex_bookings",
  "full_channex_ari_sync",
  "advance_calendar_auto_open_windows",
] as const;

export type C1RehearsalLegacySchedulerJob = (typeof C1_REHEARSAL_LEGACY_SCHEDULER_JOBS)[number];

type QueryExecutor = Pick<pg.ClientBase, "query">;

export type C1RehearsalCheckDefinition = {
  id: C1RehearsalMetricId;
  title: string;
  purpose: string;
  sql: string;
};

export type C1RehearsalCheckResult = {
  id: C1RehearsalMetricId;
  title: string;
  rows: Record<string, unknown>[];
};

export type C1RehearsalReport = {
  generatedAt: string;
  lookbackMinutes: number;
  checks: C1RehearsalCheckResult[];
  summary: {
    providersCovered: C1RehearsalProvider[];
    missingProviders: C1RehearsalProvider[];
    metricsCovered: C1RehearsalMetricId[];
    missingMetrics: C1RehearsalMetricId[];
    missingFrozenSchedulerJobs: C1RehearsalLegacySchedulerJob[];
    unfrozenSchedulerJobs: C1RehearsalLegacySchedulerJob[];
  };
};

export type C1RehearsalCheckOptions = {
  lookbackMinutes?: number;
  now?: Date;
};

const providerFilterSql = C1_REHEARSAL_PROVIDERS.map((provider) => `'${provider}'`).join(", ");
const schedulerJobsValuesSql = C1_REHEARSAL_LEGACY_SCHEDULER_JOBS.map((job) => `('${job}')`).join(
  ",\n    ",
);

export const C1_REHEARSAL_CHECKS: C1RehearsalCheckDefinition[] = [
  {
    id: "provider_receipt_counts",
    title: "Provider Receipt Counts",
    purpose:
      "Shows raw target external_webhook_events volume by provider, event type, status, and domain scope.",
    sql: `
      SELECT
        webhook.provider,
        COALESCE(NULLIF(webhook.event_type, ''), 'unknown') AS event_type,
        webhook.delivery_status,
        COALESCE(event.resource_product, webhook.tenant_scope, 'external') AS domain,
        COUNT(*)::INTEGER AS receipt_count,
        MIN(webhook.received_at) AS first_received_at,
        MAX(webhook.received_at) AS last_received_at
      FROM platform.external_webhook_events webhook
      LEFT JOIN platform.domain_events event
        ON event.id = webhook.normalized_domain_event_id
       AND event.scope_key = webhook.scope_key
      WHERE webhook.provider IN (${providerFilterSql})
        AND webhook.received_at >= now() - ($1::INTEGER * INTERVAL '1 minute')
      GROUP BY
        webhook.provider,
        COALESCE(NULLIF(webhook.event_type, ''), 'unknown'),
        webhook.delivery_status,
        COALESCE(event.resource_product, webhook.tenant_scope, 'external')
      ORDER BY webhook.provider, domain, event_type, webhook.delivery_status
    `,
  },
  {
    id: "provider_dedupe_hits",
    title: "Provider Dedupe Hits",
    purpose:
      "Shows idempotency keys observed more than once, grouped by provider and operation scope.",
    sql: `
      WITH idempotency AS (
        SELECT
          COALESCE(
            NULLIF(idempotency_metadata->>'provider', ''),
            CASE
              WHEN operation ILIKE '%channex%' THEN 'channex'
              WHEN operation ILIKE '%stripe%' THEN 'stripe'
              WHEN operation ILIKE '%xendit%' THEN 'xendit'
              ELSE NULL
            END
          ) AS provider,
          operation_scope AS domain,
          operation,
          status,
          first_seen_at,
          last_seen_at,
          CASE
            WHEN (idempotency_metadata->>'hit_count') ~ '^[0-9]+$'
              THEN GREATEST((idempotency_metadata->>'hit_count')::INTEGER - 1, 0)
            WHEN last_seen_at > first_seen_at THEN 1
            ELSE 0
          END AS dedupe_hits
        FROM platform.idempotency_keys
        WHERE first_seen_at >= now() - ($1::INTEGER * INTERVAL '1 minute')
           OR last_seen_at >= now() - ($1::INTEGER * INTERVAL '1 minute')
      )
      SELECT
        provider,
        domain,
        operation,
        status,
        COUNT(*)::INTEGER AS idempotency_key_count,
        SUM(dedupe_hits)::INTEGER AS dedupe_hit_count,
        MIN(first_seen_at) AS first_seen_at,
        MAX(last_seen_at) AS last_seen_at
      FROM idempotency
      WHERE provider IN (${providerFilterSql})
        AND dedupe_hits > 0
      GROUP BY provider, domain, operation, status
      ORDER BY provider, domain, operation, status
    `,
  },
  {
    id: "job_lag_by_provider_domain",
    title: "Job Lag By Provider And Domain",
    purpose: "Shows pending/running target job lag by provider and resource_product domain.",
    sql: `
      WITH scoped_jobs AS (
        SELECT
          COALESCE(
            NULLIF(job_metadata->>'provider', ''),
            CASE
              WHEN job_type ILIKE '%channex%' THEN 'channex'
              WHEN job_type ILIKE '%stripe%' OR job_key ILIKE '%stripe%' THEN 'stripe'
              WHEN job_type ILIKE '%xendit%' OR job_key ILIKE '%xendit%' THEN 'xendit'
              ELSE NULL
            END
          ) AS provider,
          resource_product AS domain,
          status,
          GREATEST(EXTRACT(EPOCH FROM (now() - run_after)), 0)::INTEGER AS lag_seconds,
          run_after
        FROM platform.jobs
        WHERE status IN ('pending', 'running')
          AND run_after <= now()
      )
      SELECT
        provider,
        domain,
        status,
        COUNT(*)::INTEGER AS job_count,
        MAX(lag_seconds)::INTEGER AS max_lag_seconds,
        ROUND(AVG(lag_seconds))::INTEGER AS average_lag_seconds,
        MIN(run_after) AS oldest_run_after
      FROM scoped_jobs
      WHERE provider IN (${providerFilterSql})
      GROUP BY provider, domain, status
      ORDER BY provider, domain, status
    `,
  },
  {
    id: "job_failures_by_provider_domain",
    title: "Job Failures By Provider And Domain",
    purpose:
      "Shows failed, timed-out, and dead-lettered target job attempts by provider and domain.",
    sql: `
      WITH failed_jobs AS (
        SELECT
          COALESCE(
            NULLIF(job.job_metadata->>'provider', ''),
            CASE
              WHEN job.job_type ILIKE '%channex%' THEN 'channex'
              WHEN job.job_type ILIKE '%stripe%' OR job.job_key ILIKE '%stripe%' THEN 'stripe'
              WHEN job.job_type ILIKE '%xendit%' OR job.job_key ILIKE '%xendit%' THEN 'xendit'
              ELSE NULL
            END
          ) AS provider,
          job.resource_product AS domain,
          COALESCE(attempt.status, job.status) AS failure_status,
          COALESCE(attempt.error_type, job.status) AS error_type,
          COUNT(*)::INTEGER AS failure_count,
          MAX(COALESCE(attempt.finished_at, job.finished_at, job.updated_at)) AS latest_failure_at
        FROM platform.jobs job
        LEFT JOIN platform.job_attempts attempt
          ON attempt.job_id = job.id
         AND attempt.status IN ('failed', 'timed_out', 'canceled')
        WHERE (
            job.status IN ('failed', 'dead_lettered')
            OR attempt.status IN ('failed', 'timed_out', 'canceled')
          )
          AND COALESCE(attempt.finished_at, job.finished_at, job.updated_at, job.created_at)
            >= now() - ($1::INTEGER * INTERVAL '1 minute')
        GROUP BY provider, job.resource_product, failure_status, error_type
      )
      SELECT *
      FROM failed_jobs
      WHERE provider IN (${providerFilterSql})
      ORDER BY provider, domain, failure_status, error_type
    `,
  },
  {
    id: "dead_letters_by_provider_domain",
    title: "Dead Letters By Provider And Domain",
    purpose:
      "Shows open/resolved dead-letter volume by provider, domain, and dead-letter source kind.",
    sql: `
      WITH dead_letters AS (
        SELECT
          COALESCE(
            webhook.provider,
            NULLIF(job.job_metadata->>'provider', ''),
            NULLIF(outbox.outbox_metadata->>'provider', ''),
            NULLIF(domain_event.event_metadata->>'provider', ''),
            NULLIF(outbox_domain_event.event_metadata->>'provider', ''),
            NULLIF(job_domain_event.event_metadata->>'provider', ''),
            CASE
              WHEN job.job_type ILIKE '%channex%' THEN 'channex'
              WHEN job.job_type ILIKE '%stripe%' OR job.job_key ILIKE '%stripe%' THEN 'stripe'
              WHEN job.job_type ILIKE '%xendit%' OR job.job_key ILIKE '%xendit%' THEN 'xendit'
              WHEN outbox.destination ILIKE '%channex%'
                OR outbox.event_type ILIKE '%channex%'
                OR outbox.outbox_key ILIKE '%channex%' THEN 'channex'
              WHEN outbox.destination ILIKE '%stripe%'
                OR outbox.event_type ILIKE '%stripe%'
                OR outbox.outbox_key ILIKE '%stripe%' THEN 'stripe'
              WHEN outbox.destination ILIKE '%xendit%'
                OR outbox.event_type ILIKE '%xendit%'
                OR outbox.outbox_key ILIKE '%xendit%' THEN 'xendit'
              WHEN domain_event.source_system = 'external'
                AND (
                  domain_event.event_type ILIKE '%channex%'
                  OR domain_event.event_key ILIKE '%channex%'
                ) THEN 'channex'
              WHEN domain_event.source_system = 'external'
                AND (
                  domain_event.event_type ILIKE '%stripe%'
                  OR domain_event.event_key ILIKE '%stripe%'
                ) THEN 'stripe'
              WHEN domain_event.source_system = 'external'
                AND (
                  domain_event.event_type ILIKE '%xendit%'
                  OR domain_event.event_key ILIKE '%xendit%'
                ) THEN 'xendit'
              WHEN outbox_domain_event.source_system = 'external'
                AND (
                  outbox_domain_event.event_type ILIKE '%channex%'
                  OR outbox_domain_event.event_key ILIKE '%channex%'
                ) THEN 'channex'
              WHEN outbox_domain_event.source_system = 'external'
                AND (
                  outbox_domain_event.event_type ILIKE '%stripe%'
                  OR outbox_domain_event.event_key ILIKE '%stripe%'
                ) THEN 'stripe'
              WHEN outbox_domain_event.source_system = 'external'
                AND (
                  outbox_domain_event.event_type ILIKE '%xendit%'
                  OR outbox_domain_event.event_key ILIKE '%xendit%'
                ) THEN 'xendit'
              WHEN job_domain_event.source_system = 'external'
                AND (
                  job_domain_event.event_type ILIKE '%channex%'
                  OR job_domain_event.event_key ILIKE '%channex%'
                ) THEN 'channex'
              WHEN job_domain_event.source_system = 'external'
                AND (
                  job_domain_event.event_type ILIKE '%stripe%'
                  OR job_domain_event.event_key ILIKE '%stripe%'
                ) THEN 'stripe'
              WHEN job_domain_event.source_system = 'external'
                AND (
                  job_domain_event.event_type ILIKE '%xendit%'
                  OR job_domain_event.event_key ILIKE '%xendit%'
                ) THEN 'xendit'
              ELSE NULL
            END
          ) AS provider,
          COALESCE(
            NULLIF(dead_letter.resource_product, 'platform'),
            job.resource_product,
            outbox.resource_product,
            domain_event.resource_product,
            outbox_domain_event.resource_product,
            job_domain_event.resource_product,
            dead_letter.resource_product
          ) AS domain,
          dead_letter.source_kind,
          dead_letter.recovery_status,
          dead_letter.reason_code,
          COUNT(*)::INTEGER AS dead_letter_count,
          MAX(dead_letter.created_at) AS latest_dead_letter_at
        FROM platform.dead_letter_events dead_letter
        LEFT JOIN platform.external_webhook_events webhook
          ON webhook.id = dead_letter.webhook_event_id
         AND webhook.scope_key = dead_letter.scope_key
        LEFT JOIN platform.jobs job
          ON job.id = dead_letter.job_id
         AND job.scope_key = dead_letter.scope_key
        LEFT JOIN platform.outbox_events outbox
          ON outbox.id = dead_letter.outbox_event_id
         AND outbox.scope_key = dead_letter.scope_key
        LEFT JOIN platform.domain_events domain_event
          ON domain_event.id = dead_letter.domain_event_id
         AND domain_event.scope_key = dead_letter.scope_key
        LEFT JOIN platform.domain_events outbox_domain_event
          ON outbox_domain_event.id = outbox.domain_event_id
         AND outbox_domain_event.scope_key = outbox.scope_key
        LEFT JOIN platform.domain_events job_domain_event
          ON job_domain_event.id = job.source_domain_event_id
         AND job_domain_event.scope_key = job.scope_key
        WHERE dead_letter.created_at >= now() - ($1::INTEGER * INTERVAL '1 minute')
        GROUP BY
          provider,
          domain,
          dead_letter.source_kind,
          dead_letter.recovery_status,
          dead_letter.reason_code
      )
      SELECT *
      FROM dead_letters
      WHERE provider IN (${providerFilterSql})
      ORDER BY provider, domain, source_kind, recovery_status, reason_code
    `,
  },
  {
    id: "legacy_scheduler_frozen_state",
    title: "Legacy Scheduler Frozen-State Checks",
    purpose:
      "Shows the latest audit evidence that each legacy PMS scheduler job was checked and frozen for C1 rehearsal.",
    sql: `
      WITH required_jobs(job_id) AS (
        VALUES
          ${schedulerJobsValuesSql}
      ),
      scheduler_checks AS (
        SELECT
          audit.audit_metadata->>'job_id' AS job_id,
          audit.audit_metadata->>'expected_state' AS expected_state,
          audit.audit_metadata->>'actual_state' AS actual_state,
          audit.audit_metadata->>'owner' AS owner,
          audit.recorded_at,
          ROW_NUMBER() OVER (
            PARTITION BY audit.audit_metadata->>'job_id'
            ORDER BY audit.recorded_at DESC
          ) AS row_number
        FROM platform.product_audit_events audit
        WHERE audit.product = 'platform'
          AND audit.action IN (
            'legacy.scheduler.freeze.checked',
            'legacy.scheduler.frozen_state_checked'
          )
          AND audit.recorded_at >= now() - ($1::INTEGER * INTERVAL '1 minute')
      )
      SELECT
        required_jobs.job_id,
        COALESCE(scheduler_checks.expected_state, 'frozen') AS expected_state,
        scheduler_checks.actual_state,
        scheduler_checks.owner,
        scheduler_checks.recorded_at AS last_checked_at,
        CASE
          WHEN scheduler_checks.job_id IS NULL THEN 'missing'
          WHEN scheduler_checks.actual_state IN ('frozen', 'disabled', 'blocked') THEN 'passed'
          ELSE 'failed'
        END AS evidence_status
      FROM required_jobs
      LEFT JOIN scheduler_checks
        ON scheduler_checks.job_id = required_jobs.job_id
       AND scheduler_checks.row_number = 1
      ORDER BY required_jobs.job_id
    `,
  },
];

export function validateC1RehearsalCheckCoverage(): void {
  const checkIds = new Set(C1_REHEARSAL_CHECKS.map((check) => check.id));
  const missingMetrics = C1_REHEARSAL_REQUIRED_METRICS.filter((metric) => !checkIds.has(metric));
  if (missingMetrics.length > 0) {
    throw new Error(`Missing C1 rehearsal check definitions: ${missingMetrics.join(", ")}`);
  }

  for (const provider of C1_REHEARSAL_PROVIDERS) {
    const covered = C1_REHEARSAL_CHECKS.some((check) => check.sql.includes(`'${provider}'`));
    if (!covered) {
      throw new Error(`Missing C1 rehearsal provider coverage for ${provider}.`);
    }
  }

  for (const job of C1_REHEARSAL_LEGACY_SCHEDULER_JOBS) {
    const covered = C1_REHEARSAL_CHECKS.some((check) => check.sql.includes(`'${job}'`));
    if (!covered) {
      throw new Error(`Missing C1 rehearsal scheduler freeze coverage for ${job}.`);
    }
  }
}

export async function runC1RehearsalChecks(
  client: QueryExecutor,
  options: C1RehearsalCheckOptions = {},
): Promise<C1RehearsalReport> {
  validateC1RehearsalCheckCoverage();

  const lookbackMinutes = options.lookbackMinutes ?? 24 * 60;
  const checks: C1RehearsalCheckResult[] = [];

  for (const check of C1_REHEARSAL_CHECKS) {
    const result = await client.query(check.sql, [lookbackMinutes]);
    checks.push({
      id: check.id,
      title: check.title,
      rows: result.rows as Record<string, unknown>[],
    });
  }

  return buildC1RehearsalReport({
    generatedAt: (options.now ?? new Date()).toISOString(),
    lookbackMinutes,
    checks,
  });
}

export function buildC1RehearsalReport(input: {
  generatedAt: string;
  lookbackMinutes: number;
  checks: C1RehearsalCheckResult[];
}): C1RehearsalReport {
  const providersCovered = new Set<C1RehearsalProvider>();
  for (const check of input.checks) {
    for (const row of check.rows) {
      const provider = row["provider"];
      if (isC1RehearsalProvider(provider)) providersCovered.add(provider);
    }
  }

  const schedulerRows =
    input.checks.find((check) => check.id === "legacy_scheduler_frozen_state")?.rows ?? [];
  const missingFrozenSchedulerJobs: C1RehearsalLegacySchedulerJob[] = [];
  const unfrozenSchedulerJobs: C1RehearsalLegacySchedulerJob[] = [];

  for (const job of C1_REHEARSAL_LEGACY_SCHEDULER_JOBS) {
    const row = schedulerRows.find((candidate) => candidate["job_id"] === job);
    if (!row || row["evidence_status"] === "missing") {
      missingFrozenSchedulerJobs.push(job);
    } else if (row["evidence_status"] !== "passed") {
      unfrozenSchedulerJobs.push(job);
    }
  }

  const metricsCovered = input.checks.map((check) => check.id);

  return {
    ...input,
    summary: {
      providersCovered: C1_REHEARSAL_PROVIDERS.filter((provider) => providersCovered.has(provider)),
      missingProviders: C1_REHEARSAL_PROVIDERS.filter(
        (provider) => !providersCovered.has(provider),
      ),
      metricsCovered,
      missingMetrics: C1_REHEARSAL_REQUIRED_METRICS.filter(
        (metric) => !metricsCovered.includes(metric),
      ),
      missingFrozenSchedulerJobs,
      unfrozenSchedulerJobs,
    },
  };
}

function isC1RehearsalProvider(value: unknown): value is C1RehearsalProvider {
  return typeof value === "string" && C1_REHEARSAL_PROVIDERS.includes(value as C1RehearsalProvider);
}
