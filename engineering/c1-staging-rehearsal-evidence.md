# C1 staging rehearsal evidence tooling

_VAY-793. This prepares dashboards/checks and replay fixtures for the C1
staging rehearsal. It does not execute the VAY-794 rehearsal or record go/no-go
evidence._

## Dashboard/check command

Run against the target staging database:

```bash
TARGET_DATABASE_URL=<target-staging-database-url> \
  npm --workspace @vayada/backend-migration run target:c1-rehearsal:checks -- \
  --lookback-minutes 1440 \
  --pretty
```

The command returns one JSON report with these checks:

| Check id                          | Evidence covered                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `provider_receipt_counts`         | `external_webhook_events` receipt counts by provider, event type, delivery status, and domain. |
| `provider_dedupe_hits`            | Idempotency keys seen more than once by provider and operation scope.                          |
| `job_lag_by_provider_domain`      | Pending/running target job lag by provider and domain.                                         |
| `job_failures_by_provider_domain` | Failed, timed-out, canceled, and dead-lettered job/attempt counts by provider and domain.      |
| `dead_letters_by_provider_domain` | Dead-letter counts by provider, domain, source kind, recovery status, and reason.              |
| `legacy_scheduler_frozen_state`   | Latest audit proof for every legacy PMS scheduler row in the C1 freeze matrix.                 |

The scheduler check expects one `platform.product_audit_events` row per legacy
scheduler job. The target table requires the audit key, product/action,
occurred time, tenant scope, actor type, target resource, payload JSON, retention,
and privacy fields. Use this frozen-scheduler evidence template after operators
confirm each legacy scheduler is frozen, disabled, or blocked for the rehearsal:

```sql
\set rehearsal_id 'c1-staging-rehearsal-YYYYMMDD'
\set correlation_id 'c1-staging-rehearsal-YYYYMMDD'

WITH required_jobs(job_id, owner) AS (
  VALUES
    ('expire_pending_bookings', 'PMS operator'),
    ('cancel_stale_unpaid_bookings', 'PMS operator'),
    ('cleanup_expired_drafts', 'PMS operator'),
    ('process_property_payouts', 'Finance operator'),
    ('process_affiliate_payouts', 'Finance operator'),
    ('poll_xendit_processing_payouts', 'Finance operator'),
    ('poll_channex_bookings', 'PMS operator'),
    ('full_channex_ari_sync', 'PMS operator'),
    ('advance_calendar_auto_open_windows', 'PMS operator')
)
INSERT INTO platform.product_audit_events (
  audit_key,
  product,
  action,
  action_version,
  occurred_at,
  tenant_scope,
  actor_type,
  target_resource_product,
  target_resource_type,
  target_resource_id,
  correlation_id,
  causation_id,
  redacted_payload,
  private_payload,
  audit_metadata,
  retention_class,
  privacy_scope,
  ai_visible
)
SELECT
  format('c1:%s:legacy-scheduler:%s:freeze-checked', :'rehearsal_id', job_id),
  'platform',
  'legacy.scheduler.freeze.checked',
  1,
  now(),
  'platform',
  'system',
  'platform',
  'legacy_scheduler_job',
  job_id,
  :'correlation_id',
  :'rehearsal_id',
  jsonb_build_object(
    'job_id', job_id,
    'expected_state', 'frozen',
    'actual_state', :'actual_state'
  ),
  '{}'::jsonb,
  jsonb_build_object(
    'job_id', job_id,
    'expected_state', 'frozen',
    'actual_state', :'actual_state',
    'owner', owner,
    'rehearsal_id', :'rehearsal_id',
    'evidence_source', 'operator-confirmed-freeze'
  ),
  'standard',
  'internal',
  FALSE
FROM required_jobs
ON CONFLICT (product, audit_key) DO NOTHING;
```

Set `actual_state` to `frozen`, `disabled`, or `blocked`; those values pass.
Missing rows or any other state are reported in the summary.

## Replay fixtures

Fixtures live in
[`engineering/fixtures/c1-staging-rehearsal-replay`](fixtures/c1-staging-rehearsal-replay)
and include:

- Channex message and booking revision samples.
- Stripe `payment_intent.succeeded` and Connect `account.updated` samples.
- Xendit invoice paid and payout succeeded samples.

List fixtures:

```bash
node scripts/c1-rehearsal-replay-fixtures.mjs --list
```

Dry-run a provider:

```bash
C1_REHEARSAL_WEBHOOK_BASE_URL=https://api.staging.example.test \
  node scripts/c1-rehearsal-replay-fixtures.mjs --provider stripe --twice
```

Send to staging target intake:

```bash
C1_REHEARSAL_WEBHOOK_BASE_URL=https://api.staging.example.test \
STRIPE_WEBHOOK_SECRET=<target-stripe-webhook-secret> \
XENDIT_WEBHOOK_SECRET=<target-xendit-callback-token> \
CHANNEX_WEBHOOK_SECRET=<target-channex-token> \
  node scripts/c1-rehearsal-replay-fixtures.mjs --all --twice --send
```

`--send` is guarded so synthetic fixtures cannot be posted to arbitrary hosts.
Dry runs do not need host approval. Real sends are allowed for local/staging
hosts only (`localhost`, `*.localhost`, `127.0.0.1`, `::1`, `staging.*`,
`*.staging`, or `*.staging.*`). If staging uses a different hostname, set
`C1_REHEARSAL_ALLOW_SEND_TO_HOST=<host>` to allow that exact host for the run.

Use `--twice` during rehearsal to prove duplicate provider delivery creates one
receipt, one normalized domain event, and no duplicate jobs. The script prints
the expected receipt, domain-event, and job keys for each fixture so the dashboard
report can be compared with the replay output.
