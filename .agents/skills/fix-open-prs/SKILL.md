---
name: fix-open-prs
description: Work through all open PRs and for each one: apply CodeRabbit actionable suggestions, resolve merge conflicts with main, and fix failing CI checks. Use when asked to clean up, fix, or tend to open PRs.
---

# Fix open PRs

Work through every open PR and leave each one clean: CodeRabbit comments
addressed, merge conflicts resolved, CI checks passing.

## Overview

For each open PR, run three passes in order:

1. **CodeRabbit pass** — apply actionable suggestions from CodeRabbit's AI prompt.
2. **Merge conflict pass** — rebase or merge main to clear conflicts.
3. **CI check pass** — identify failing checks and fix the underlying issues.

Finish each PR before moving to the next. Commit after each distinct concern
(CodeRabbit fixes, conflict resolution, and CI fixes each get their own commit)
so the history is legible.

---

## Phase 0 — enumerate open PRs

```bash
gh pr list --json number,title,headRefName,mergeable,isDraft,labels,statusCheckRollup \
  --jq '.[] | select((.isDraft | not) and ([.labels[].name] | index("WIP") | not)) | {number, title, headRefName, mergeable}'
```

Skip PRs that are draft or have a `WIP` label — leave those untouched.

---

## Phase 1 — CodeRabbit pass

### Find actionable comments

Fetch the latest CodeRabbit summary review (the one authored by `coderabbitai`
with `State: COMMENTED` and a body that contains `Prompt for all review
comments with AI agents`):

```bash
# List reviews, filter to the latest coderabbitai COMMENTED review
gh api repos/{owner}/{repo}/pulls/{PR}/reviews --paginate \
  --jq '[.[] | select(.user.login == "coderabbitai" and .state == "COMMENTED")] | max_by(.submitted_at)'
```

The review body contains a fenced code block under the heading
`🤖 Prompt for all review comments with AI agents`. That code block is a
structured agent prompt listing every unresolved inline comment like:

```text
Verify each finding against current code. Fix only still-valid issues, skip
the rest with a brief reason, keep changes minimal, and validate.

Inline comments:
In `@path/to/file.ext`:
- Line N: <description of issue and required fix>
```

Feed that block directly as your working instructions. **Do not re-invent the
findings** — trust what CodeRabbit extracted.

### Applying fixes

- Check out the PR branch: `gh pr checkout {number}`.
- For each finding, open the named file, locate the line, verify the issue
  still exists in the current code, and apply the minimal fix described.
- If a finding no longer applies (the code was already changed), note it and
  skip — do not create a spurious diff.
- After all findings are addressed, run the relevant validation:
  - TypeScript files → `cd apps/<app> && npm run typecheck`
  - Python files → `cd apps/<api> && ruff check . && ruff format --check .`
- Commit:
  ```text
  fix: address CodeRabbit suggestions on <PR title>
  ```

### No actionable comments

If CodeRabbit has not yet posted a final review (still `IN_PROGRESS`), wait or
skip this PR and return to it. If the latest review has `Actionable comments
posted: 0`, skip the CodeRabbit pass entirely.

---

## Phase 2 — merge conflict pass

Check mergeability:

```bash
gh pr view {number} --json mergeable --jq '.mergeable'
```

If `CONFLICTING`:

1. `git fetch origin`
2. On the PR branch, attempt a rebase: `git rebase origin/main`.
3. If git reports `skipped previously applied commit` warnings, those commits
   are already on main — this is normal. Use `git rebase --skip` to advance
   past them. If the rebase immediately errors because the first conflicting
   commit is one of these already-merged commits, abort and fall back to merge
   (see below).
4. If the rebase produces content conflicts, resolve them file by file:
   - Read both sides of each conflict.
   - Prefer the intent of the PR branch; bring in main's changes where they
     don't conflict semantically.
   - For migration files: keep both sides (both migrations are valid and must
     both apply in sequence); rename the PR's migration if the sequence number
     collides with one in main.
5. `git rebase --continue` after each conflict is resolved.
6. Push: `git push --force-with-lease origin {branch}`.
7. Commit message is already part of the rebase — no separate commit needed.

Prefer rebase over merge to keep the branch history linear. Fall back to
`git merge origin/main` if the rebase produces more than three conflict sites,
the conflicts are not mechanical, or the rebase fails because many intermediate
commits were already cherry-picked into main.

### Merge fallback

When using `git merge origin/main`, `--ours` and `--theirs` refer to:
- `--ours` → the current PR branch (the branch being fixed)
- `--theirs` → main (the incoming branch)

Resolution strategy per file type:

| File type | Strategy |
|---|---|
| Source files the PR intentionally changed (e.g. tests with CodeRabbit fixes) | `git checkout --ours <file>` — keep the PR branch's improvements |
| Generated lock files (`package-lock.json`, `poetry.lock`) | Delete and regenerate: `npm install` / `poetry lock` |
| Files changed on both sides with unrelated edits | Merge manually, keeping both sets of changes |

After resolving all conflicts, `git add` the files and `git commit` (the merge
commit message is sufficient — no need to reword it).

---

## Phase 3 — CI check pass

Fetch the current check state:

```bash
gh pr checks {number} --json name,status,conclusion,detailsUrl
```

For each check with `conclusion: FAILURE`:

| Check name                            | Fix strategy                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `Frontend Typecheck, Lint, Build`     | Run `npm run typecheck` and `npm run lint` in each affected Next.js app; fix errors. |
| `Backend Tests (marketplace-api)`     | Run `pytest` in `apps/marketplace-api`; fix failing tests.                         |
| `Backend Tests (booking-api)`         | Run `pytest` in `apps/booking-api`; fix failing tests.                             |
| `Backend Tests (pms-api)`             | Run `pytest` in `apps/pms-api`; fix failing tests.                                 |
| `Playwright Smoke`                    | Check for obvious structural breaks (missing routes, missing env vars); fix or skip. |

To get failure details, fetch the check's log output:

```bash
gh run view --log-failed {run-id}
```

The run ID is embedded in `detailsUrl`:
`https://github.com/{owner}/{repo}/actions/runs/{run-id}/job/{job-id}`

### Fix scope

Fix only what the CI log reports. Do not refactor surrounding code, do not add
tests for untouched paths, and do not upgrade dependencies. If the root cause is
a pre-existing flaky test unrelated to this PR's diff, note it in a PR comment
and skip the fix.

After fixes, commit:

```text
fix: resolve CI failures on <PR title>

<one-line summary of what was failing and why>
```

Then push the branch to trigger a re-run.

---

## Phase 4 — push and report

After all three passes are complete for a PR:

1. Push the branch (if not already pushed during conflict resolution):
   `git push origin {branch}`.
2. Summarise what was done in a PR comment:
   ```text
   @coderabbitai Applied N CodeRabbit suggestions, resolved merge conflicts
   with main, and fixed <failing check name>. Re-triggering CI.
   ```
3. Move to the next PR.

---

## Edge cases and decisions

**Multiple PRs touching the same file** — fix each PR independently in its own
checkout. Do not attempt to reconcile cross-PR conflicts; that is a human
decision.

**CodeRabbit review still pending** — if no final CodeRabbit review exists yet,
skip Phase 1 for that PR and proceed to Phase 2 and 3.

**Failing check caused by the PR diff itself vs pre-existing flakiness** — if
the failing test file was not touched by this PR's diff, treat it as flaky and
leave a comment rather than fixing it.

**PR already up-to-date with main and all checks passing** — skip the PR
entirely; note it in the summary.

**Migration sequence collision** — when two PRs each add a migration with the
same number (e.g. both add `086_…`), the PR being fixed should increment its
migration filename to the next available number and update any reference to
that filename inside the migration itself (e.g. a `Reverts: 086_…` comment).

---

## Validation commands reference

```bash
# TypeScript (run from the relevant app directory)
npm run typecheck
npm run lint

# Python (run from the relevant api directory)
ruff check .
ruff format --check .
pytest

# List open PRs
gh pr list --json number,title,headRefName,mergeable

# Check PR status
gh pr checks {number}

# Fetch CI log for a failed run
gh run view --log-failed {run-id}
```
