# Local Development

This document covers everything a developer needs to run Vayada locally. All of this is app-repository owned — you do not need to touch `vayada-platform` for local work.

## Quick start

```bash
cp .env.example .env          # fill in any missing values (see below)
docker compose up             # starts all services + DBs
```

On first run, `docker compose up` also runs `auth-db-migrate` — a one-shot service that seeds the auth schema. No manual migration step needed locally.

## What Docker Compose starts

| Service               | Port | Notes                     |
| --------------------- | ---- | ------------------------- |
| `marketplace-api`     | 8000 | FastAPI                   |
| `marketplace-web`     | 3000 | Next.js                   |
| `vayada-admin`        | 3001 | Next.js                   |
| `booking-api`         | 8001 | FastAPI                   |
| `booking-web`         | 3002 | Next.js                   |
| `booking-admin`       | 3003 | Next.js                   |
| `pms-api`             | 8002 | FastAPI                   |
| `pms-web`             | 3004 | Next.js                   |
| `affiliate-dashboard` | 3005 | Next.js                   |
| `landing`             | 3006 | Next.js                   |
| `auth-db`             | 5432 | Postgres — shared auth    |
| `marketplace-db`      | 5433 | Postgres — marketplace    |
| `booking-db`          | 5434 | Postgres — booking engine |
| `pms-db`              | 5435 | Postgres — PMS            |

## Environment variables

Copy `.env.example` to `.env`. The example contains safe placeholder values for local development. Do not embed production secret values in the repo.

The app repository documents which environment variables each service requires. Production values and SSM references live in `vayada-platform`.

| Variable category     | Local source                | Production source                     |
| --------------------- | --------------------------- | ------------------------------------- |
| DB connection strings | `.env` (localhost Postgres) | AWS SSM `/vayada/prod/db-*`           |
| JWT secret            | `.env` (any local string)   | AWS SSM `/vayada/prod/jwt-secret-key` |
| Stripe keys           | `.env` (Stripe test keys)   | AWS SSM via `vayada-platform`         |
| SMTP                  | `.env` (mailhog or skip)    | AWS SSM `/vayada/prod/smtp-*`         |
| Third-party APIs      | `.env` (dev keys or skip)   | AWS SSM via `vayada-platform`         |

## Running a single service without Docker Compose

**FastAPI backend:**

```bash
cd apps/<api>
pip install -r requirements.txt
uvicorn app.main:app --reload --port <port>
```

**Next.js frontend:**

```bash
cd apps/<web>
npm install
npm run dev
```

## Database migrations

**PMS** — migrations run automatically on container start (both locally and in production). Do not run manually after a push.

**Auth DB** — does not auto-migrate in production. Locally, `docker compose up` runs migrations via the `auth-db-migrate` one-shot service. For production schema changes, run:

```bash
./scripts/run_migration.sh auth
```

This script temporarily opens the RDS security group to your IP, runs the migration, then revokes the rule.

## Seed scripts

Populate local databases with mock data:

```bash
npm run seed:test-data         # users → marketplace → booking (recommended)
python scripts/seed_all.py     # direct Python runner
python scripts/seed_users.py   # auth DB only
python scripts/seed_marketplace.py
python scripts/seed_booking.py
```

Default credentials after seeding:

- Admin: `admin@vayada.com` / `Vayada123`
- Hotels: `hotel[1-5]@mock.com` / `Test1234`
- Creators: `creator[1-4]@mock.com` / `Test1234`

## Validation before shipping

See [AGENTS.md](../AGENTS.md) for per-stack validation expectations (pytest, `npm run build`, etc.). The dev server is not sufficient for frontend changes — always run `npm run build` before declaring a frontend change done.

## What this repo does not own

- Cloud infrastructure — all Terraform lives in [`vayada-platform`](https://github.com/vayada-marketplace/vayada-platform)
- Production secret values — stored in AWS SSM, managed by `vayada-platform`
- ECS task definition updates — managed by platform CI on deploy
