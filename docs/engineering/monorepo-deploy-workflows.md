# Monorepo Deploy Workflows

Date: 2026-05-21

## Scope

The app monorepo keeps one root GitHub Actions deploy workflow per app. Each
workflow is triggered by:

- manual `workflow_dispatch`
- pushes to `main` that touch the app path
- pushes to `main` that touch `packages/**`
- changes to that workflow file

Docs-only changes should not deploy apps.

## Workflow Map

| App | Workflow | Trigger paths |
|---|---|---|
| `apps/marketplace-api` | `.github/workflows/deploy-marketplace-api.yml` | `apps/marketplace-api/**`, `packages/**`, workflow file |
| `apps/marketplace-web` | `.github/workflows/deploy-marketplace-web.yml` | `apps/marketplace-web/**`, `packages/**`, workflow file |
| `apps/marketplace-admin` | `.github/workflows/deploy-marketplace-admin.yml` | `apps/marketplace-admin/**`, `packages/**`, workflow file |
| `apps/booking-api` | `.github/workflows/deploy-booking-api.yml` | `apps/booking-api/**`, `packages/**`, workflow file |
| `apps/booking-web` | `.github/workflows/deploy-booking-web.yml` | `apps/booking-web/**`, `packages/**`, workflow file |
| `apps/booking-admin` | `.github/workflows/deploy-booking-admin.yml` | `apps/booking-admin/**`, `packages/**`, workflow file |
| `apps/pms-api` | `.github/workflows/deploy-pms-api.yml` | `apps/pms-api/**`, `packages/**`, workflow file |
| `apps/pms-web` | `.github/workflows/deploy-pms-web.yml` | `apps/pms-web/**`, `packages/**`, workflow file |
| `apps/affiliate-dashboard` | `.github/workflows/deploy-affiliate-dashboard.yml` | `apps/affiliate-dashboard/**`, `packages/**`, workflow file |
| `apps/landing` | `.github/workflows/deploy-landing.yml` | `apps/landing/**`, `packages/**`, workflow file |

## Preserved Deployment Behavior

The initial migration preserves existing deployment targets:

- existing ECR repository names
- existing ECS clusters, services, task families, and App Runner image behavior
- existing static AWS credential secret names: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
- existing frontend build arguments and backend test setup

The only intended behavior change is that workflows now run from the monorepo
root and use app-specific path filters.

## Cutover Verification

Before merging the monorepo migration branch:

1. Configure `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` on `vayada-marketplace/vayada`.
2. Confirm `actionlint .github/workflows/*.yml` passes.
3. Manually run one low-risk frontend workflow with `workflow_dispatch`.
4. Manually run one backend workflow with tests using `workflow_dispatch`.
5. Confirm a docs-only change does not trigger app deploy workflows.
6. Confirm a single app path change triggers only that app's workflow.
7. Confirm a `packages/**` change triggers the intended app workflows.

## Rollback

Do not disable the old standalone app repository workflows until the monorepo
deploy workflows have completed at least one successful production deploy per app.

Rollback options before old workflows are disabled:

1. Revert or pause the monorepo deploy workflow that failed.
2. Keep shipping from the old app repository workflow for that app.
3. Re-run the previous successful GitHub Actions deployment in the old app repo.
4. If the monorepo migration branch has not merged, keep it unmerged and continue
   from the existing standalone app repositories.

After old workflows are disabled, rollback requires either re-enabling the old
workflow in the standalone app repo or reverting the monorepo workflow change.
