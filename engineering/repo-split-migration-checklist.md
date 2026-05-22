# Repo Split Migration Checklist

Execution runbook for splitting `vayada` into `vayada` (app) and `vayada-platform`. Work through phases in order. Do not start an irreversible phase until all validation gates in the previous phase pass.

Artifact contract reference: [`engineering/artifact-contract.md`](artifact-contract.md)

---

## Phase 1 — Pre-migration (fully reversible)

These steps create new things without removing or modifying anything in production.

- [ ] **VAY-418** — Create the `vayada-platform` repository
  - [ ] Repo exists in the GitHub org with branch protection on `main`
  - [ ] Baseline README describes the platform/app boundary
  - [ ] CODEOWNERS or team access configured
  - **Gate**: repo is accessible and protected before proceeding

- [ ] Back up current Terraform state
  - [ ] Run `terraform state pull > terraform-state-backup-$(date +%Y%m%d).json` from `infra/`
  - [ ] Store the backup outside the repo (S3 or secure local copy)
  - **Gate**: backup file is non-empty and parseable

- [ ] Audit IAM changes required
  - [ ] Identify permissions the `vayada-github-actions-deploy` role must split (ECR push stays with app repo OIDC subject; ECS deploy moves to platform repo OIDC subject)
  - [ ] Draft the updated trust policy and permission boundary before applying anything
  - **Gate**: IAM diff is reviewed and agreed before Phase 3

---

## Phase 2 — Terraform migration (partially irreversible after state move)

**Rollback trigger**: if `terraform plan` shows any unexpected `destroy` or `replace` after the state move, stop and restore from the Phase 1 backup before making any further changes.

- [ ] **VAY-419** — Copy `infra/` into `vayada-platform`
  - [ ] All Terraform files copied; module structure and file layout preserved
  - [ ] `.terraform.lock.hcl` included
  - [ ] No functional changes made during the copy (copy first, refactor later)
  - **Gate**: `terraform init && terraform validate` passes in the platform repo

- [ ] Configure Terraform backend in `vayada-platform`
  - [ ] Backend bucket/key defined (same S3 bucket is fine; use a distinct key path)
  - [ ] If migrating state: run `terraform state mv` or reconfigure backend and `terraform init -migrate-state`
  - **Gate**: `terraform plan` in `vayada-platform` shows **no changes** (zero adds, changes, destroys)

- [ ] **VAY-420** — Update references in `vayada-platform`
  - [ ] Remote state references updated if any module cross-references exist
  - [ ] Variable files and `terraform.tfvars.example` updated for new repo context
  - [ ] Any CI/script references to `infra/` path updated
  - **Gate**: second `terraform plan` still shows no changes after updates

#### Phase 2 rollback

If `terraform plan` shows unexpected changes at any gate:

1. Do not run `terraform apply`.
2. Restore state: `terraform state push terraform-state-backup-<date>.json`
3. Revert any backend configuration changes.
4. Diagnose the drift before retrying.

---

## Phase 3 — CI migration (main risk window)

This is the highest-risk phase. Both repos must be wired correctly before removing the deploy step from app CI. Keep the existing app CI deploy step active until the platform CI deploy is verified end-to-end.

**Rollback trigger**: if a post-split deploy fails and cannot be fixed within 30 minutes, re-enable the deploy step in app CI workflows as a bridge while diagnosing.

- [ ] Update IAM role trust policy
  - [ ] App repo OIDC subject retains ECR push permissions
  - [ ] Platform repo OIDC subject granted ECS deploy permissions (`ecs:RegisterTaskDefinition`, `ecs:UpdateService`, `ecs:DescribeTaskDefinition`, `ecs:DescribeServices`, `ecs:DescribeTaskSets`)
  - [ ] Verify both repos can authenticate: trigger a no-op workflow in each repo and confirm AWS credential step succeeds
  - **Gate**: both repos authenticate to AWS without error

- [ ] **VAY-422** — Update app CI workflows
  - [ ] Remove ECS task definition download, render, and deploy steps from all 8 service workflows
  - [ ] Add `repository_dispatch` step after image push (payload: `service`, `ecr_repo`, `image_sha`, `environment`)
  - [ ] Landing workflow unchanged (App Runner auto-deploys; no dispatch needed)
  - **Gate**: app CI completes successfully and pushes image with both `:latest` and `:<sha>` tags; dispatch event is visible in platform repo's workflow run history

- [ ] **VAY-423** — Add platform CI deploy workflow
  - [ ] Workflow triggers on `repository_dispatch` with `event_type: app-image-published`
  - [ ] Deploys SHA-pinned image to the correct ECS service and cluster
  - [ ] Waits for service stability before marking success
  - **Gate (dry run)**: trigger the workflow manually via `workflow_dispatch` with a known good SHA for one non-critical service and confirm ECS service stabilises

- [ ] **End-to-end deploy test**
  - [ ] Push a trivial change to one service (e.g. `apps/booking-api`) on `main`
  - [ ] Confirm: app CI builds and pushes → dispatch fires → platform CI deploys → ECS service is stable
  - [ ] Confirm the deployed image tag matches the commit SHA
  - **Gate**: full deploy chain completes without manual intervention

#### Phase 3 rollback

If platform CI deploy fails and the service is degraded:

1. Re-enable the deploy step in the relevant app CI workflow (revert the workflow file on `main`).
2. Push an empty commit or trigger `workflow_dispatch` to force a redeploy via the old path.
3. Confirm ECS service stabilises before investigating the platform CI failure.

---

## Phase 4 — Cleanup (irreversible)

Only start this phase after at least **3 successful end-to-end deploys** via the new split CI path.

- [ ] **VAY-426** — Remove `infra/` from the app repo
  - [ ] Delete `infra/` directory from `vayada`
  - [ ] Remove or update any `AGENTS.md`, `CLAUDE.md`, or README references to `infra/`
  - [ ] Remove the deleted `infra/docs.tf` and related stale workflow (`deploy-docs.yml`) if not already done
  - **Gate**: `git grep -r 'infra/' --include='*.md' --include='*.yml'` returns no live references

- [ ] Remove IAM ECR permissions from platform repo OIDC subject (it should never push images)
- [ ] Remove IAM ECS deploy permissions from app repo OIDC subject (it should never deploy)
- [ ] Archive or remove the `docs/` Docusaurus directory if it is being deleted as part of this project
  - **Gate**: app repo CI passes on `main` with no references to removed paths

---

## Phase 5 — Documentation and verification

- [ ] **VAY-424** — Document local development workflow in app repo
- [ ] **VAY-425** — Document production and preview environment workflow in platform repo
- [ ] **VAY-427** — Run final verification checklist
  - [ ] No product feature code in `vayada-platform`
  - [ ] No Terraform or cloud IaC in `vayada`
  - [ ] CI responsibilities match the artifact contract
  - [ ] Ops runbooks reference the correct repo for each concern

---

## Rollback decision matrix

| Failure mode | Trigger | Action |
|---|---|---|
| `terraform plan` shows unexpected destroy/replace | Phase 2 gate fails | Restore state backup; do not apply; diagnose drift |
| IAM auth fails from platform repo | Phase 3 gate fails | Revert trust policy; keep app CI deploy step active |
| Platform CI deploy fails, service degraded | Post-deploy health check fails | Re-enable app CI deploy step; redeploy via old path; diagnose |
| ECR push fails from app CI | Image push step errors | Check OIDC subject filter on IAM role; restore previous trust policy if needed |
| Production incident within 48h of cutover | On-call judgement | Re-enable app CI deploy step as bridge; assess whether incident is related to CI split |

---

## Communication checkpoints

| Point | Action |
|---|---|
| Before Phase 3 starts | Notify team: CI workflows are changing; no merges to `main` for affected services during the migration window |
| After Phase 3 end-to-end gate passes | Notify team: split CI is live; deploy path has changed |
| After Phase 4 cleanup | Notify team: `infra/` removed from app repo; direct Terraform work now lives in `vayada-platform` |
