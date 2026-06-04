---
name: work-on-linear-ticket
description: Use when picking up a Vayada Linear ticket to implement. Covers the full lifecycle from loading context to opening a PR — status transitions, branch naming, verification, and PR conventions.
---

# Working on a Vayada Linear ticket

This skill covers the full implementation lifecycle for a Vayada ticket: from loading context through opening a PR. Follow the seven steps in order; do not skip or reorder them.

The per-stack commands, validation expectations, and shipping conventions referenced here live in `AGENTS.md`. The full Linear operating model (status transitions, agent rules, label semantics) lives in `engineering/linear-workspace.md`. This skill surfaces the workflow — it does not duplicate those docs.

## Seven-step workflow

### 1. Load context

Fetch the ticket before writing a single line of code.

- Use the Linear MCP `get_issue` tool with the issue identifier (e.g. `VAY-123`).
- Read the full description: **Context**, **Scope**, **Out of scope**, **Acceptance criteria**, **Notes / References**.
- Fetch any linked or blocking issues mentioned in the description.
- If acceptance criteria are absent or ambiguous, ask for clarification before proceeding.

### 2. Set In Progress

Move the ticket to **In Progress** before touching any code.

```text
save_issue(id: "VAY-NNN", state: "In Progress")
```

Do not defer this step. The status signals to teammates that work has started.

### 3. Branch

Create a branch from `main` following the repo convention:

```text
<initials>/vay-<id>-<slug>
```

- `<initials>` — your two- or three-letter identifier (e.g. `fm`).
- `<id>` — the numeric part of the issue identifier, lowercase (e.g. `569`).
- `<slug>` — a short kebab-case summary of the ticket title (e.g. `add-work-on-linear-ticket-agent-skill`).

Example: `fmaliqi/vay-569-add-work-on-linear-ticket-agent-skill`

The Linear ticket's `gitBranchName` field contains the canonical branch name — use it if available.

For isolated work, create a git worktree:

```bash
git worktree add /tmp/vayada-<slug> -b <branch-name>
```

### 4. Implement

Work through the acceptance criteria one at a time.

- Treat each AC as a testable statement of done — do not mark work complete until the criterion is actually met.
- Defer to `AGENTS.md` for per-stack commands (FastAPI, Next.js, workspace builds).
- Do not expand scope beyond the ticket. If you discover adjacent work that should be done, open a follow-up Linear issue rather than pulling it into this PR.
- Keep commits focused and descriptive. Each commit message should explain _why_, not just what changed.

### 5. Verify

Run automated checks before opening a PR. Which checks to run depends on what changed:

| What changed               | Required checks                                                                |
| -------------------------- | ------------------------------------------------------------------------------ |
| FastAPI backend            | `python -m pytest` in the affected app; `ruff check <paths>` for new code      |
| Next.js frontend           | `npm run build` + `npm run lint` in the affected app                           |
| Cross-app / workspace      | Root `npm run build` + `npm run typecheck`                                     |
| `landing` or `booking-web` | Also run `npm run e2e:landing` or `npm run e2e:booking-web` (Playwright smoke) |
| Any user-facing UI change  | Also invoke `/verify` to exercise the golden path in the browser               |

Playwright currently covers `landing` and `booking-web`; VAY-568 tracks expanding coverage to remaining apps. When a newly covered app is in scope, run its smoke command too.

If a check cannot be run locally (missing env, secrets, infra), say so explicitly — do not claim success.

### 6. Adversarial review

Before opening a PR, run `.agents/skills/adversarial-review/SKILL.md`.

For non-trivial changes, use an independent subagent when available and provide only the ticket context, changed files, diff, and validation results. Fix any valid findings, rerun the relevant checks, and include the review outcome in the PR risk or validation notes.

### 7. PR

When all checks pass:

1. Commit staged changes with a descriptive message.
2. Push the branch: `git push -u origin <branch-name>`.
3. Open a GitHub PR with:
   - **Title**: `[VAY-NNN] <short imperative description>` — ticket ID must appear in the title.
   - **Description**: summary of changes, mapping back to each acceptance criterion, validation run, and any risk notes.
4. Leave the ticket at **In Progress**. The human moves it to **Done** after merging and smoke testing.

Do not move the ticket to Done yourself. See `engineering/linear-workspace.md` § AI agent rules.

## Anti-patterns

- **Starting without reading the ACs.** Implementing before loading context wastes time on the wrong thing. Step 1 is mandatory.
- **Skipping status transitions.** Not setting In Progress leaves teammates blind to active work. Not keeping it In Progress after the PR is open signals false completion. Always set In Progress before touching code; never set Done.
- **Scope creep.** Fixing adjacent issues, refactoring nearby code, or adding "while I'm here" improvements dilutes the PR, complicates review, and risks regressions. Open a follow-up ticket for anything outside the ACs.
- **Claiming verification without running checks.** A dev server starting is not a passing build. State exactly which commands you ran and what they returned.
- **Skipping adversarial review.** Verification shows the code passes expected checks; the adversarial pass looks for missed acceptance criteria, hidden regressions, and risk that the expected checks did not cover.
- **Amending a published commit.** If a pre-commit hook fails, fix the issue and create a new commit — do not `--amend` a commit that has already been pushed.

## References

- `AGENTS.md` — per-stack commands, validation expectations, shipping conventions, worktree setup.
- `engineering/linear-workspace.md` — full Linear operating model, status transition rules, agent rules.
- `.agents/skills/adversarial-review/SKILL.md` — post-implementation adversarial review before PR creation.
- `.agents/skills/write-linear-issue/SKILL.md` — creating new Linear issues.
- `tests/e2e/README.md` — Playwright smoke layer documentation.
- VAY-568 — expanding Playwright coverage to remaining apps.
