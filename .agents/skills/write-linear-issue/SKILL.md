---
name: write-linear-issue
description: Turn rough user notes, follow-ups, or investigation results into a well-formed Vayada Linear issue (title, structured description, labels, project, priority). Use when the user asks to create a Linear ticket, when work surfaces follow-up that needs tracking, or when restructuring a vague existing ticket. Skip routine progress notes — those belong in git history.
---

# Writing a Vayada Linear issue

Turn rough input ("we should probably refactor the auth middleware") into a ticket someone else can pick up cold.

The full operating model — projects, label semantics, status transitions, priorities, agent rules — lives in `engineering/linear-workspace.md`. This skill is the operational shortcut: how to actually write a ticket. Read the operating-model doc when in doubt; otherwise follow this skill.

## Workflow

1. **Clarify shape before writing.** Decide what kind of work this is before drafting (see "Decision tree" below). A bug, a spike, and a feature look different.
2. **Capture the user's intent verbatim once** — paste their phrasing into the description's `Context` section or your notes. You will paraphrase elsewhere; keep one anchor so intent is preserved.
3. **Draft title + description.** Use the templates below.
4. **Pick labels.** One Type + at least one Area (see operating-model doc § Labels).
5. **Pick project or standalone.** See "Project vs standalone" below.
6. **Set priority.** Default `Medium`. `High` if the user is actively pulling it in. `Urgent` only for production-impacting or date-blocking work.
7. **Confirm with the user before creating.** Show them the draft; ask whether to create as-is.

## Decision tree — what kind of issue is this?

| Input shape                                    | Issue type                                  |
| ---------------------------------------------- | ------------------------------------------- |
| New product capability, user-facing            | `Feature`                                   |
| Enhancement to something that already exists   | `Improvement`                               |
| Behavior diverges from spec or expected        | `Bug`                                       |
| Cleanup, dependency bump, no behavior change   | `Chore`                                     |
| "We should investigate / compare / figure out" | `Spike` (output = recommendation, not code) |
| "We need to decide between X and Y"            | `Decision` (often paired with `Spike`)      |

If unsure between Improvement and Feature, pick the smaller one — `Improvement`.

## Project vs standalone

**Project** if any of:

- You'd expect ≥ 3 related tickets to fall under it.
- It spans more than one or two weeks.
- A stakeholder would ask "how is X going?".

**Standalone issue** otherwise. One self-contained PR/commit = one issue, no project.

Within a project, use **milestones** to group ~5–15 related issues into phases. Skip milestones if the project has only one phase.

## Title

- Imperative verb first: `Add`, `Fix`, `Migrate`, `Refactor`, `Remove`, `Document`, `Investigate`.
- ≤ 70 characters.
- No `VAY-NNN` prefix (Linear adds it).
- No implementation detail — describe the outcome, not the mechanism.
- Bad: "useEffect cleanup in booking calendar"
- Good: "Fix booking calendar leaking subscriptions on unmount"

## Description template

Use Markdown. Omit any section that doesn't apply rather than padding it.

```markdown
## Context

Why this exists. What triggered it. What problem it solves. One short paragraph — assume the reader has not been in the conversation.

## Scope

- What is in scope, as bullets.
- Be concrete about files, services, or behaviors.

## Out of scope (optional)

- Things deliberately excluded, so reviewers don't expect them.

## Acceptance criteria

- Testable statements of "done", as bullets.
- "X happens when Y" or "Z is documented at <path>".

## Notes / References (optional)

- Related issues: VAY-NNN.
- Code paths: apps/<app>/path/to/file.py.
- Links to plans, docs, decisions.
```

For `Spike`/`Decision` issues, swap `Acceptance criteria` for:

```markdown
## Expected output

- A written recommendation covering <bulleted points>.
- Saved to <path or Linear doc>.
```

For `Bug` issues, prepend a `Steps to reproduce` section before `Scope`, and frame `Acceptance criteria` as "the bug no longer occurs when …".

## Required fields

- **Title** + **Description** (above).
- **Type label** (Feature / Improvement / Bug / Chore / Spike / Decision).
- **Area label** — at least one (DX / AI-Agents / CI-CD / Repo-Strategy / Docs / Platform / Frontend / Backend).
- **Project** if it belongs to one.
- **Priority** — `Medium` by default; raise/lower deliberately.
- **Assignee** when picked up (don't pre-assign untouched backlog).

## Preserving rough user intent

Users often describe work in fragmented or aspirational terms. The skill is to make tickets actionable **without inventing scope they didn't ask for.**

- **Quote, then paraphrase.** Put the user's original wording in `Context`. Paraphrase in `Scope`.
- **Don't expand scope to "do it right".** If the user says "fix the typo", do not add "and audit all i18n strings". Open a follow-up ticket instead and link it under `Notes`.
- **Don't drop ambiguity.** If the user is vague about a sub-decision, write the scope item as "Decide X" rather than picking for them.
- **Edit an existing ticket by appending, not rewriting.** When clarifying a vague ticket, add a new section like `## Clarification (<date>)` rather than overwriting the original description.

## Confirm before creating

Show the user the draft (title, description, labels, project, priority). Wait for their go-ahead. Linear issue creation is auto-mode-classifier-sensitive; explicit user approval avoids friction and keeps you from creating tickets the user didn't actually want.

Exception: if the user explicitly said "create a ticket for X", you may proceed without re-confirming the draft, but still show what you created.

## Anti-patterns

- **Routine progress tickets** ("commit pushed", "tests green") — those signals live in git history, not Linear.
- **TODO tickets** with no `Context` / `Acceptance criteria` — every ticket should be readable cold.
- **Mixing types** — one issue = one Type label. Split if it's truly Feature + Bug.
- **Multi-area kitchen sinks** — if an issue legitimately touches Frontend + Backend + Platform, that's a signal it should be a project, not a single ticket.
- **Setting priority by importance instead of activity.** Priority means "how soon", not "how big". A massive but unscheduled refactor is `Medium`, not `High`.
- **Pre-assigning untouched backlog** to encourage someone to pick it up — leave unassigned until work actually starts.
- **Silently rewriting the original ticket description.** Append a clarification section instead.
