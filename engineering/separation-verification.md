# Repo Separation Verification (VAY-427)

Final verification that the `vayada` / `vayada-platform` boundary is enforced in practice. Run: 2026-05-22.

## Checklist

### Code boundary

| Check | Result | Notes |
|---|---|---|
| No `.tf` files in `vayada` git tree | ✅ Pass | Stale worktrees in `.claude/worktrees/` are local-only, not in the git index — see exception below |
| No product feature code in `vayada-platform` | ✅ Pass | Platform repo contains only Terraform (`infra/`) and GitHub Actions workflows |
| No Docker build steps in platform CI | ✅ Pass | `deploy.yml` does not build images; `tf-*.yml` have no Docker steps |
| No ECS deploy steps in app CI | ✅ Pass | All 8 service workflows end at `Dispatch deploy to platform` after image push |

### CI boundary

| Check | Result | Notes |
|---|---|---|
| App CI pushes ECR image with `:latest` and `:<sha>` | ✅ Pass | Confirmed in end-to-end deploy test (VAY-423) |
| App CI fires `repository_dispatch` after push | ✅ Pass | `peter-evans/repository-dispatch@v3` step present in all 8 workflows |
| Platform CI deploys SHA-pinned image | ✅ Pass | `deploy.yml` uses `image_sha` from dispatch payload |
| Platform CI waits for ECS stability | ✅ Pass | `wait-for-service-stability: true` in `amazon-ecs-deploy-task-definition@v2` |
| Landing excluded from dispatch | ✅ Pass | `deploy-landing.yml` has no dispatch step; App Runner polls ECR natively |

### IAM boundary

| Check | Result | Notes |
|---|---|---|
| App role (`vayada-github-actions-deploy`) — ECR push only | ✅ Pass | Policy has `EcrAuth` + `EcrPushPull` sids only |
| App role — no ECS permissions | ✅ Pass | `EcsDeploy` and `PassEcsTaskRoles` sids removed in Phase 4 |
| Platform role (`vayada-github-actions-platform-deploy`) — no ECR push | ✅ Pass | Role has ECR describe/manage (for Terraform) but no `PutImage`, `InitiateLayerUpload`, etc. |
| Platform role — ECS deploy permissions present | ✅ Pass | `RegisterTaskDefinition`, `UpdateService`, `DescribeServices`, `DescribeTaskDefinition` |

### Documentation

| Check | Result | Notes |
|---|---|---|
| `AGENTS.md` references `vayada-platform` for infra | ✅ Pass | Updated in Phase 4 |
| `README.md` references `vayada-platform` for infra | ✅ Pass | Updated in Phase 1 |
| Local development doc exists in app repo | ✅ Pass | `engineering/local-development.md` |
| Platform environment doc exists | ✅ Pass | `docs/environments.md` in `vayada-platform` |
| Artifact contract documented | ✅ Pass | `engineering/artifact-contract.md` |
| No `infra/` references in live `.md`/`.yml` files | ✅ Pass | Only the migration checklist and this file reference `infra/`, as historical context |

### Terraform state

| Check | Result | Notes |
|---|---|---|
| State lives at `platform/terraform.tfstate` in S3 | ✅ Pass | Migrated in Phase 2 |
| `terraform plan` from platform repo shows no changes | ✅ Pass | Verified locally after state migration |
| Old state at `infra/terraform.tfstate` preserved as backup | ✅ Pass | Not deleted — serves as rollback copy |

## Exceptions

**Stale git worktrees in `.claude/worktrees/`** — Two worktrees (`vay-413-inline-validation`, `vay-444`) were created during prior ticket work and contain the old `infra/` directory. These are local-only filesystem artifacts that predate the infra removal and are not tracked by git. They can be cleaned up with `git worktree prune`. They do not affect the repo boundary in any meaningful way.

**Action**: run `git worktree prune` on developer machines that had these worktrees.

## End-to-end deploy test result

Commit `cba74a50` (2026-05-22):
- App CI built and pushed `vayada-affiliate-dashboard:cba74a50...` to ECR in 2m
- `repository_dispatch` fired to `vayada-marketplace/vayada-platform`
- Platform CI deployed SHA-pinned image to `vayada-affiliate-dashboard-service` in 3m30s
- ECS service stable at 1/1 running tasks
- Image tag on running task matches commit SHA ✅
