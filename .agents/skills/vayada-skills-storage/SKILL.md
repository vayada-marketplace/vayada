---
name: vayada-skills-storage
description: Decide where a Vayada agent skill should live and what belongs in a shared skill versus repo-local instructions versus a Linear issue. Use when creating or moving a Vayada agent skill, or when deciding which layer a new piece of agent guidance belongs in.
---

# Vayada agent skills — storage & layering

Where Vayada agent skills live and what belongs in one.

This is the bootstrap skill: it encodes the decision made in VAY-442 (repository strategy) and VAY-448 (agent instructions & shared skills layout). Read it before writing or moving any other Vayada skill.

## Three layers

Agent guidance for Vayada is split across three layers. Pick the right layer **before** writing anything.

| Layer                       | Lives in                                                                  | Use for                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shared skill**            | `.agents/skills/<name>/SKILL.md` in this monorepo                         | Durable workflows that apply across the codebase and across agent tools: writing Linear issues, deployment workflow, validation workflow, coding conventions, Vayada product context. |
| **Repo-local instructions** | Root `AGENTS.md` (tool-neutral) + root `CLAUDE.md` (thin Claude wrapper). | Exact commands, app paths, layout, local setup, workflow scripts, gotchas, shipping rules.                                                                                            |
| **Linear issue context**    | The Linear ticket itself                                                  | Task-specific scope, acceptance criteria, decisions made during the ticket.                                                                                                           |

Decision rule:

- If the guidance would still be true if Vayada had a different codebase → **shared skill**.
- If it changes when the repo layout, commands, or apps change → **repo-local**.
- If it is only true for one ticket → **Linear**.

When in doubt, default to repo-local. Promoting to a shared skill later is cheap; deprecating a stale shared skill is not.

## Where skills live

Inside this monorepo:

```
.agents/skills/
  <skill-name>/
    SKILL.md           # required — frontmatter + body
    assets/            # optional — examples, templates, fixtures
```

- `.agents/skills/` is the single shared skill directory for this repo. Codex, Claude Code, and any other agent should read from this path.
- `.codex/` and `.claude/` stay per-developer and are ignored; do not store shared skills there.
- The directory is named `.agents/skills/` to keep the shared content tool-neutral. If an agent needs explicit configuration to load project skills, point it at this path — do not create a second copy.

There is no separate `vayada-agent-skills` repo. Vayada is one repo; skills live with the code they support. If a second Vayada repo ever needs the same skills, extract `.agents/skills/` to a dedicated repo at that point.

## Writing a new skill

1. **Pick the layer.** If it is repo-specific, do not write a skill — update `AGENTS.md` / `CLAUDE.md` instead.
2. **Name it.** `kebab-case`, short, action-oriented (`write-linear-issue`, `validate-frontend-change`). Avoid Vayada-internal jargon and ticket numbers in the slug.
3. **One skill per concern.** A skill answers one question or runs one workflow. If it grows past ~200 lines or sprouts sections that could trigger independently, split it.
4. **Frontmatter:**
   ```yaml
   ---
   name: <slug>
   description: <one sentence — the trigger and the outcome>
   ---
   ```
   `description` is what the agent matches against to decide whether to load the skill. Describe **when to use it**, not **what it is**.
5. **Body.** Lead with the rule or workflow. Tables, examples, anti-patterns below. Do not restate `AGENTS.md`.
6. **One skill, all tools.** Skills are tool-neutral. Do not fork a skill into per-tool variants. If a workflow truly cannot be expressed in a tool-neutral way, it belongs in `AGENTS.md` / `CLAUDE.md`, not in a skill.

## Anti-patterns

- Duplicating a workflow in `AGENTS.md` and a skill — pick one layer.
- Writing a skill whose content is repo-layout-specific (commands, paths, app names) — that is `AGENTS.md` material, even though both live in this monorepo today.
- Encoding ticket-specific context — it belongs in the Linear issue.
- Embedding deprecated tooling (e.g. former `vw`-style worktree commands) in a skill — skills are forward-looking; deprecated flows go away with the code.
- Per-tool skill variants (a "Codex version" and a "Claude version" of the same workflow) — skills are tool-neutral; all tools read from the same directory.
- Copying skill files into a second directory or into other repos — there is one shared skills directory.

## References

- VAY-442 — Repository strategy decision (monorepo).
- VAY-448 — Agent instructions and shared skills layout (three-layer model). The original "separate `vayada-agent-skills` repo" recommendation was dropped: Vayada is one repo, skills live with the code at `.agents/skills/`.
- VAY-459 — Implementation issue for root `AGENTS.md` + slim `CLAUDE.md` (still backlog).
- VAY-416 — First concrete shared skill to be written: writing Linear issues.
