# Linear Workspace Operating Model

How Vayada uses Linear: projects, labels, statuses, priorities, cycles, issue quality, and AI-agent rules.

This is the canonical operating model. The shorter "Linear workflow" section in `AGENTS.md` summarizes the day-to-day rules; this doc holds the full structure and the reasoning.

## Projects vs standalone issues

Use a **project** when work has any of:

- A scope larger than one or two tickets (multi-week effort).
- Multiple issues that share a goal, milestone, or stakeholder question ("how is X going?").
- A decision or design that produces a written record.

Use a **standalone issue** when the work is self-contained, one PR/commit in size, and not part of a larger initiative.

Heuristic: if you'd expect at least three tickets to fall under it, make it a project. Promoting a standalone issue into a project later is cheap.

Projects carry **milestones** for major phases (e.g., `Repository Strategy Decision`, `Monorepo Migration Execution`). Use milestones to group ~5–15 related issues within a project; if a project has only one phase, skip milestones.

## Labels

Two axes: **Type** (what kind of work) and **Area** (which part of the system). An issue should normally carry one Type label and one or more Area labels.

### Type labels

| Label         | Use for                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `Feature`     | New product capability or user-facing functionality.                                        |
| `Improvement` | Enhancement to an existing capability.                                                      |
| `Bug`         | Behavior that diverges from the spec or expected behavior.                                  |
| `Chore`       | Maintenance, cleanup, dependency bumps — no product behavior change.                        |
| `Spike`       | Time-boxed research/investigation. Output is a recommendation, not shipped code.            |
| `Decision`    | Captures an architecture/workflow decision with a written record. Often pairs with `Spike`. |

### Area labels

| Label           | Use for                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `DX`            | Developer experience, local workflows, conventions, tooling, productivity.         |
| `AI/Agents`     | Codex, Claude Code, shared skills, prompts, agent workflows.                       |
| `CI/CD`         | Continuous integration, deployment workflows, release automation, quality gates.   |
| `Repo Strategy` | Repository structure, monorepo strategy, migrations, source-of-truth decisions.    |
| `Docs`          | README, AGENTS.md, `docs/`, runbooks, decision records, API docs.                  |
| `Platform`      | Infra, AWS, Terraform, networking, databases, runtime concerns shared across apps. |
| `Frontend`      | Next.js apps, UI components, styling, frontend-only logic.                         |
| `Backend`       | FastAPI services, schemas, migrations, server-side business logic.                 |

Rule of thumb: if an issue touches several areas equally, pick the most affected one — don't over-tag. If it touches none cleanly, it probably belongs in `DX`, `Platform`, or `Docs`.

## Workflow statuses

| Status        | When the ticket lives here                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Backlog`     | Identified work; not actively scheduled.                                                                                             |
| `Todo`        | Scheduled / ready to be picked up next.                                                                                              |
| `In Progress` | Implementation has started, including agent-owned work with an open PR waiting for human merge and smoke test.                       |
| `In Review`   | Optional: implementation needs explicit human design/product review before merge. Most agent PRs stay `In Progress` instead.         |
| `Done`        | Work is merged, smoke tested, and accepted (or accepted for non-code tickets). Reopened to `In Progress` if QA later finds an issue. |
| `Canceled`    | Won't do — leave a comment explaining why.                                                                                           |
| `Duplicate`   | Dupe of another issue — link the canonical ticket in a comment.                                                                      |

Transitions worth noting:

- `Backlog` → `Todo`: when you commit to doing it in the near term.
- `Todo` → `In Progress`: when implementation actually begins.
- `In Progress` stays `In Progress`: when an agent finishes implementation, pushes the branch, and opens a PR for the human to merge and smoke test.
- `In Progress` → `In Review`: optional intermediate handoff for explicit human design/product review before merge. This is not the default for agent PRs.
- `In Progress` / `In Review` → `Done`: after the human merges the PR, smoke tests the shipped change, and confirms no required follow-up remains.
- `Done` → `In Progress`: human reopens if QA finds an issue.
- Any → `Canceled` / `Duplicate`: leave a comment.

## Priority

| Priority          | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `Urgent` (1)      | Production-impacting or blocking a committed external date. |
| `High` (2)        | Planned for the current focus; this week or this milestone. |
| `Medium` (3)      | Next-up after High; planned but not active.                 |
| `Low` (4)         | Nice-to-have; no current commitment.                        |
| `No priority` (0) | Not yet triaged. New issues default here until reviewed.    |

Default to **Medium** once triaged. Bump to **High** when you actively pull it into current work. Reserve **Urgent** for things that should interrupt other work.

## Cycles

**Deferred.** With one engineer plus AI agents and no fixed release cadence, cycles add overhead without a rhythm payoff. Revisit when there's a second engineer or a regular release cadence.

Until then, "what's planned now" is expressed via priority (`High`) plus project membership, not cycles.

## Issue quality standards

Every issue should be readable cold by someone who hasn't been in the conversation.

### Title

- Imperative ("Add", "Fix", "Migrate"), not a noun-phrase or question.
- ≤ 70 characters.
- No ticket prefix in the title (Linear adds `VAY-NNN` automatically).
- Avoid implementation details ("Switch from useState to useReducer in cart" → "Refactor cart state").

### Description structure

Use these sections (omit any that don't apply):

```markdown
## Context

Why this exists. What triggered it. What problem it solves.

## Scope

- Bullet list of what is in scope.

## Out of scope (optional)

- Things explicitly excluded, so reviewers don't expect them.

## Acceptance criteria

- Testable, bulleted statements of "done".

## Notes / References (optional)

- Links to related issues (`VAY-NNN`), plans, docs, Slack threads.
```

### Required fields

- **Title** + **Description** as above.
- **Type label** (Feature/Improvement/Bug/Chore/Spike/Decision).
- **Area label** (at least one — DX/AI-Agents/CI-CD/Repo-Strategy/Docs/Platform/Frontend/Backend).
- **Project**, if part of an initiative.
- **Priority** — `No priority` is acceptable for untriaged backlog; everything else should have one.
- **Assignee** — always required. Do not create unassigned tickets; ask for the owner if it is not obvious.

### Tone

- Reference related issues by ID (`VAY-NNN`).
- Reference code by path (`apps/booking-api/app/main.py`), not by your local memory.
- No "we", "I", "you" ambiguity — be explicit about who is doing what when it matters.

## AI agent rules

When an agent (Codex, Claude Code, etc.) is working on a ticket:

- **Status changes the agent makes:**
  - `Backlog` / `Todo` → `In Progress` when implementation begins.
  - Keep the ticket `In Progress` when implementation is complete, validation has run, the branch is pushed, and the PR is opened.
  - `In Progress` → `In Review` only when the agent needs explicit human design/product review before merge — e.g., the change is risky, the acceptance criteria are subjective, or the agent is not confident the work is correct.
- **Status changes the agent does NOT make:**
  - Do not move implementation tickets to `Done`. The human moves them to `Done` after merging and smoke testing.
  - Shipping/merging never auto-transitions any status. Move to `Done` because the merged work has been smoke tested and accepted, not because code landed in `main`.
  - Don't move someone else's ticket through statuses unless you're picking up the work yourself.

If QA later finds an issue with a `Done` ticket, the human reopens it (back to `In Progress`) or opens a follow-up ticket.

- **Comments:**
  - Add a comment when the agent records a decision, investigation result, or non-obvious choice.
  - Do NOT add routine progress comments ("commit made", "tests passing") — those signals live in git history.
  - When canceling or marking duplicate, leave a comment with the reason.
- **Creating issues:** an agent may create issues, but the created issue must follow the quality standards above. Untriaged or sparse "TODO" issues are not acceptable.
- **Editing the description:** agents may update an issue's description to add discovered scope, acceptance criteria, or references. Do not silently rewrite the original intent — append, don't replace.
