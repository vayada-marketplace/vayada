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

## VAY-794 local execution record

Recorded on 2026-06-14 from branch
`flamurmaliqi2811/vay-794-execute-c1-staging-rehearsal-and-record-gono-go-evidence`.
This is local tooling evidence only; it does not replace the staging provider
dashboard exports, operator freeze approvals, live replay output, rollback proof,
or go/no-go sign-off required by VAY-794.

### Commands run

Fixture inventory:

```bash
node scripts/c1-rehearsal-replay-fixtures.mjs --list
```

Result: passed. The command listed six synthetic replay fixtures:

| Fixture                           | Provider  | Event type                 |
| --------------------------------- | --------- | -------------------------- |
| `channex-message-created`         | `channex` | `message`                  |
| `channex-booking-revision`        | `channex` | `booking`                  |
| `stripe-payment-intent-succeeded` | `stripe`  | `payment_intent.succeeded` |
| `stripe-connect-account-updated`  | `stripe`  | `account.updated`          |
| `xendit-invoice-paid`             | `xendit`  | `invoice.paid`             |
| `xendit-payout-succeeded`         | `xendit`  | `payout.succeeded`         |

Duplicate dry-run replay:

```bash
C1_REHEARSAL_WEBHOOK_BASE_URL=http://localhost:8000 \
  node scripts/c1-rehearsal-replay-fixtures.mjs --all --twice
```

Result: passed. The command printed two dry-run POST attempts per fixture and
redacted provider auth headers. Expected idempotency evidence emitted by the
script:

| Fixture                           | Expected receipt key                                                     | Expected domain event keys                                                                 | Expected job keys                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channex-message-created`         | `webhook:channex:message:prop_c1_rehearsal:msg_c1_rehearsal_001`         | `channex.message.ingest:prop_c1_rehearsal:thread_c1_rehearsal_001:msg_c1_rehearsal_001:v1` | `channex.ingest-message:channel_message:msg_c1_rehearsal_001:message-created:v1`                                                                                                                                |
| `channex-booking-revision`        | `webhook:channex:booking:prop_c1_rehearsal:chan_book_c1_rehearsal_001:7` | `channex.booking.ingest:prop_c1_rehearsal:chan_book_c1_rehearsal_001:7:v1`                 | `channex.ingest-booking:channel_booking:chan_book_c1_rehearsal_001:revision-7:v1`                                                                                                                               |
| `stripe-payment-intent-succeeded` | `webhook:stripe:evt_c1_rehearsal_pi_succeeded_001`                       | `payment.captured:stripe:pi_c1_rehearsal_001:24100:v1`                                     | `payment.reconcile-status:payment:pi_c1_rehearsal_001:stripe-event-evt_c1_rehearsal_pi_succeeded_001:v1`; `booking.finalize-instant:booking:book_c1_rehearsal_001:stripe-payment-intent-pi_c1_rehearsal_001:v1` |
| `stripe-connect-account-updated`  | `webhook:stripe:evt_c1_rehearsal_account_updated_001`                    | `finance.provider-account.updated:stripe:acct_c1_rehearsal_001:true:v1`                    | `finance.reconcile-provider-account:provider_account:acct_c1_rehearsal_001:stripe-event-evt_c1_rehearsal_account_updated_001:v1`                                                                                |
| `xendit-invoice-paid`             | `webhook:xendit:invoice:inv_c1_rehearsal_001:PAID`                       | `payment.captured:xendit:inv_c1_rehearsal_001:24100:v1`                                    | `payment.reconcile-status:payment:inv_c1_rehearsal_001:xendit-status-PAID:v1`; `booking.finalize-instant:booking:book_c1_rehearsal_002:xendit-invoice-inv_c1_rehearsal_001:v1`                                  |
| `xendit-payout-succeeded`         | `webhook:xendit:payout:payout_c1_rehearsal_001:SUCCEEDED`                | `payout.status:xendit:payout_c1_rehearsal_001:SUCCEEDED:v1`                                | `finance.reconcile-payout:payout:payout_c1_rehearsal_001:xendit-status-SUCCEEDED:v1`                                                                                                                            |

C1 evidence unit coverage:

```bash
npm --workspace @vayada/backend-migration run test -- c1RehearsalEvidence
```

Result: passed. Vitest reported 1 file passed, 4 tests passed.

Backend migration typecheck:

```bash
npm --workspace @vayada/backend-migration run typecheck
```

Result: passed.

Parity harness unit coverage:

```bash
npm --workspace @vayada/backend-migration run test -- parity registry platformJobsEventsAudit
```

Result: passed. Vitest reported 5 files passed, 9 tests passed, 6 skipped.

### Staging runtime attempt on 2026-06-14

After the platform secret-ownership work, the target database URL was loaded
from AWS Secrets Manager without printing the value and the staging
dashboard/check command was attempted:

```bash
TARGET_DATABASE_URL="$(aws secretsmanager get-secret-value \
  --region eu-west-1 \
  --secret-id vayada/database-url \
  --query SecretString \
  --output text)" \
npm --workspace @vayada/backend-migration run target:c1-rehearsal:checks -- \
  --lookback-minutes 1440 \
  --pretty
```

Result: failed before producing a report. The command reached the database
connection step but timed out connecting to the target database host on port
5432 from the local operator environment.

Additional runtime checks:

- The deployed `vayada-backend-service` task definition exposes
  `DATABASE_URL`, `JWT_SECRET_KEY`, auth, SMTP, CORS, and AWS runtime secrets,
  but does not expose `STRIPE_WEBHOOK_SECRET`, `XENDIT_WEBHOOK_SECRET`, or
  `CHANNEX_WEBHOOK_SECRET`.
- The deployed `vayada-pms-backend-service` task definition exposes
  `STRIPE_WEBHOOK_SECRET` and `CHANNEX_API_KEY`, but no
  `XENDIT_WEBHOOK_SECRET` or `CHANNEX_WEBHOOK_SECRET`.
- AWS SSM Parameter Store currently has no parameters under `/vayada/staging/`
  in `eu-west-1`.
- GitHub Actions now has workflow wiring for the staging rehearsal Terraform
  variables, but the repository secret-name listing does not show the
  corresponding staging values yet.

No live `--send --twice` provider replay was executed because the target runtime
does not currently have matching provider webhook secrets and the rehearsal SSM
parameters have not been created with real values.

### Target staging database setup on 2026-06-15

A separate logical target database was created on the existing AWS RDS instance
for C1 rehearsal isolation:

- database: `vayada_target_staging`;
- user: `vayada_target_staging_user`;
- master connection stored in AWS Secrets Manager as `vayada/rds-master-url`;
- target connection stored in AWS Secrets Manager as
  `vayada/target-staging-database-url`;
- `vayada-platform` GitHub Actions secret
  `TF_VAR_STAGING_TARGET_DATABASE_URL` set to the target connection string.

The local operator IP was temporarily allowed to reach the RDS security group on
port 5432 for setup and validation, then the temporary ingress rule was revoked.

Target migrations were applied with the staging environment ledger:

```bash
TARGET_DATABASE_URL=<target-staging-database-url> \
  npm --workspace @vayada/backend-migration run target:migrate -- --env staging
```

Result: passed. Migrations `0001` through `0017` were applied. The target
database now contains these target schemas:

```text
booking, distribution, finance, hotel_catalog, identity, intelligence,
marketplace, platform, pms
```

The C1 rehearsal dashboard command was then run against the migrated target
database:

```bash
TARGET_DATABASE_URL=<target-staging-database-url> \
  npm --workspace @vayada/backend-migration run target:c1-rehearsal:checks -- \
  --lookback-minutes 1440 \
  --pretty
```

Result: passed and produced a baseline report. Since no provider replay or
scheduler freeze evidence has been recorded into the new target database yet,
the report showed:

- empty rows for provider receipts, dedupe hits, job lag, job failures, and
  dead letters;
- `missingProviders`: `channex`, `stripe`, `xendit`;
- all nine legacy scheduler jobs present in
  `missingFrozenSchedulerJobs`.

Remaining VAY-794 evidence still required from staging:

- provider endpoint exports for Channex, Stripe, and Xendit;
- target dashboard/check report after freeze evidence and replay receipts exist;
- operator-approved scheduler freeze rows for the nine legacy PMS scheduler jobs;
- live or controlled staging replay using `--send --twice` with provider secrets;
- rollback proof for at least one provider;
- go/no-go decision with named owners.

### AWS secret discovery

Recorded on 2026-06-14 after refreshing AWS access. Secret values were not
printed or committed.

Discovery scope:

- AWS Secrets Manager and SSM Parameter Store names across the configured
  deployment account and common regions.
- Active and recent ECS task definitions for application-level environment and
  secret references.
- GitHub repository, environment, and organization secret-name listings for the
  app and platform repositories.
- App Runner runtime environment and secret names.
- The platform Terraform source and environment documentation.
- Local dotenv files, limited to variable-name matching.

High-level finding: the current deployed runtime exposes the application-level
values needed for the existing Stripe webhook and Channex API integration, but
no managed staging/rehearsal runtime path was found for `TARGET_DATABASE_URL`,
`XENDIT_WEBHOOK_SECRET`, or `CHANNEX_WEBHOOK_SECRET`. The platform Terraform
source also does not define the missing C1 rehearsal variables or a staging
secret namespace.

Direct read-only connection attempts to candidate database URLs timed out from
the local machine, and ECS Exec is disabled on the running Fargate tasks, so the
C1 dashboard command could not be run inside the VPC from this environment.

### Managed staging secrets and controlled replay on 2026-06-15

The platform repository now manages the C1 staging rehearsal SSM parameters.
Secret values were loaded from AWS SSM/GitHub Actions without printing them.

Terraform apply:

```text
https://github.com/vayada-marketplace/vayada-platform/actions/runs/27571357112
```

Result: passed. AWS SSM Parameter Store now contains these managed SecureString
parameters in `eu-west-1`:

```text
/vayada/staging/channex-webhook-secret
/vayada/staging/stripe-webhook-secret
/vayada/staging/target-database-url
/vayada/staging/xendit-webhook-secret
```

The target RDS endpoint is private and does not accept local operator TCP
traffic, so the dashboard command was run as an ECS one-off task inside the VPC.
The first ECS dashboard task used log stream
`/ecs/vayada-c1-rehearsal-checks:ecs/checks/f787bcfed7794855843dedd9ba0cb655`.

```bash
TARGET_DATABASE_URL=<ssm:/vayada/staging/target-database-url> \
  npm --workspace @vayada/backend-migration run target:c1-rehearsal:checks -- \
  --lookback-minutes 1440 \
  --pretty
```

Result: passed. Baseline report generated at
`2026-06-15T19:52:58.974Z`:

- no provider receipt rows yet;
- no provider dedupe-hit rows yet;
- `missingProviders`: `channex`, `stripe`, and `xendit`;
- all nine legacy scheduler freeze rows were missing.

A temporary target `apps/api` runtime was then run as an ECS one-off task in
`observe_only` mode for all three providers. The runtime received only these
runtime values from SSM:

```text
TARGET_DATABASE_URL
STRIPE_WEBHOOK_SECRET
XENDIT_WEBHOOK_SECRET
CHANNEX_WEBHOOK_SECRET
```

The replay was executed from the operator machine against that temporary target
runtime:

```bash
C1_REHEARSAL_WEBHOOK_BASE_URL=http://<temporary-ecs-public-ip>:8003 \
C1_REHEARSAL_ALLOW_SEND_TO_HOST=<temporary-ecs-public-ip> \
STRIPE_WEBHOOK_SECRET=<ssm:/vayada/staging/stripe-webhook-secret> \
XENDIT_WEBHOOK_SECRET=<ssm:/vayada/staging/xendit-webhook-secret> \
CHANNEX_WEBHOOK_SECRET=<ssm:/vayada/staging/channex-webhook-secret> \
  node scripts/c1-rehearsal-replay-fixtures.mjs --all --twice --send
```

Result: passed. All six fixture sends returned HTTP 200. First delivery returned
`observed`; duplicate delivery returned `duplicate_observed`:

| Fixture                           | Provider  | First attempt | Duplicate attempt    |
| --------------------------------- | --------- | ------------- | -------------------- |
| `channex-message-created`         | `channex` | `observed`    | `duplicate_observed` |
| `channex-booking-revision`        | `channex` | `observed`    | `duplicate_observed` |
| `stripe-payment-intent-succeeded` | `stripe`  | `observed`    | `duplicate_observed` |
| `stripe-connect-account-updated`  | `stripe`  | `observed`    | `duplicate_observed` |
| `xendit-invoice-paid`             | `xendit`  | `observed`    | `duplicate_observed` |
| `xendit-payout-succeeded`         | `xendit`  | `observed`    | `duplicate_observed` |

The post-replay ECS dashboard task used log stream
`/ecs/vayada-c1-rehearsal-checks:ecs/checks/0aacca9cbadd42bfa89aa181ca214efd`.

Result: passed. Report generated at `2026-06-15T19:58:24.873Z`:

- `providersCovered`: `channex`, `stripe`, `xendit`;
- `missingProviders`: none;
- provider receipt counts: one observed receipt for each fixture event type;
- provider dedupe hits:
  - Channex: two idempotency keys, two dedupe hits;
  - Stripe: two idempotency keys, two dedupe hits;
  - Xendit: two idempotency keys, two dedupe hits;
- job lag, job failure, and dead-letter rows were empty;
- all nine legacy scheduler freeze rows were still missing.

Temporary infrastructure cleanup:

- the temporary target API ECS task was stopped after replay;
- the temporary replay security group allowing operator access to port 8003 was
  deleted;
- temporary ECS task definitions were deregistered;
- the temporary ECR repository used for the rehearsal image was deleted;
- CloudWatch log groups were retained for evidence.

Current VAY-794 go/no-go status: **no-go / incomplete**. The managed secret
path, target DB access path, controlled provider replay, and duplicate receipt
dedupe evidence now exist. The rehearsal still cannot pass until the remaining
cutover-plan gates are completed:

- export and attach provider dashboard configuration for Channex, Stripe, and
  Xendit;
- record operator-approved freeze evidence rows for all nine legacy PMS
  scheduler jobs;
- exercise rollback for at least one provider path;
- rerun the dashboard after freeze rows exist;
- record named owner sign-off for go/no-go.
