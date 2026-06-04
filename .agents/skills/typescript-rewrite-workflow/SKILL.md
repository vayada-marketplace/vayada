---
name: typescript-rewrite-workflow
description: Use when planning or implementing the Vayada TypeScript backend rewrite, WorkOS integration, Ask Intelligence backend work, target schema work, or rewrite-related Linear tickets and PRs.
---

# TypeScript rewrite workflow

Use this workflow for the TypeScript backend rewrite and adjacent WorkOS, Ask
Intelligence, bookability, target-schema, migration, and cutover work.

The rewrite is an architecture-led program. Do not treat it as a route-by-route
FastAPI port or a broad implementation epic.

## Non-negotiables

- Architecture comes first: every implementation PR must link to the relevant
  design artifact, Linear decision ticket, or target contract.
- Stacked PRs are the default: one narrow dependency step per PR.
- Keep PRs small: target 400 changed non-generated lines or fewer. If a change
  wants to exceed that, split it before opening the PR.
- Keep scopes single-purpose: design docs, scaffold, contracts, adapters,
  implementation, migrations, and validation harness changes should not be
  bundled unless the ticket explicitly requires it.
- Preserve production behavior until a reviewed cutover plan says otherwise.
  Python services remain source-of-truth for production traffic before cutover.
- New TypeScript code targets the agreed domain model and target-schema
  contracts, not the legacy product database boundaries.

## Before coding

1. Read the Linear ticket and linked decisions.
2. Read the relevant architecture docs:
   - `engineering/typescript-backend-structure.md`
   - `engineering/backend-database-restructure.md`
   - `engineering/workos-identity-architecture.md`
   - `engineering/ask-intelligence-architecture.md`
3. Confirm the ticket has testable acceptance criteria.
4. Identify the stack position:
   - design or contract
   - package/app scaffold
   - domain implementation
   - compatibility adapter
   - migration/parity harness
   - cutover/runbook
5. If the design is missing or ambiguous, create or update the design/contract
   first. Do not hide architecture decisions inside implementation code.

## PR slicing

Prefer this stack order:

1. Decision or contract doc.
2. Minimal scaffold with build/test wiring.
3. Shared type or interface package.
4. One domain service or adapter.
5. One compatibility route group.
6. Focused tests or parity fixtures.
7. Follow-up cleanup after behavior is covered.

Each PR should answer one review question. Examples:

- "Does the RequestContext contract model the authorization shape?"
- "Does `apps/api` boot and expose health/readiness?"
- "Does this quote fixture match current booking behavior?"
- "Does this adapter preserve the old frontend response shape?"

Avoid PRs that require reviewers to approve architecture, data modeling,
framework choice, route behavior, migration logic, and frontend compatibility at
the same time.

## Size rule

The 400-line limit is a reviewability budget, not a formatting game.

- Count meaningful source, config, test, and doc changes.
- Exclude lockfiles only when dependency changes are the point of the PR and the
  human-visible source diff remains small.
- Exclude generated snapshots or fixtures only if the PR explains how they were
  generated and what source contract they validate.
- If a PR crosses the limit because of mechanical boilerplate, split scaffold,
  tests, and implementation into separate stacked PRs.

## Review checklist

Before opening a rewrite PR, verify:

- The PR links the relevant Linear issue and architecture/design artifact.
- The PR states its stack predecessor and successor when applicable.
- The diff is around 400 changed non-generated lines or less.
- The code does not introduce raw cross-product DB access as a normal domain
  integration.
- Authorization flows through a typed request context or an explicit temporary
  compatibility boundary.
- Side effects have idempotency, retry, and audit visibility when they are in
  scope.
- Validation is appropriate for the layer changed: build/typecheck, unit tests,
  contract fixtures, migration parity checks, or browser smoke.

## References

- `AGENTS.md` — repo commands, validation expectations, and shipping rules.
- `.agents/skills/work-on-linear-ticket/SKILL.md` — ticket-to-PR workflow.
- `.agents/skills/write-linear-issue/SKILL.md` — creating follow-up tickets.
