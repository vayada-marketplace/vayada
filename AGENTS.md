# vayada — agent guide

Hospitality platform with three products — **Creator Marketplace**, **Booking Engine**, and **PMS** — sharing a central auth DB. This repo is the product application monorepo: app code lives under `apps/`, shared code belongs under `packages/`, and root tooling owns cross-app workflow, docs, Docker Compose, scripts, and auth DB setup.

This file is the **canonical, tool-neutral agent guide**. Claude Code, Codex, and any other agent should read this first. `README.md` covers architecture, ports, DBs, test accounts, and seeding in depth — this file covers what those references don't: how to actually do work in the repo.

`CLAUDE.md` is a thin Claude-specific wrapper that defers to this file; it only adds notes that are specific to Claude Code's runtime.

## App map

| Path                       | Stack      | Port | Local URL                             |
| -------------------------- | ---------- | ---- | ------------------------------------- |
| `apps/marketplace-api`     | FastAPI    | 8000 | `https://api.marketplace.localhost`   |
| `apps/marketplace-web`     | Next.js 14 | 3000 | `https://marketplace.localhost`       |
| `apps/marketplace-admin`   | Next.js 14 | 3001 | `https://admin.marketplace.localhost` |
| `apps/booking-api`         | FastAPI    | 8001 | `https://api.booking.localhost`       |
| `apps/booking-web`         | Next.js 14 | 3002 | `https://booking.localhost`           |
| `apps/booking-admin`       | Next.js 14 | 3003 | `https://admin.booking.localhost`     |
| `apps/pms-api`             | FastAPI    | 8002 | `https://api.pms.localhost`           |
| `apps/pms-web`             | Next.js 14 | 3004 | `https://pms.localhost`               |
| `apps/affiliate-dashboard` | Next.js 14 | 3005 | `https://affiliate.localhost`         |
| `apps/landing`             | Next.js 14 | 3006 | `https://landing.localhost`           |

Local URLs are the recommended way to reach each app — see [Local dev — portless](#local-dev--portless). Plain `localhost:PORT` still works for contributors not on portless.

`apps/landing` is the **public marketing/landing site**, split out of `apps/marketplace-web`. The marketplace frontend is the authenticated app only; its `/` redirects to `/login`. The marketing pages (home, `/booking-engine`, `/pms`, `/hotel-creator-network`, `/partner-program`, `/pricing`, about/contact/benefits, legal) live in `apps/landing`; `/hotel-creator-network` there fetches live creators/hotels from the marketplace API cross-origin. `/choose-product` stays in the marketplace frontend (auth-flow router off `/login`). The public chrome (`Navigation` / `Footer` / `LandingFooter`) is intentionally duplicated in both apps because app pages (`/hotels/[id]`, `/choose-product`, `/creators`, `/properties`) still use it. Deferred to a domain cutover: infra (ECR `vayada-landing` + service + DNS), domain topology, the app-root redirect target, the marketing `Navigation` links (still point at moved routes), and contact/HCN CORS on the marketplace backend.

## Local dev — portless

[portless](https://portless.sh) maps every app to a stable HTTPS URL on `*.localhost` (column 4 of the App map above). No port numbers to remember, no per-worktree port collisions, and frontends reach their backends via the same named URLs whether you're in the main tree or a worktree. **portless is the recommended local-dev workflow.** Plain `localhost:PORT` still works — see [Plain-port fallback](#plain-port-fallback) below.

### One-time setup

```bash
nvm use                                # picks Node 24 from .nvmrc (use fnm/asdf if you prefer)
npm install -g portless                # requires Node 24+
./scripts/portless-setup.sh            # trusts local CA (sudo) + registers the FastAPI aliases
```

`portless trust` adds the local CA to your system trust store so browsers don't show TLS warnings (may prompt for sudo on first run). The proxy then binds **port 443** and requires sudo to do so — accept the prompt when launching an app for the first time. If you skip sudo, portless falls back to **port 1355** and all URLs become `https://<name>.localhost:1355`; functional but loses the "clean URL" payoff. The checked-in frontend defaults assume port 443, so when you are on the 1355 fallback you must override API URLs with the explicit port, e.g. `NEXT_PUBLIC_API_URL=https://api.marketplace.localhost:1355`. To recover, stop the proxy and re-run `portless proxy start` accepting the sudo prompt, or install the proxy as a launch-time service: `portless service install`.

### Running apps

| What                            | Command                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------- |
| Start every Next.js app at once | `portless` from the repo root                                                    |
| Start one Next.js app           | `cd apps/<name> && portless`                                                     |
| Start a FastAPI backend         | `cd apps/<api> && uvicorn app.main:app --reload --port <P>` (P from the App map) |

The Next.js apps register their portless name via a `"portless"` key in `apps/<name>/package.json`. The FastAPI apps run on their existing uvicorn ports (8000 / 8001 / 8002) and are reached at `https://api.<product>.localhost` thanks to the static aliases registered by `scripts/portless-setup.sh`.

The frontend API fallbacks (`process.env.NEXT_PUBLIC_*_URL || …`) default to the portless URLs, so a contributor running portless needs **no `.env.local` to talk to the right APIs**.

### Worktrees

`git worktree add /tmp/vayada-<branch> <branch>` then `cd /tmp/vayada-<branch>/apps/<name> && portless` automatically prefixes the worktree as a subdomain: `https://<branch>.<name>.localhost`. Worktrees on different branches don't collide.

### Multi-tenant subdomains (booking-web)

`booking-web` extracts the hotel slug from the hostname (`<slug>.booking.localhost` → that hotel's booking page). portless does **not** forward arbitrary subdomains of a registered name — verified with curl against the v0.13 proxy: `https://booking.localhost` routes, but `https://acme.booking.localhost` returns a portless 404. Two workarounds:

1. **Per-tenant alias** — `portless alias <slug>.booking 3002` for each hotel slug you want to hit. Confirmed working in the same curl test. Add the slugs you care about to your shell init or amend `scripts/portless-setup.sh` locally.
2. **Plain-port fallback** — `cd apps/booking-web && npm run dev` and reach the tenant at `http://<slug>.localhost:3002` (the pre-portless path; booking-web's middleware reads `Host` regardless of port).

### Plain-port fallback

Without portless, `npm run dev` in each Next.js app binds to its conventional port (3000–3006), and uvicorn binds to 8000/8001/8002 as before. To make the frontends talk to plain-port backends, override the API URLs in `apps/<name>/.env.local` — each `apps/*/.env.example` lists the plain-port URL alongside the portless default.

### Pre-1.0 caveat

portless is pre-1.0 (currently 0.13.x). Upgrades occasionally change the state-dir format; if `portless list` shows nothing or HTTPS suddenly fails, re-run `portless trust` and `./scripts/portless-setup.sh`.

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
npm run dev      # plain-port (3000–3006); use `portless` for HTTPS named URL — see Local dev
npm run build    # always run before declaring a frontend change done
npm run lint
```

Root npm workspace commands:

```bash
npm run dev:booking-web
npm run build:booking-web
npm run lint:booking-web
npm run build       # all workspaces with build scripts
npm run lint        # all workspaces with lint scripts
npm run typecheck   # all workspaces with typecheck scripts
```

The repo uses **npm workspaces** because the imported apps already use npm `package-lock.json` files. Do not introduce pnpm/Yarn or rewrite lockfiles without a dedicated migration issue.

## Validation expectations

Before claiming a change is complete:

- **Backend (FastAPI)** — run `python -m pytest` in the affected app. `ruff check <changed-paths>` for new code.
- **Frontend (Next.js)** — run `npm run build` (and `npm run lint` if the change is non-trivial). The dev server is not enough — Next builds catch type/import errors the dev server misses.
- **Cross-app or workspace changes** — also run root `npm run build` / `npm run typecheck` to confirm no workspace consumer broke.
- **UI changes** — start the dev server and exercise the feature in a browser before declaring it done. Type checks and tests verify code correctness, not feature correctness.

Formatting (Prettier for JS/TS/MD/YAML/CSS, Ruff for Python) is wired up but **not enforced** across the existing codebase yet. Touched files should be clean; pre-existing drift is acceptable. Full operating model: [`engineering/code-quality-gates.md`](engineering/code-quality-gates.md).

If a check cannot be run locally (env, secrets, infra), say so explicitly rather than claiming success.

## Shipping conventions

- **Direct to `main`, no PRs.** Applies to small fixes _and_ ticket work. Never `gh pr create` / `gh pr merge` unless the user explicitly asks.
- Commit with a descriptive message that explains what changed and why.
- Push the working branch for review unless the user explicitly asks to ship to `main`.
- Do not reintroduce app submodules or submodule pointer commits.

## Linear workflow

- Ticket → **In Progress** when implementation starts (via the `linear` MCP).
- Ticket → **Done** when implementation is complete (default close-out — the agent owns the full lifecycle).
- Ticket → **In Review** (optional) only when the agent wants explicit human review before closing — risky change, subjective acceptance criteria, low confidence.
- Shipping/merging does **not** auto-transition any status. Move to `Done` because implementation is finished, not because code landed in `main`.
- If QA later finds an issue, the human reopens the ticket (back to `In Progress`) or opens a follow-up.

Task-specific scope and acceptance criteria live in the Linear issue itself — read it before starting.

Full operating model (projects, labels, statuses, priorities, issue quality, agent rules) is in [`engineering/linear-workspace.md`](engineering/linear-workspace.md). Read that before creating issues or restructuring tickets.

## Deployment

Production runs on AWS ECS Fargate, fronted by an ALB. Each app has a GitHub Actions workflow under `.github/workflows/` that triggers on path changes under its `apps/<name>/` directory, then builds, pushes to ECR, and deploys via OIDC.

- **PMS migrations** auto-run on ECS container start. Do not suggest manually running `scripts/run_migration.sh` after a push to `main`.
- **auth-db** does **not** auto-migrate in production — run `scripts/run_migration.sh auth` against RDS for any schema change. Locally, the `auth-db-migrate` one-shot service in `docker-compose.yml` runs migrations on `docker compose up`.
- Infrastructure is managed with Terraform in the [`vayada-platform`](https://github.com/vayada-marketplace/vayada-platform) repository. This repo contains no infrastructure code.

## Skills

Shared agent skills live under `.claude/skills/<name>/SKILL.md`. The directory is named for Claude Code's convention; the skill content itself is tool-neutral.

Start with `.claude/skills/vayada-skills-storage/SKILL.md` to understand the three-layer model (shared skill / repo-local instructions / Linear issue) and where new skills should go.

## Gotchas

- **SMTP** — port 587 SES uses `start_tls=True`, **not** `use_tls=True`. Recurring regression — check on any email/SMTP change.
- **PMS migrations auto-run** on ECS container start. After a push to `main`, do **not** suggest manually running `scripts/run_migration.sh`.
- **auth-db** does **not** auto-migrate **in production** (unlike PMS). Locally, `docker compose up` runs auth migrations via the `auth-db-migrate` one-shot service. For prod schema changes, run `scripts/run_migration.sh auth` against RDS.
- **`vw` worktree helper is gone.** Ticket work uses normal git branches and direct-to-main commits — no worktree scripts, no shipping helpers.
