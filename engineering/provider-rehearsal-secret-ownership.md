# Provider rehearsal secret ownership

_VAY-841 recommendation. References:
[`c1-staging-rehearsal-evidence.md`](c1-staging-rehearsal-evidence.md),
and the `vayada-platform` repo's `infra/ssm.tf`, `infra/ecs.tf`, and
[`docs/environments.md`](https://github.com/vayada-marketplace/vayada-platform/blob/main/docs/environments.md#c1-staging-rehearsal-secret-cleanup)._

## Decision

C1 rehearsal secrets should live in AWS SSM Parameter Store under
`/vayada/staging/*`, managed by the `vayada-platform` repository and owned by
Platform/runtime. The app repo owns the commands and evidence artifacts, but it
must not own the secret values, committed env files, or GitHub repository
secrets used to provision them.

Use the existing `target-backend` runtime at `target-api.vayada.com` for C1
rehearsal. Do not use the parallel `next-api.vayada.com` production-validation
runtime and do not read `/vayada/prod/*` provider secrets for rehearsal replay.
Provider dashboards stay pointed at legacy URLs unless a separate provider
cutover ticket authorizes an endpoint switch.

## Required secrets

| Backend env var          | Runtime SSM path                         | Terraform/GitHub Actions input in `vayada-platform`                        | Storage owner    | Value owner                                                                   |
| ------------------------ | ---------------------------------------- | -------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `TARGET_DATABASE_URL`    | `/vayada/staging/target-database-url`    | `staging_target_database_url` / `TF_VAR_STAGING_TARGET_DATABASE_URL`       | Platform/runtime | Platform/runtime plus target-schema migration owner                           |
| `STRIPE_WEBHOOK_SECRET`  | `/vayada/staging/stripe-webhook-secret`  | `staging_stripe_webhook_secret` / `TF_VAR_STAGING_STRIPE_WEBHOOK_SECRET`   | Platform/runtime | Finance provider owner                                                        |
| `XENDIT_WEBHOOK_SECRET`  | `/vayada/staging/xendit-webhook-secret`  | `staging_xendit_webhook_secret` / `TF_VAR_STAGING_XENDIT_WEBHOOK_SECRET`   | Platform/runtime | Finance provider owner; synthetic only until real Xendit runtime is confirmed |
| `CHANNEX_WEBHOOK_SECRET` | `/vayada/staging/channex-webhook-secret` | `staging_channex_webhook_secret` / `TF_VAR_STAGING_CHANNEX_WEBHOOK_SECRET` | Platform/runtime | PMS channel-connectivity owner                                                |

Terraform should be the normal provisioning path:
`manage_staging_rehearsal_secrets = true`. Use
`target_backend_staging_secrets_preprovisioned = true` only as an escape hatch
when the same four SSM parameters already exist outside the apply.

## Provider secret source status

Current VAY-937 status from the redacted VAY-794 provider exports:

| Provider | Staging path                             | Source and intended use                                                                                                                                                                                                                                            | Provider owner                                                                       | Dashboard constraint                                                                                              |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Stripe   | `/vayada/staging/stripe-webhook-secret`  | Copied from the existing live Stripe webhook signing secret for controlled observe-only replay on 2026-06-15; not synthetic. Future rehearsals should use a provider-approved secondary/staging endpoint or explicit Finance approval before reusing a live token. | Finance provider owner                                                               | One enabled live endpoint remains `https://pms-api.vayada.com/webhooks/stripe`; do not switch it for rehearsal.   |
| Channex  | `/vayada/staging/channex-webhook-secret` | Rehearsal-managed staging token; replay-only until a real Channex webhook endpoint is configured.                                                                                                                                                                  | PMS channel-connectivity owner                                                       | `GET /api/v1/webhooks` returned no active Channex webhooks for the configured account.                            |

Go/no-go input: Stripe and Channex can be used for controlled target-intake
replay only while dashboards remain pointed at legacy or have no active webhook.
The Stripe live-secret copy above is a recorded VAY-794 exception, not a
default for future rehearsals. Secret values must stay out of docs, issues, CI
logs, and committed files.

## Database approach

Use a temporary target database built from a reviewed target-schema snapshot for
each C1 rehearsal. In practice, `/vayada/staging/target-database-url` should
point at a rehearsal-specific target DB restored or rebuilt from the latest
accepted target snapshot, not at the production target DB and not at a standing
shared staging DB with unrelated QA state.

Reasoning:

- Provider replay writes durable receipts, idempotency rows, domain-event
  previews, and scheduler-freeze audit evidence. Those rows should be disposable
  after the rehearsal window.
- A standing staging DB makes old replay rows, manual QA edits, and stale
  scheduler evidence easy to misread as a fresh pass.
- The target runtime and dashboard tooling already expect one target database
  URL; a snapshot-backed target DB exercises the real schema without granting
  rehearsal commands access to production runtime secrets.

### Target DB snapshot lifecycle

Owner: Platform/runtime owns the temporary database, DB user, SSM pointer, and
teardown. The target-schema migration owner owns the reviewed snapshot or rebuild
input and signs off that migrations/parity checks are current before replay.

Retention: destroy the rehearsal DB and DB user within 72 hours after the
VAY-794 go/no-go decision. Any extension needs a Linear comment with a new expiry
date and owner. Do not reuse a previous C1 rehearsal database for a new replay.

Evidence location: record a redacted lifecycle artifact under
`engineering/evidence/vay-794/target-db-lifecycle-YYYYMMDD.json`. The artifact
should include the rehearsal id, source snapshot or rebuild commit, migration
ledger, non-secret database identifier, owner, created/expires timestamps, SSM
parameter version, CloudWatch dashboard log streams, and teardown timestamp. Do
not include connection strings or secret values.

Procedure for each rehearsal:

1. Create a rehearsal-specific target DB from a reviewed RDS snapshot or rebuild
   it from the accepted target-schema migration input. Use a unique database
   name and user for the rehearsal. Do not point at the production target DB or a
   standing shared staging DB.
2. Apply target migrations against the temporary DB and run the target parity or
   smoke checks required by the current cutover plan.
3. Update `/vayada/staging/target-database-url` without printing the value:

   ```bash
   test -n "${TARGET_DATABASE_URL:-}"

   aws ssm put-parameter \
     --region eu-west-1 \
     --name /vayada/staging/target-database-url \
     --type SecureString \
     --value "$TARGET_DATABASE_URL" \
     --overwrite \
     --query Version \
     --output text
   ```

4. Start or restart only the target/rehearsal runtime that reads the staging SSM
   parameter. Run the baseline dashboard command and record the CloudWatch log
   stream before provider replay. Update the lifecycle artifact with the SSM
   parameter version returned above and the baseline dashboard log stream.
5. Run provider replay and post-replay dashboard checks. Receipt rows,
   idempotency rows, job/event previews, dead letters, and scheduler-freeze
   audit rows are disposable because they live only in this temporary DB. Add
   the post-replay dashboard log stream to the lifecycle artifact.
6. After evidence capture, stop the rehearsal runtime, destroy the temporary DB
   and DB user, and clear or rotate `/vayada/staging/target-database-url` so it
   no longer points at a destroyed database. Update the lifecycle artifact with
   teardown time and owner.

The frozen legacy PMS runtime is not part of the approved C1 provider-replay
path. Current `vayada-platform` wiring for the optional
`vayada-staging-pms-backend` service still injects several production
dependencies, including auth, booking, SMTP, Stripe API, and Channex API
secrets. Do not enable that runtime for C1 scheduler-freeze evidence until a
separate isolation ticket replaces those dependencies with staging, no-op, or
explicitly read-only values. If scheduler-freeze evidence is required before
that isolation exists, capture it from the production legacy runtime without
running synthetic provider replay against it.

## Runtime path

`vayada-platform` already models the intended path:

- `infra/ssm.tf` creates the four `/vayada/staging/*` SecureString parameters
  when `manage_staging_rehearsal_secrets` is enabled.
- `infra/ecs.tf` injects them into service key `target-backend` as
  `TARGET_DATABASE_URL`, `STRIPE_WEBHOOK_SECRET`, `XENDIT_WEBHOOK_SECRET`, and
  `CHANNEX_WEBHOOK_SECRET`.
- The `target-backend` service defaults
  `STRIPE_WEBHOOK_INTAKE_MODE`, `XENDIT_WEBHOOK_INTAKE_MODE`, and
  `CHANNEX_WEBHOOK_INTAKE_MODE` to `observe_only`.
- `apps/api` registers provider webhook routes only when
  `TARGET_DATABASE_URL` and at least one provider webhook secret are present.
  Dashboard checks read only `TARGET_DATABASE_URL`.

## Safe execution path

1. Platform/runtime provisions or verifies the four SSM parameters without
   printing values, applies Terraform with `target_backend_desired_count = 1`,
   and confirms `target-api.vayada.com/health`.
2. Keep provider dashboards on legacy endpoints and keep the target provider
   modes in `observe_only` for rehearsal evidence. Do not change Stripe,
   Xendit, or Channex dashboard endpoints in this ticket's scope.
3. Run dashboard checks from a dedicated one-off ECS rehearsal task inside the
   VPC. Do not use ECS Exec on the serving Fargate task, and do not assume the
   `target-backend` API image can run TypeScript workspace scripts: the API
   image prunes dev dependencies, while `target:c1-rehearsal:checks` currently
   uses `tsx`. The one-off task should use a purpose-built rehearsal/ops image
   or a compiled dist-safe command, inject the exact `/vayada/staging/*` values
   through ECS `secrets`, write logs to CloudWatch, and exit after evidence
   capture. Prefer ECS secret injection over `aws ssm get-parameter` inside the
   container; if an in-container AWS CLI path is ever used, the follow-up must
   add a dedicated task role with narrow `ssm:GetParameter` and `kms:Decrypt`
   permissions first.

   The task definition must map `/vayada/staging/target-database-url` to
   `TARGET_DATABASE_URL`. The command should assert that the value exists
   without printing it:

   ```bash
   test -n "${TARGET_DATABASE_URL:-}"

   npm --workspace @vayada/backend-migration run target:c1-rehearsal:checks -- \
     --lookback-minutes 1440 \
     --pretty
   ```

4. For provider replay, first run `--list` and a no-send dry run. For a real
   send, the same one-off ECS rehearsal task must receive the three provider
   secrets through ECS `secrets`, use the exact target host allowlist, and replay
   twice:

   ```bash
   test -n "${STRIPE_WEBHOOK_SECRET:-}"
   test -n "${XENDIT_WEBHOOK_SECRET:-}"
   test -n "${CHANNEX_WEBHOOK_SECRET:-}"

   C1_REHEARSAL_WEBHOOK_BASE_URL=https://target-api.vayada.com \
   C1_REHEARSAL_ALLOW_SEND_TO_HOST=target-api.vayada.com \
   STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" \
   XENDIT_WEBHOOK_SECRET="$XENDIT_WEBHOOK_SECRET" \
   CHANNEX_WEBHOOK_SECRET="$CHANNEX_WEBHOOK_SECRET" \
     node scripts/c1-rehearsal-replay-fixtures.mjs --all --twice --send
   ```

   The current replay script only allows local hosts by default. Remote staging
   sends therefore require `C1_REHEARSAL_ALLOW_SEND_TO_HOST` set to the exact
   hostname used for the run.

5. Re-run the dashboard checks and compare receipt counts, dedupe hits, job lag,
   job failures, dead letters, and scheduler-freeze rows with the replay output.
6. Stop or scale down the target rehearsal runtime after evidence capture unless
   a current cutover ticket explicitly keeps it running.

## Rotation and isolation

- Do not reuse production provider webhook secrets for C1 synthetic replay.
  Stripe, Xendit, and Channex rehearsal values should be generated or copied
  only from a provider staging/secondary endpoint approved by the provider owner.
- Rotate or delete the three provider replay secrets after each rehearsal
  window. Also drop the rehearsal DB user or destroy the temporary target DB
  after evidence has been captured. VAY-794 is not complete until the
  [`vayada-platform` cleanup runbook](https://github.com/vayada-marketplace/vayada-platform/blob/main/docs/environments.md#c1-staging-rehearsal-secret-cleanup)
  has been run or a Linear comment records why cleanup is deferred.
- Keep `/vayada/staging/*` IAM read access limited to the target/rehearsal ECS
  task execution roles, the platform deploy role, and named operators running
  the rehearsal. The one-off task should receive secrets through ECS secret
  injection; do not grant app repo CI these values.
- Tag staging parameters with `Project=vayada`, `Environment=staging`,
  `Purpose=c1-rehearsal`, and an owner/expiry tag in the platform follow-up so
  stale rehearsal secrets are visible.
- Keep Xendit in the required secret set because the target task and replay
  fixtures include it, but treat it as synthetic/non-blocking until Finance
  confirms real Xendit runtime usage.

## Follow-up tickets

1. Platform/runtime: add a one-off ECS rehearsal task definition and no-print
   workflow for C1 dashboard checks and provider replay, including a
   purpose-built rehearsal/ops image or dist-safe command, ECS `secrets`
   mappings for the four `/vayada/staging/*` paths, narrow execution-role
   SSM/KMS permissions, exact-host replay allowlisting, and CloudWatch log
   capture.
2. Target-schema/migration: use the target DB snapshot lifecycle runbook above
   for clone/rebuild, retention, and teardown before VAY-794 runs.
3. Platform/runtime: isolate or disable `vayada-staging-pms-backend` production
   dependencies before using it for scheduler-freeze evidence; replace auth,
   booking, SMTP, Stripe API, and Channex API secrets with staging/no-op/read-only
   values.
4. Finance and PMS channel-connectivity: confirm whether staging provider
   secrets are synthetic replay-only or bound to real secondary provider
   endpoints before any future dashboard switch.
5. App repo DX: align `c1-staging-rehearsal-evidence.md` with the current replay
   script behavior: remote sends require `C1_REHEARSAL_ALLOW_SEND_TO_HOST` for
   the exact hostname.

Create these follow-up Linear issues and link them to VAY-794 before VAY-794
proceeds to a real C1 rehearsal. This spike does not create or apply the
Terraform/runtime changes itself.
