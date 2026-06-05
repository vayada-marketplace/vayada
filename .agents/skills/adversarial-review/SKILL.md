---
name: adversarial-review
description: Use after implementing and verifying a Vayada ticket, before opening a PR, to review the diff adversarially against acceptance criteria and product risk.
---

# Adversarial review

Run this after implementation and automated verification, before opening a PR.

The goal is to find real defects, regressions, missed acceptance criteria, risky assumptions, and missing validation. This is not a style pass.

## When to run

Run for every Linear ticket implementation before PR creation.

For shared packages, cross-domain architecture, auth, tenant boundaries, booking,
payment, availability, or PMS workflows: explicitly use an independent subagent
adversarial review before opening or finalizing the PR. Do not count a local
self-review as satisfying this requirement.

This requirement applies to:

- backend logic
- auth, tenant boundaries, permissions, or user data
- migrations or schema changes
- booking, payment, availability, or PMS workflows
- shared package changes
- cross-domain architecture changes
- cross-app changes
- non-trivial frontend state or API integration

For changes outside those categories, such as tiny copy or visual-only changes,
a local second-pass review is acceptable.

## Inputs

Collect:

- Linear issue description and acceptance criteria
- `git diff --stat`
- full implementation diff
- changed files list
- validation commands run and results
- any skipped checks or local limitations

When delegating to a subagent, provide only those inputs. Do not pass the implementation author's conclusions, suspected bugs, or preferred fixes unless the review specifically depends on them.

## Checklist

Check:

- Does the implementation satisfy every acceptance criterion?
- Did it add behavior outside the ticket scope?
- Are auth, tenant, role, and ownership checks preserved?
- Are loading, empty, error, and disabled states handled?
- Are API contracts, migrations, seed data, and backwards compatibility safe?
- Are tests or validation proportional to the risk?
- Could this break another Vayada app or shared package consumer?
- Is there a simpler failure mode hidden by happy-path testing?

## Output

Report findings first, ordered by severity.

Each finding must include:

- severity
- file and line when possible
- concrete failure mode
- why it matters
- suggested fix

If no issues are found, say that clearly and list residual risk or test gaps.

Fix valid findings, rerun the relevant checks, and include the review outcome in the PR notes.
