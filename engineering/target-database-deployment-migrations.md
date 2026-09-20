# Target database deployment migrations

VAY-1316 makes target TypeScript migrations a startup gate for the deployed
`next-api` release. The release image runs the existing
`@vayada/backend-migration` runner before it starts the HTTP server. A failed
migration exits the container, so ECS cannot route target traffic to that task
or report the new service deployment healthy.

This applies only to the target TypeScript database. Legacy Python and auth-db
migration procedures are unchanged.

## Normal deployment

1. `.github/workflows/deploy-next-api.yml` builds one SHA-tagged image and embeds
   the application commit in `APPLICATION_RELEASE`.
2. The platform deployment resolves that image to an ECR digest and rolls out
   the immutable task definition.
3. `scripts/start-next-api.sh` runs all pending target migrations with
   `--env production --git-sha "$APPLICATION_RELEASE"`.
   When `TARGET_DATABASE_MIGRATION_URL` is set, only the migration child receives
   that owner credential; the long-running API receives `TARGET_DATABASE_URL`.
   Omitting it temporarily preserves the original single-credential rollout.
4. Only an exit code of zero starts `apps/api`. The runner advisory lock and
   migration ledger make repeated or overlapping task starts idempotent.

Do not enable the split until the runtime role has all reviewed application
privileges and the release-specific least-privilege checks pass. After enabling
it, never place the migration-owner URL in `TARGET_DATABASE_URL`,
`AUTH_DATABASE_URL`, or any other variable inherited by the API process.

Roll out in two phases. First deploy this compatible launcher while every
database variable still uses the original credential. Only after that revision
is healthy may the platform add `TARGET_DATABASE_MIGRATION_URL` and replace all
long-lived database variables with the runtime credential. Retain the complete
pre-split task definition through the rollback window. A rollback must restore
both its image and its original credential mapping; rolling back only the image
would make the old launcher attempt migrations with the restricted runtime role.
Keep receipt-backed owner preparation and every other security-sensitive write
disabled while that pre-split rollback remains eligible. Close the rollback
window only after a split-compatible known-good task is retained. From that
point onward, every rollback must preserve the split credential mapping and
must never restore an owner URL to `TARGET_DATABASE_URL` or `AUTH_DATABASE_URL`.

CloudWatch group `/ecs/vayada-next-api` records the release SHA and the applied,
already-applied, or failed migration versions. The durable ledger is
`platform.schema_migrations`.

## Verification

Confirm the service is stable, then verify the release and ledger:

```sql
SELECT version, name, status, git_sha, applied_at, failure_reason
FROM platform.schema_migrations
ORDER BY applied_at DESC;
```

A repeated deploy of the same image must log `No pending migrations` and start
normally. A release with a new migration must log that version as applied before
the API startup line and before its task passes the load-balancer health check.

## Failed migration recovery

1. Treat the platform deployment as blocked. The previous healthy task remains
   the serving release; do not bypass the startup gate.
2. Find `Failed at version NNNN` in `/ecs/vayada-next-api`, then inspect the
   matching failed ledger row and `failure_reason`.
3. For a transactional failure, fix the migration in a new application release.
   For a non-transactional migration, inspect partial effects and make the
   roll-forward migration idempotent before retrying. Do not automatically roll
   back destructive DDL.
4. Publish the corrected release through the normal deploy workflow. Do not
   edit the ECS task definition or run an untracked database command manually.
5. Verify the corrected release SHA, applied migration row, service stability,
   and a target-stack smoke before accepting the deployment.

If the runner cannot acquire its advisory lock, allow the active migration to
finish and retry the deployment. Do not increase database connections or remove
the lock to force concurrent DDL.
