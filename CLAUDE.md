# vayada — agent guide

Hospitality platform: a **Creator Marketplace**, a **Booking Engine**, and a **PMS**,
sharing a central auth DB. This repo is a **thin parent of 9 git submodules** — almost
all code lives in submodules; the parent only pins submodule SHAs + holds
`docker-compose.yml`, `infra/` (Terraform), `scripts/` (seeds), and `auth-db/`.

Full architecture, ports, DBs, test accounts, and seeding: see `README.md`. This file
is the operational/agent layer the README doesn't cover.

## Submodule map

| Path | Stack | Port |
|---|---|---|
| `marketplace/vayada-creator-marketplace-backend` | FastAPI | 8000 |
| `marketplace/vayada-creator-marketplace-frontend` | Next.js 14 | 3000 |
| `marketplace/vayada-creator-marketplace-frontend-admin` | Next.js 14 | 3001 |
| `booking-engine/vayada-booking-engine-backend` | FastAPI | 8001 |
| `booking-engine/vayada-booking-engine-frontend` | Next.js 14 | 3002 |
| `booking-engine/vayada-booking-engine-frontend-admin` | Next.js 14 | 3003 |
| `pms/vayada-pms-backend` | FastAPI | 8002 |
| `pms/vayada-pms-frontend` | Next.js 14 | 3004 |
| `affiliate/vayada-affiliate-dashboard` | Next.js 14 | — |

## Per-stack commands (run inside the submodule, not the parent)

**FastAPI backends** (Python 3.11):
```bash
pip install -r requirements.txt          # venv/ already present in checked-out submodules
python -m pytest                         # pytest.ini at submodule root; tests/ dir
uvicorn app.main:app --reload --port <P> # P = port from table above
```

**Next.js frontends**:
```bash
npm install
npm run dev      # bound to its own port
npm run build    # always run before declaring a frontend change done
npm run lint
```

Run the relevant `pytest` / `npm run build` before claiming a change is complete.

## The `vw` worktree workflow (canonical)

`scripts/vw` (on PATH as `vw`) is how ticket work is done. Each ticket gets an isolated
worktree at `~/git/vayada-<TICKET>` on branch `<TICKET>`, off `vayada/main`.

- `vw new <TICKET|num>` — create worktree, init submodules, copy `.env`s, launch Claude.
- `vw ship-all` — for every worktree: commit submodule work on a feature branch, merge
  each submodule's branch into its `main` and push, bump pointers in the parent, push
  `<TICKET>:main`. Auto-resolves submodule-pointer rebase conflicts.
- `vw ship-ready` — `vw done` any worktree already merged into `vayada/main`, then `vw sync`.
- `vw sync` — pull parent, rebase every worktree on `origin/main`, re-init submodules.
- `vw done <TICKET>` — remove worktree + delete local branch (no Linear change).

Inside a `vw new` worktree, work in two phases: **PHASE 1** plan & wait for approval;
**PHASE 2** implement + commit locally only. Do **not** merge/push/PR — `vw ship-all`
does the merge-to-main dance later.

## Shipping conventions (important)

- **Direct to `main`, no PRs.** Applies to small fixes *and* ticket work. Never
  `gh pr create` / `gh pr merge` unless the user explicitly asks.
- Per touched submodule: commit on a feature branch (descriptive message — what & why),
  merge to the submodule's `main`, push to `origin`.
- Parent: `git add` the bumped submodule paths, commit
  `Bump <submodule>: <summary> (<TICKET>)`, then push the tip to the parent's `main`
  remote, which is **`vayada`** (`git push vayada <BRANCH>:main`).

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
