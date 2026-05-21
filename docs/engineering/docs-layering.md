# Docs Layering

Where Vayada documentation lives, what belongs where, and who keeps each layer current. Closes the docs portion of VAY-465.

## Three layers

| Layer                                   | Path                                  | Audience                                                       | Use for                                                                                                                                   |
| --------------------------------------- | ------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Root README + AGENTS.md / CLAUDE.md** | `README.md`, `AGENTS.md`, `CLAUDE.md` | Anyone landing in the repo (humans + agents)                   | Architecture overview, app map, getting-started, agent operating guide. The "you're new here, read this" layer.                           |
| **Engineering docs**                    | `docs/engineering/*.md`               | Engineers + agents working inside the repo                     | Decision records, operating models, conventions. Things that have **why** behind them and need durability beyond a single commit message. |
| **User-facing docs (Docusaurus)**       | `docs/docs/**`                        | Vayada team running the platform (and eventually hotel admins) | How to use Vayada features: custom domains, invite codes, design studio, etc. Polished, navigable, public-tone.                           |

Rule of thumb:

- If a future engineer would need to know _why_ a thing is the way it is → `docs/engineering/`.
- If a Vayada operator needs step-by-step instructions to run a feature → `docs/docs/`.
- If it's "you can't onboard without this" → root README.
- If it's only relevant when an AI agent is doing work → `AGENTS.md` (or a `.claude/skills/` skill).

## Why monorepo, not separate docs repo

Docs stay in this monorepo for now. A separate `vayada-docs` repo would only be justified by independent publishing permissions, external contributors, separate versioning, or a distinct release workflow. None of those apply today.

If/when they do, the user-facing Docusaurus site (`docs/`) is the most likely candidate to extract first — engineering docs probably stay with the code they describe.

## Maintenance convention

- **Update in the same commit as the code change.** If your change makes a doc stale, fix the doc in the same commit. The agent rule: "if removing the doc wouldn't confuse a future reader, don't write it" — but if the doc exists and your change makes it wrong, you own fixing it.
- **No "TODO: update docs" comments in code.** Either fix the doc now or open a Linear ticket with a `Docs` label.
- **Engineering docs are decision records, not status pages.** Don't store live state ("currently we are working on X"). Store the decision and the date it was made; let git history show evolution.
- **The Docusaurus site is `onBrokenLinks: 'throw'`.** A doc edit that orphans a link breaks the docs build; the pre-push hook plus per-app CI will catch it.

## Inventory (snapshot)

- **Root**: `README.md` (architecture, getting-started), `AGENTS.md` (canonical agent guide), `CLAUDE.md` (thin Claude wrapper).
- **`docs/engineering/`**:
  - `workspace-package-manager.md` — npm workspaces decision (VAY-456).
  - `monorepo-deploy-workflows.md` — GitHub Actions path filters + OIDC deploy model (VAY-454, VAY-462).
  - `linear-workspace.md` — Linear operating model (VAY-415).
  - `code-quality-gates.md` — Prettier/ESLint/Ruff + hooks operating model (VAY-457, VAY-458).
  - `docs-layering.md` — this file.
- **`docs/docs/`** (Docusaurus):
  - `intro.md` — site landing page.
  - `domains/` — custom domain setup, default subdomain.
  - `onboarding/` — invite codes, setup wizard.
  - `booking-engine/` — billing, design studio, room management.

When you add another engineering decision doc, add it to this inventory. When the inventory gets long enough that it's hard to scan, split by topic.
