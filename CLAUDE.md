# vayada — agent guide

Hospitality platform: a **Creator Marketplace**, a **Booking Engine**, and a **PMS**,
sharing a central auth DB. This repo is the product application monorepo: app code
lives under `apps/`, shared code belongs under `packages/`, and root tooling owns
cross-app workflow, docs, Docker Compose, scripts, and auth DB setup.

Full architecture, ports, DBs, test accounts, and seeding: see `README.md`. This file
is the operational/agent layer the README doesn't cover.

## App map

| Path | Stack | Port |
|---|---|---|
| `apps/marketplace-api` | FastAPI | 8000 |
| `apps/marketplace-web` | Next.js 14 | 3000 |
| `apps/marketplace-admin` | Next.js 14 | 3001 |
| `apps/booking-api` | FastAPI | 8001 |
| `apps/booking-web` | Next.js 14 | 3002 |
| `apps/booking-admin` | Next.js 14 | 3003 |
| `apps/pms-api` | FastAPI | 8002 |
| `apps/pms-web` | Next.js 14 | 3004 |
| `apps/affiliate-dashboard` | Next.js 14 | 3005 |
| `apps/landing` | Next.js 14 | 3006 |

`apps/landing` is the **public marketing/landing site**, split out of
`apps/marketplace-web`. The marketplace frontend is now the
authenticated app only; its `/` redirects to `/login`. The marketing pages
(home, `/booking-engine`, `/pms`, `/hotel-creator-network`, `/partner-program`,
`/pricing`, about/contact/benefits, legal) live in `apps/landing`;
`/hotel-creator-network` there fetches live creators/hotels from the
marketplace API cross-origin. `/choose-product` stays in the marketplace
frontend (auth-flow router off `/login`). The public chrome (`Navigation`/
`Footer`/`LandingFooter`) is intentionally duplicated in both apps because
app pages (`/hotels/[id]`, `/choose-product`, `/creators`, `/properties`)
still use it. Deferred to a domain cutover: infra (ECR `vayada-landing` +
service + DNS), domain topology, the app-root redirect target, the marketing
`Navigation` links (still point at moved routes), and contact/HCN CORS on the
marketplace backend.

## Per-stack commands

**FastAPI backends** (Python 3.11):
```bash
cd apps/<api>
pip install -r requirements.txt
python -m pytest                         # pytest.ini at app root; tests/ dir
uvicorn app.main:app --reload --port <P> # P = port from table above
```

**Next.js frontends**:
```bash
cd apps/<web>
npm install
npm run dev      # bound to its own port
npm run build    # always run before declaring a frontend change done
npm run lint
```

Run the relevant `pytest` / `npm run build` before claiming a change is complete.

## The `vw` worktree workflow (canonical)

`scripts/vw` (on PATH as `vw`) is how ticket work is done. Each ticket gets an isolated
worktree at `~/git/vayada-<TICKET>` on branch `<TICKET>`, off `vayada/main`.

- `vw new <TICKET|num>` — create worktree, copy `.env`s, launch Claude.
- `vw ship-all` — for every worktree: commit monorepo work and push the ticket branch
  according to the current migration workflow.
- `vw ship-ready` — `vw done` any worktree already merged into `vayada/main`, then `vw sync`.
- `vw sync` — pull parent and rebase every worktree on `origin/main`.
- `vw done <TICKET>` — remove worktree + delete local branch (no Linear change).

Inside a `vw new` worktree, work in two phases: **PHASE 1** plan & wait for approval;
**PHASE 2** implement + commit locally only. Do **not** merge/push/PR — `vw ship-all`
does the merge-to-main dance later.

## Shipping conventions (important)

- **Direct to `main`, no PRs.** Applies to small fixes *and* ticket work. Never
  `gh pr create` / `gh pr merge` unless the user explicitly asks.
- Commit app and package changes directly in this monorepo branch with a descriptive
  message that explains what changed and why.
- Do not reintroduce app submodules or submodule pointer commits.
- Push the monorepo branch for review unless the user explicitly asks to ship to `main`.

## Linear state rules

- Ticket → **In Progress** only in PHASE 1 (via the `linear` MCP).
- Shipping does **not** touch Linear. `vw done` does **not** touch Linear.
- The user moves **In Progress → In Review** manually after their own QA. `vw done`
  leaves the ticket in *In Review*, not *Done*.

## Gotchas

- **SMTP**: port 587 SES uses `start_tls=True`, **not** `use_tls=True`. Recurring
  regression — check this on any email/SMTP change.
- **PMS migrations auto-run** on ECS container start. After a push to main, do **not**
  suggest manually running `scripts/run_migration.sh`.
- **Deferred tools**: many MCP/tools are deferred. Before claiming a tool is missing,
  check the deferred-tools system-reminder and load it via `ToolSearch`.
- `auth-db` does **not** auto-migrate (unlike PMS). See `README.md` getting-started.
